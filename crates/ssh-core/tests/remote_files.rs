use std::{collections::HashMap, sync::Arc};

use async_trait::async_trait;
use opspilot_domain::{CoreError, CoreErrorCode, Id};
use opspilot_ssh_core::{
    ConnectionHandle, MAX_EDITABLE_FILE_BYTES, MAX_FILE_DOWNLOAD_BYTES, RemoteDirectoryPath,
    RemoteFileKind, RemoteFileService, RemotePath, ScopedDirectoryEntry, ScopedMetadata,
    ScopedSftp, SftpConnector,
};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

#[derive(Clone)]
struct FakeNode {
    kind: RemoteFileKind,
    bytes: Vec<u8>,
    permissions: Option<u32>,
    modified_at: Option<u64>,
}

impl FakeNode {
    fn directory() -> Self {
        Self {
            kind: RemoteFileKind::Directory,
            bytes: Vec::new(),
            permissions: Some(0o755),
            modified_at: Some(10),
        }
    }

    fn file(bytes: impl Into<Vec<u8>>) -> Self {
        Self {
            kind: RemoteFileKind::File,
            bytes: bytes.into(),
            permissions: Some(0o644),
            modified_at: Some(42),
        }
    }

    fn symlink() -> Self {
        Self {
            kind: RemoteFileKind::Symlink,
            bytes: Vec::new(),
            permissions: Some(0o777),
            modified_at: Some(43),
        }
    }

    fn metadata(&self) -> ScopedMetadata {
        ScopedMetadata {
            kind: self.kind,
            size: self.bytes.len() as u64,
            modified_at: self.modified_at,
            permissions: self.permissions,
        }
    }
}

#[derive(Default)]
struct FakeState {
    nodes: HashMap<String, FakeNode>,
    opens: usize,
    closes: usize,
    fail_close: bool,
}

#[derive(Clone, Default)]
struct FakeConnector {
    state: Arc<Mutex<FakeState>>,
}

impl FakeConnector {
    async fn with_nodes(nodes: impl IntoIterator<Item = (&'static str, FakeNode)>) -> Self {
        let connector = Self::default();
        connector.state.lock().await.nodes = nodes
            .into_iter()
            .map(|(path, node)| (path.to_owned(), node))
            .collect();
        connector
    }

    async fn fail_close(self) -> Self {
        self.state.lock().await.fail_close = true;
        self
    }

    async fn node(&self, path: &str) -> Option<FakeNode> {
        self.state.lock().await.nodes.get(path).cloned()
    }

    async fn paths(&self) -> Vec<String> {
        let mut paths = self
            .state
            .lock()
            .await
            .nodes
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        paths.sort();
        paths
    }

    async fn closes(&self) -> usize {
        self.state.lock().await.closes
    }
}

#[async_trait]
impl SftpConnector for FakeConnector {
    async fn open_scoped(
        &self,
        _connection: &ConnectionHandle,
    ) -> Result<Box<dyn ScopedSftp>, CoreError> {
        self.state.lock().await.opens += 1;
        Ok(Box::new(FakeSession {
            state: self.state.clone(),
        }))
    }
}

struct FakeSession {
    state: Arc<Mutex<FakeState>>,
}

fn parent(path: &str) -> Option<&str> {
    if path == "/" {
        return None;
    }
    let (parent, _) = path.rsplit_once('/')?;
    Some(if parent.is_empty() { "/" } else { parent })
}

fn entry_name(path: &str) -> &str {
    path.rsplit_once('/').map(|(_, name)| name).unwrap_or("")
}

#[async_trait]
impl ScopedSftp for FakeSession {
    async fn list_dir(&self, path: &str) -> Result<Vec<ScopedDirectoryEntry>, CoreError> {
        let state = self.state.lock().await;
        if !state.nodes.contains_key(path) {
            return Err(not_found());
        }
        Ok(state
            .nodes
            .iter()
            .filter(|(candidate, _)| parent(candidate) == Some(path))
            .map(|(candidate, node)| ScopedDirectoryEntry {
                name: entry_name(candidate).to_owned(),
                metadata: node.metadata(),
            })
            .collect())
    }

    async fn symlink_metadata(&self, path: &str) -> Result<Option<ScopedMetadata>, CoreError> {
        Ok(self
            .state
            .lock()
            .await
            .nodes
            .get(path)
            .map(FakeNode::metadata))
    }

    async fn read_file(&self, path: &str, max_bytes: u64) -> Result<Vec<u8>, CoreError> {
        let bytes = self
            .state
            .lock()
            .await
            .nodes
            .get(path)
            .map(|node| node.bytes.clone())
            .ok_or_else(not_found)?;
        if bytes.len() as u64 > max_bytes {
            return Ok(bytes);
        }
        Ok(bytes)
    }

    async fn create_new_file(
        &self,
        path: &str,
        bytes: &[u8],
        permissions: Option<u32>,
    ) -> Result<(), CoreError> {
        let mut state = self.state.lock().await;
        if state.nodes.contains_key(path) {
            return Err(CoreError::new(
                CoreErrorCode::Conflict,
                "target exists",
                false,
            ));
        }
        state.nodes.insert(
            path.to_owned(),
            FakeNode {
                kind: RemoteFileKind::File,
                bytes: bytes.to_vec(),
                permissions,
                modified_at: Some(99),
            },
        );
        Ok(())
    }

    async fn rename(&self, source: &str, destination: &str) -> Result<(), CoreError> {
        let mut state = self.state.lock().await;
        let node = state.nodes.remove(source).ok_or_else(not_found)?;
        state.nodes.insert(destination.to_owned(), node);
        Ok(())
    }

    async fn remove_file(&self, path: &str) -> Result<(), CoreError> {
        if self.state.lock().await.nodes.remove(path).is_some() {
            Ok(())
        } else {
            Err(not_found())
        }
    }

    async fn close(&self) -> Result<(), CoreError> {
        let mut state = self.state.lock().await;
        state.closes += 1;
        if state.fail_close {
            Err(CoreError::new(
                CoreErrorCode::SshConnection,
                "close failed",
                true,
            ))
        } else {
            Ok(())
        }
    }
}

fn not_found() -> CoreError {
    CoreError::new(CoreErrorCode::NotFound, "remote path does not exist", false)
}

fn connection() -> ConnectionHandle {
    ConnectionHandle::new(Id::new(), Id::new())
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[tokio::test]
async fn lists_root_with_directories_first_and_closes_the_session() {
    let connector = FakeConnector::with_nodes([
        ("/", FakeNode::directory()),
        ("/etc", FakeNode::directory()),
        ("/home", FakeNode::directory()),
        ("/etc/nginx.conf", FakeNode::file("worker_processes 1;\n")),
        ("/z.txt", FakeNode::file("z")),
        ("/link", FakeNode::symlink()),
    ])
    .await;
    let service = RemoteFileService::new(Arc::new(connector.clone()));

    let entries = service
        .list(&connection(), &RemoteDirectoryPath::root())
        .await
        .unwrap();

    assert_eq!(
        entries
            .iter()
            .map(|entry| (entry.name.as_str(), entry.kind))
            .collect::<Vec<_>>(),
        vec![
            ("etc", RemoteFileKind::Directory),
            ("home", RemoteFileKind::Directory),
            ("link", RemoteFileKind::Symlink),
            ("z.txt", RemoteFileKind::File),
        ]
    );
    assert_eq!(entries[0].path, "/etc");
    assert_eq!(entries[0].permissions, Some(0o755));
    assert_eq!(entries[0].modified_at, Some(10));
    assert_eq!(connector.closes().await, 1);
}

#[tokio::test]
async fn rejects_unsafe_directory_entry_names_and_still_closes_the_session() {
    let connector =
        FakeConnector::with_nodes([("/", FakeNode::directory()), ("/..", FakeNode::file("bad"))])
            .await;
    let service = RemoteFileService::new(Arc::new(connector.clone()));

    let error = service
        .list(&connection(), &RemoteDirectoryPath::root())
        .await
        .expect_err("entry traversal must fail closed");
    assert_eq!(error.code(), CoreErrorCode::Validation);
    assert_eq!(connector.closes().await, 1);
}

#[tokio::test]
async fn reads_only_bounded_utf8_regular_files_without_nul() {
    let connector = FakeConnector::with_nodes([
        ("/", FakeNode::directory()),
        ("/hello.txt", FakeNode::file("hello\n")),
        ("/nul.txt", FakeNode::file(b"hello\0world".to_vec())),
        ("/binary.bin", FakeNode::file(vec![0xff, 0xfe])),
        (
            "/large.txt",
            FakeNode::file(vec![b'a'; MAX_EDITABLE_FILE_BYTES as usize + 1]),
        ),
        ("/folder", FakeNode::directory()),
        ("/link", FakeNode::symlink()),
    ])
    .await;
    let service = RemoteFileService::new(Arc::new(connector.clone()));
    let text = service
        .read(&connection(), &RemotePath::try_new("/hello.txt").unwrap())
        .await
        .unwrap();
    assert_eq!(text.text, "hello\n");
    assert_eq!(text.size, 6);
    assert_eq!(
        text.sha256,
        "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03"
    );
    assert_eq!(text.modified_at, Some(42));
    assert_eq!(connector.closes().await, 1);

    for path in ["/nul.txt", "/binary.bin", "/large.txt", "/folder", "/link"] {
        let error = service
            .read(&connection(), &RemotePath::try_new(path).unwrap())
            .await
            .expect_err("unsupported editor payload must fail closed");
        assert_eq!(error.code(), CoreErrorCode::Validation, "path: {path}");
    }
    assert_eq!(connector.closes().await, 6);
}

#[tokio::test]
async fn write_requires_the_expected_hash_and_preserves_original_permissions() {
    let old = "old\n";
    let connector = FakeConnector::with_nodes([
        ("/", FakeNode::directory()),
        ("/etc", FakeNode::directory()),
        (
            "/etc/app.conf",
            FakeNode {
                permissions: Some(0o640),
                ..FakeNode::file(old)
            },
        ),
    ])
    .await;
    let service = RemoteFileService::new(Arc::new(connector.clone()));
    let path = RemotePath::try_new("/etc/app.conf").unwrap();

    let conflict = service
        .write(
            &connection(),
            &path,
            "new\n".to_owned(),
            &sha256(b"someone else"),
        )
        .await
        .expect_err("stale hash must conflict");
    assert_eq!(conflict.code(), CoreErrorCode::Conflict);
    assert_eq!(
        connector.node("/etc/app.conf").await.unwrap().bytes,
        old.as_bytes()
    );

    let result = service
        .write(
            &connection(),
            &path,
            "new\n".to_owned(),
            &sha256(old.as_bytes()),
        )
        .await
        .unwrap();
    assert_eq!(result.sha256, sha256(b"new\n"));
    assert_eq!(result.size, 4);
    assert!(result.warning.is_none());
    let written = connector.node("/etc/app.conf").await.unwrap();
    assert_eq!(written.bytes, b"new\n");
    assert_eq!(written.permissions, Some(0o640));
    assert_eq!(
        connector.paths().await,
        vec!["/", "/etc", "/etc/app.conf"],
        "temporary edit file must be removed before success"
    );
    assert_eq!(connector.closes().await, 2);
}

#[tokio::test]
async fn write_rejects_symlinks_invalid_limits_and_missing_expected_hash() {
    let connector = FakeConnector::with_nodes([
        ("/", FakeNode::directory()),
        ("/text.txt", FakeNode::file("text")),
        ("/link.txt", FakeNode::symlink()),
    ])
    .await;
    let service = RemoteFileService::new(Arc::new(connector.clone()));

    for (path, content, expected) in [
        ("/link.txt", "next", sha256(b"link")),
        ("/text.txt", "bad\0text", sha256(b"text")),
        ("/text.txt", "valid", "not-a-hash".to_owned()),
        (
            "/text.txt",
            &"a".repeat(4 * 1024 * 1024 + 1),
            sha256(b"text"),
        ),
    ] {
        let error = service
            .write(
                &connection(),
                &RemotePath::try_new(path).unwrap(),
                content.to_owned(),
                &expected,
            )
            .await
            .expect_err("invalid write must fail closed");
        assert_eq!(error.code(), CoreErrorCode::Validation, "path: {path}");
    }

    let missing = service
        .write(
            &connection(),
            &RemotePath::try_new("/missing.txt").unwrap(),
            "next".to_owned(),
            &sha256(b"text"),
        )
        .await
        .expect_err("missing edit target must conflict");
    assert_eq!(missing.code(), CoreErrorCode::Conflict);
    assert_eq!(
        connector.closes().await,
        2,
        "local validation should reject before opening; symlink and missing-target checks open"
    );
}

#[tokio::test]
async fn committed_write_reports_close_failure_as_a_warning_not_a_false_failure() {
    let connector = FakeConnector::with_nodes([
        ("/", FakeNode::directory()),
        ("/text.txt", FakeNode::file("before")),
    ])
    .await
    .fail_close()
    .await;
    let service = RemoteFileService::new(Arc::new(connector.clone()));

    let result = service
        .write(
            &connection(),
            &RemotePath::try_new("/text.txt").unwrap(),
            "after".to_owned(),
            &sha256(b"before"),
        )
        .await
        .unwrap();
    assert!(
        result
            .warning
            .as_deref()
            .is_some_and(|warning| warning.contains("已保存"))
    );
    assert_eq!(connector.node("/text.txt").await.unwrap().bytes, b"after");
}

#[tokio::test]
async fn download_accepts_regular_files_and_rejects_oversized_or_symlink_targets() {
    let connector = FakeConnector::with_nodes([
        ("/", FakeNode::directory()),
        ("/archive.tar", FakeNode::file("archive")),
        ("/link", FakeNode::symlink()),
        (
            "/large.bin",
            FakeNode::file(vec![b'x'; MAX_FILE_DOWNLOAD_BYTES as usize + 1]),
        ),
    ])
    .await;
    let service = RemoteFileService::new(Arc::new(connector.clone()));
    let result = service
        .download(&connection(), &RemotePath::try_new("/archive.tar").unwrap())
        .await
        .unwrap();
    assert_eq!(result.bytes, b"archive");
    assert_eq!(result.sha256, sha256(b"archive"));

    for path in ["/link", "/large.bin"] {
        let error = service
            .download(&connection(), &RemotePath::try_new(path).unwrap())
            .await
            .expect_err("unsafe download must fail closed");
        assert_eq!(error.code(), CoreErrorCode::Validation, "path: {path}");
    }
    assert_eq!(connector.closes().await, 3);
}

#[tokio::test]
async fn read_close_failure_is_reported_instead_of_returning_stale_success() {
    let connector = FakeConnector::with_nodes([
        ("/", FakeNode::directory()),
        ("/text.txt", FakeNode::file("text")),
    ])
    .await
    .fail_close()
    .await;
    let service = RemoteFileService::new(Arc::new(connector.clone()));

    let error = service
        .read(&connection(), &RemotePath::try_new("/text.txt").unwrap())
        .await
        .expect_err("read must not hide session cleanup failure");
    assert_eq!(error.code(), CoreErrorCode::SshConnection);
}
