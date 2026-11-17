use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use async_trait::async_trait;
use opspilot_domain::{CoreError, CoreErrorCode, Id};
use opspilot_ssh_core::{
    ConnectionHandle, CreateFileFailure, MAX_EDITABLE_FILE_BYTES, MAX_FILE_DOWNLOAD_BYTES,
    RemoteDirectoryPath, RemoteFileKind, RemoteFileMutationResult, RemoteFileService, RemotePath,
    RemoteRenameResult, RemoteUploadFile, RemoteUploadOutcome, RenameStatus, ScopedDirectoryEntry,
    ScopedMetadata, ScopedSftp, SftpConnector, UploadBatchStatus,
};
use serde_json::json;
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
    hardlink_unsupported: bool,
    hardlink_fail_at: Option<usize>,
    hardlink_ambiguous_at: Option<usize>,
    hardlink_attempts: usize,
    fail_remove_paths: HashSet<String>,
    remove_not_found_paths: HashSet<String>,
    fail_remove_contains: Option<String>,
    fail_rename: bool,
    chmod_after_read: Option<(String, Option<u32>)>,
    create_attempts: usize,
    create_fail_at: Option<usize>,
    create_conflict_at: Option<usize>,
    create_cleanup_failed: bool,
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

    async fn hardlink_unsupported(self) -> Self {
        self.state.lock().await.hardlink_unsupported = true;
        self
    }

    async fn fail_hardlink_at(&self, attempt: usize) {
        self.state.lock().await.hardlink_fail_at = Some(attempt);
    }

    async fn fail_hardlink_after_create_at(&self, attempt: usize) {
        self.state.lock().await.hardlink_ambiguous_at = Some(attempt);
    }

    async fn fail_remove(&self, path: &str) {
        self.state
            .lock()
            .await
            .fail_remove_paths
            .insert(path.to_owned());
    }

    async fn remove_before_returning_not_found(&self, path: &str) {
        self.state
            .lock()
            .await
            .remove_not_found_paths
            .insert(path.to_owned());
    }

    async fn fail_remove_containing(&self, fragment: &str) {
        self.state.lock().await.fail_remove_contains = Some(fragment.to_owned());
    }

    async fn fail_rename(&self) {
        self.state.lock().await.fail_rename = true;
    }

    async fn fail_create_at(&self, attempt: usize, cleanup_failed: bool) {
        let mut state = self.state.lock().await;
        state.create_fail_at = Some(attempt);
        state.create_cleanup_failed = cleanup_failed;
    }

    async fn fail_create_conflict_at(&self, attempt: usize) {
        self.state.lock().await.create_conflict_at = Some(attempt);
    }

    async fn chmod_after_read(&self, path: &str, permissions: Option<u32>) {
        self.state.lock().await.chmod_after_read = Some((path.to_owned(), permissions));
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

    async fn create_attempts(&self) -> usize {
        self.state.lock().await.create_attempts
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
    async fn list_dir(
        &self,
        path: &RemoteDirectoryPath,
    ) -> Result<Vec<ScopedDirectoryEntry>, CoreError> {
        let path = path.as_str();
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

    async fn directory_metadata(
        &self,
        path: &RemoteDirectoryPath,
    ) -> Result<Option<ScopedMetadata>, CoreError> {
        Ok(self
            .state
            .lock()
            .await
            .nodes
            .get(path.as_str())
            .map(FakeNode::metadata))
    }

    async fn symlink_metadata(
        &self,
        path: &RemotePath,
    ) -> Result<Option<ScopedMetadata>, CoreError> {
        let path = path.as_str();
        Ok(self
            .state
            .lock()
            .await
            .nodes
            .get(path)
            .map(FakeNode::metadata))
    }

    async fn read_file(&self, path: &RemotePath, max_bytes: u64) -> Result<Vec<u8>, CoreError> {
        let path = path.as_str();
        let mut state = self.state.lock().await;
        let bytes = state
            .nodes
            .get(path)
            .map(|node| node.bytes.clone())
            .ok_or_else(not_found)?;
        if let Some((target, permissions)) = state.chmod_after_read.take() {
            if target == path {
                if let Some(node) = state.nodes.get_mut(path) {
                    node.permissions = permissions;
                }
            } else {
                state.chmod_after_read = Some((target, permissions));
            }
        }
        if bytes.len() as u64 > max_bytes {
            return Ok(bytes);
        }
        Ok(bytes)
    }

    async fn create_new_file(
        &self,
        path: &RemotePath,
        bytes: &[u8],
        permissions: Option<u32>,
    ) -> Result<(), CreateFileFailure> {
        let path = path.as_str();
        let mut state = self.state.lock().await;
        state.create_attempts += 1;
        if state.create_conflict_at == Some(state.create_attempts) {
            return Err(CreateFileFailure::new(CoreError::new(
                CoreErrorCode::Conflict,
                "injected temporary name collision",
                false,
            )));
        }
        if state.create_fail_at == Some(state.create_attempts) {
            let error = CoreError::new(CoreErrorCode::Internal, "injected create failure", true);
            if state.create_cleanup_failed {
                state.nodes.insert(path.to_owned(), FakeNode::file(bytes));
                return Err(CreateFileFailure::with_residual(error, path.to_owned()));
            }
            return Err(CreateFileFailure::new(error));
        }
        if state.nodes.contains_key(path) {
            return Err(CreateFileFailure::new(CoreError::new(
                CoreErrorCode::Conflict,
                "target exists",
                false,
            )));
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

    async fn rename(&self, source: &RemotePath, destination: &RemotePath) -> Result<(), CoreError> {
        let source = source.as_str();
        let destination = destination.as_str();
        let mut state = self.state.lock().await;
        if state.fail_rename {
            return Err(CoreError::new(
                CoreErrorCode::Internal,
                "injected rename failure",
                true,
            ));
        }
        let node = state.nodes.remove(source).ok_or_else(not_found)?;
        state.nodes.insert(destination.to_owned(), node);
        Ok(())
    }

    async fn hardlink(
        &self,
        source: &RemotePath,
        destination: &RemotePath,
    ) -> Result<bool, CoreError> {
        let source = source.as_str();
        let destination = destination.as_str();
        let mut state = self.state.lock().await;
        state.hardlink_attempts += 1;
        if state.hardlink_unsupported {
            return Ok(false);
        }
        if state.hardlink_ambiguous_at == Some(state.hardlink_attempts) {
            let node = state.nodes.get(source).cloned().ok_or_else(not_found)?;
            if state.nodes.contains_key(destination) {
                return Err(CoreError::new(
                    CoreErrorCode::Conflict,
                    "target exists",
                    false,
                ));
            }
            state.nodes.insert(destination.to_owned(), node);
            return Err(CoreError::new(
                CoreErrorCode::Internal,
                "injected lost hardlink response",
                true,
            ));
        }
        if state.hardlink_fail_at == Some(state.hardlink_attempts) {
            return Err(CoreError::new(
                CoreErrorCode::Conflict,
                "injected hardlink failure",
                false,
            ));
        }
        let node = state.nodes.get(source).cloned().ok_or_else(not_found)?;
        if state.nodes.contains_key(destination) {
            return Err(CoreError::new(
                CoreErrorCode::Conflict,
                "target exists",
                false,
            ));
        }
        state.nodes.insert(destination.to_owned(), node);
        Ok(true)
    }

    async fn create_dir(&self, path: &RemotePath) -> Result<(), CoreError> {
        let path = path.as_str();
        let mut state = self.state.lock().await;
        if state.nodes.contains_key(path) {
            return Err(CoreError::new(
                CoreErrorCode::Conflict,
                "target exists",
                false,
            ));
        }
        state.nodes.insert(path.to_owned(), FakeNode::directory());
        Ok(())
    }

    async fn remove_file(&self, path: &RemotePath) -> Result<(), CoreError> {
        let path = path.as_str();
        let mut state = self.state.lock().await;
        if state.remove_not_found_paths.remove(path) {
            state.nodes.remove(path);
            return Err(not_found());
        }
        if state.fail_remove_paths.contains(path) {
            return Err(CoreError::new(
                CoreErrorCode::Internal,
                "injected remove failure",
                true,
            ));
        }
        if state
            .fail_remove_contains
            .as_deref()
            .is_some_and(|fragment| path.contains(fragment))
        {
            return Err(CoreError::new(
                CoreErrorCode::Internal,
                "injected temp cleanup failure",
                true,
            ));
        }
        if state.nodes.remove(path).is_some() {
            Ok(())
        } else {
            Err(not_found())
        }
    }

    async fn remove_dir(&self, path: &RemotePath) -> Result<(), CoreError> {
        let path = path.as_str();
        let mut state = self.state.lock().await;
        if state
            .nodes
            .keys()
            .any(|candidate| parent(candidate) == Some(path))
        {
            return Err(CoreError::new(
                CoreErrorCode::Conflict,
                "directory is not empty",
                false,
            ));
        }
        if state.nodes.remove(path).is_some() {
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
async fn list_rejects_symlink_directories_and_regular_files() {
    let connector = FakeConnector::with_nodes([
        ("/", FakeNode::directory()),
        ("/file.txt", FakeNode::file("x")),
        ("/link", FakeNode::symlink()),
        ("/link/child.txt", FakeNode::file("child")),
    ])
    .await;
    let service = RemoteFileService::new(Arc::new(connector.clone()));

    for path in ["/file.txt", "/link"] {
        let error = service
            .list(&connection(), &RemoteDirectoryPath::try_new(path).unwrap())
            .await
            .expect_err("listing a non-directory path must fail closed");
        assert_eq!(error.code(), CoreErrorCode::Validation, "path: {path}");
    }

    let missing = service
        .list(
            &connection(),
            &RemoteDirectoryPath::try_new("/missing").unwrap(),
        )
        .await
        .expect_err("missing directory must fail");
    assert_eq!(missing.code(), CoreErrorCode::NotFound);
    assert_eq!(connector.closes().await, 3);
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
async fn write_conflicts_when_remote_permissions_change_before_commit() {
    let old = "old\n";
    let connector = FakeConnector::with_nodes([
        ("/", FakeNode::directory()),
        ("/etc", FakeNode::directory()),
        (
            "/etc/app.conf",
            FakeNode {
                permissions: Some(0o644),
                ..FakeNode::file(old)
            },
        ),
    ])
    .await;
    connector
        .chmod_after_read("/etc/app.conf", Some(0o600))
        .await;
    let service = RemoteFileService::new(Arc::new(connector.clone()));

    let error = service
        .write(
            &connection(),
            &RemotePath::try_new("/etc/app.conf").unwrap(),
            "new\n".to_owned(),
            &sha256(old.as_bytes()),
        )
        .await
        .expect_err("permission changes must fail closed");

    assert_eq!(error.code(), CoreErrorCode::Conflict);
    assert_eq!(
        connector.node("/etc/app.conf").await.unwrap().permissions,
        Some(0o600)
    );
    assert_eq!(
        connector.paths().await,
        vec!["/", "/etc", "/etc/app.conf"],
        "temporary edit file must be removed after a failed commit"
    );
    assert_eq!(connector.closes().await, 1);
}

#[tokio::test]
async fn write_reports_a_failed_edit_temp_cleanup_without_hiding_the_commit_error() {
    let old = "old\n";
    let connector = FakeConnector::with_nodes([
        ("/", FakeNode::directory()),
        ("/etc", FakeNode::directory()),
        ("/etc/app.conf", FakeNode::file(old)),
    ])
    .await;
    connector.fail_rename().await;
    connector.fail_remove_containing(".harbor-edit-").await;
    let service = RemoteFileService::new(Arc::new(connector.clone()));

    let error = service
        .write(
            &connection(),
            &RemotePath::try_new("/etc/app.conf").unwrap(),
            "new\n".to_owned(),
            &sha256(old.as_bytes()),
        )
        .await
        .expect_err("replacement failure must be reported");

    assert_eq!(error.code(), CoreErrorCode::Internal);
    assert!(error.message().contains("injected rename failure"));
    assert!(error.message().contains("临时文件"));
    assert!(error.message().contains("清理失败"));
    assert!(
        connector
            .paths()
            .await
            .iter()
            .any(|path| path.contains(".harbor-edit-"))
    );
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

#[tokio::test]
async fn upload_stages_then_commits_all_files_without_overwriting() {
    let connector = FakeConnector::with_nodes([
        ("/", FakeNode::directory()),
        ("/docs", FakeNode::directory()),
    ])
    .await;
    let service = RemoteFileService::new(Arc::new(connector.clone()));

    let outcome = service
        .upload_batch(
            &connection(),
            &RemoteDirectoryPath::try_new("/docs").unwrap(),
            &[
                RemoteUploadFile {
                    name: "one.txt".to_owned(),
                    bytes: b"one".to_vec(),
                },
                RemoteUploadFile {
                    name: "two.txt".to_owned(),
                    bytes: b"two".to_vec(),
                },
            ],
        )
        .await
        .unwrap();

    assert_eq!(outcome.committed, vec!["/docs/one.txt", "/docs/two.txt"]);
    assert!(outcome.residual.is_empty());
    assert!(outcome.error.is_none());
    assert_eq!(
        connector.paths().await,
        vec!["/", "/docs", "/docs/one.txt", "/docs/two.txt"]
    );
    assert_eq!(connector.closes().await, 1);
}

#[tokio::test]
async fn upload_rejects_a_conflict_without_staging_or_overwriting() {
    let connector = FakeConnector::with_nodes([
        ("/", FakeNode::directory()),
        ("/docs", FakeNode::directory()),
        ("/docs/one.txt", FakeNode::file("original")),
    ])
    .await;
    let service = RemoteFileService::new(Arc::new(connector.clone()));

    let outcome = service
        .upload_batch(
            &connection(),
            &RemoteDirectoryPath::try_new("/docs").unwrap(),
            &[RemoteUploadFile {
                name: "one.txt".to_owned(),
                bytes: b"replacement".to_vec(),
            }],
        )
        .await
        .unwrap();

    assert_eq!(outcome.status, UploadBatchStatus::FailedRolledBack);
    assert!(outcome.committed.is_empty());
    assert!(outcome.residual.is_empty());
    assert_eq!(outcome.error.unwrap().code(), CoreErrorCode::Conflict);
    assert_eq!(
        connector.node("/docs/one.txt").await.unwrap().bytes,
        b"original"
    );
    assert_eq!(connector.paths().await, vec!["/", "/docs", "/docs/one.txt"]);
}

#[tokio::test]
async fn upload_rolls_back_committed_targets_when_a_later_commit_fails() {
    let connector = FakeConnector::with_nodes([
        ("/", FakeNode::directory()),
        ("/docs", FakeNode::directory()),
    ])
    .await;
    connector.fail_hardlink_at(2).await;
    let service = RemoteFileService::new(Arc::new(connector.clone()));

    let outcome = service
        .upload_batch(
            &connection(),
            &RemoteDirectoryPath::try_new("/docs").unwrap(),
            &[
                RemoteUploadFile {
                    name: "one.txt".to_owned(),
                    bytes: b"one".to_vec(),
                },
                RemoteUploadFile {
                    name: "two.txt".to_owned(),
                    bytes: b"two".to_vec(),
                },
                RemoteUploadFile {
                    name: "three.txt".to_owned(),
                    bytes: b"three".to_vec(),
                },
            ],
        )
        .await
        .unwrap();

    assert_eq!(outcome.status, UploadBatchStatus::FailedRolledBack);
    assert!(outcome.committed.is_empty());
    assert!(outcome.residual.is_empty());
    assert_eq!(outcome.error.unwrap().code(), CoreErrorCode::Conflict);
    assert_eq!(connector.paths().await, vec!["/", "/docs"]);
    assert_eq!(connector.closes().await, 1);
}

#[tokio::test]
async fn upload_reports_residue_when_rollback_removal_fails() {
    let connector = FakeConnector::with_nodes([
        ("/", FakeNode::directory()),
        ("/docs", FakeNode::directory()),
    ])
    .await;
    connector.fail_hardlink_at(2).await;
    connector.fail_remove("/docs/one.txt").await;
    let service = RemoteFileService::new(Arc::new(connector.clone()));

    let outcome = service
        .upload_batch(
            &connection(),
            &RemoteDirectoryPath::try_new("/docs").unwrap(),
            &[
                RemoteUploadFile {
                    name: "one.txt".to_owned(),
                    bytes: b"one".to_vec(),
                },
                RemoteUploadFile {
                    name: "two.txt".to_owned(),
                    bytes: b"two".to_vec(),
                },
            ],
        )
        .await
        .unwrap();

    assert_eq!(outcome.status, UploadBatchStatus::FailedWithResidue);
    assert_eq!(outcome.committed, vec!["/docs/one.txt"]);
    assert_eq!(outcome.residual, vec!["/docs/one.txt"]);
    assert!(
        outcome
            .warning
            .as_deref()
            .is_some_and(|warning| warning.contains("回滚未完全"))
    );
    assert_eq!(outcome.error.unwrap().code(), CoreErrorCode::Conflict);
    assert_eq!(connector.paths().await, vec!["/", "/docs", "/docs/one.txt"]);
}

#[tokio::test]
async fn upload_reports_a_lost_hardlink_response_as_residue() {
    let connector = FakeConnector::with_nodes([
        ("/", FakeNode::directory()),
        ("/docs", FakeNode::directory()),
    ])
    .await;
    connector.fail_hardlink_after_create_at(2).await;
    let service = RemoteFileService::new(Arc::new(connector.clone()));

    let outcome = service
        .upload_batch(
            &connection(),
            &RemoteDirectoryPath::try_new("/docs").unwrap(),
            &[
                RemoteUploadFile {
                    name: "one.txt".to_owned(),
                    bytes: b"one".to_vec(),
                },
                RemoteUploadFile {
                    name: "two.txt".to_owned(),
                    bytes: b"two".to_vec(),
                },
            ],
        )
        .await
        .unwrap();

    assert_eq!(outcome.status, UploadBatchStatus::FailedWithResidue);
    assert!(outcome.committed.is_empty());
    assert_eq!(outcome.residual, vec!["/docs/two.txt"]);
    assert!(
        outcome
            .warning
            .as_deref()
            .is_some_and(|warning| warning.contains("提交状态未知"))
    );
    assert_eq!(outcome.error.unwrap().code(), CoreErrorCode::Internal);
    assert_eq!(connector.paths().await, vec!["/", "/docs", "/docs/two.txt"]);
}

#[tokio::test]
async fn upload_retries_a_bounded_temporary_name_collision() {
    let connector = FakeConnector::with_nodes([
        ("/", FakeNode::directory()),
        ("/docs", FakeNode::directory()),
    ])
    .await;
    connector.fail_create_conflict_at(1).await;
    let service = RemoteFileService::new(Arc::new(connector.clone()));

    let outcome = service
        .upload_batch(
            &connection(),
            &RemoteDirectoryPath::try_new("/docs").unwrap(),
            &[RemoteUploadFile {
                name: "one.txt".to_owned(),
                bytes: b"one".to_vec(),
            }],
        )
        .await
        .unwrap();

    assert_eq!(outcome.status, UploadBatchStatus::Succeeded);
    assert_eq!(outcome.committed, vec!["/docs/one.txt"]);
    assert_eq!(connector.create_attempts().await, 2);
    assert_eq!(connector.paths().await, vec!["/", "/docs", "/docs/one.txt"]);
}

#[tokio::test]
async fn upload_reports_staging_temp_residue_instead_of_claiming_full_rollback() {
    let connector = FakeConnector::with_nodes([
        ("/", FakeNode::directory()),
        ("/docs", FakeNode::directory()),
    ])
    .await;
    connector.fail_create_at(1, true).await;
    let service = RemoteFileService::new(Arc::new(connector.clone()));

    let outcome = service
        .upload_batch(
            &connection(),
            &RemoteDirectoryPath::try_new("/docs").unwrap(),
            &[RemoteUploadFile {
                name: "one.txt".to_owned(),
                bytes: b"one".to_vec(),
            }],
        )
        .await
        .unwrap();

    assert_eq!(outcome.status, UploadBatchStatus::FailedWithResidue);
    assert!(outcome.committed.is_empty());
    assert_eq!(outcome.residual.len(), 1);
    assert!(outcome.residual[0].contains(".harbor-upload-"));
    assert!(
        outcome
            .warning
            .as_deref()
            .is_some_and(|warning| warning.contains("临时文件清理失败"))
    );
    let residual = outcome.residual.clone();
    assert_eq!(outcome.error.unwrap().code(), CoreErrorCode::Internal);
    assert!(
        connector
            .paths()
            .await
            .iter()
            .any(|path| residual.contains(path))
    );
}

#[tokio::test]
async fn upload_fails_closed_when_the_server_lacks_hardlink_support() {
    let connector = FakeConnector::with_nodes([
        ("/", FakeNode::directory()),
        ("/docs", FakeNode::directory()),
    ])
    .await
    .hardlink_unsupported()
    .await;
    let service = RemoteFileService::new(Arc::new(connector.clone()));

    let outcome = service
        .upload_batch(
            &connection(),
            &RemoteDirectoryPath::try_new("/docs").unwrap(),
            &[RemoteUploadFile {
                name: "one.txt".to_owned(),
                bytes: b"one".to_vec(),
            }],
        )
        .await
        .unwrap();

    assert_eq!(outcome.status, UploadBatchStatus::FailedRolledBack);
    assert_eq!(
        outcome.error.unwrap().code(),
        CoreErrorCode::CapabilityUnavailable
    );
    assert_eq!(connector.paths().await, vec!["/", "/docs"]);
}

#[tokio::test]
async fn file_rename_creates_the_target_without_overwriting_then_removes_the_source() {
    let connector = FakeConnector::with_nodes([
        ("/", FakeNode::directory()),
        ("/docs", FakeNode::directory()),
        ("/docs/source.txt", FakeNode::file("content")),
    ])
    .await;
    let service = RemoteFileService::new(Arc::new(connector.clone()));

    let outcome = service
        .rename_no_clobber(
            &connection(),
            &RemotePath::try_new("/docs/source.txt").unwrap(),
            &RemotePath::try_new("/docs/target.txt").unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(outcome.status, opspilot_ssh_core::RenameStatus::Renamed);
    assert!(outcome.target_created);
    assert_eq!(outcome.source_path, "/docs/source.txt");
    assert_eq!(outcome.target_path, "/docs/target.txt");
    assert_eq!(
        connector.paths().await,
        vec!["/", "/docs", "/docs/target.txt"]
    );
    assert_eq!(
        connector.node("/docs/target.txt").await.unwrap().bytes,
        b"content"
    );
    assert_eq!(connector.closes().await, 1);
}

#[tokio::test]
async fn file_rename_reports_partial_when_source_unlink_fails() {
    let connector = FakeConnector::with_nodes([
        ("/", FakeNode::directory()),
        ("/docs", FakeNode::directory()),
        ("/docs/source.txt", FakeNode::file("content")),
    ])
    .await;
    connector.fail_remove("/docs/source.txt").await;
    let service = RemoteFileService::new(Arc::new(connector.clone()));

    let outcome = service
        .rename_no_clobber(
            &connection(),
            &RemotePath::try_new("/docs/source.txt").unwrap(),
            &RemotePath::try_new("/docs/target.txt").unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(outcome.status, opspilot_ssh_core::RenameStatus::Partial);
    assert!(outcome.target_created);
    assert!(
        outcome
            .warning
            .as_deref()
            .is_some_and(|warning| { warning.contains("源文件删除失败") })
    );
    assert_eq!(outcome.error.unwrap().code(), CoreErrorCode::Internal);
    assert_eq!(
        connector.paths().await,
        vec!["/", "/docs", "/docs/source.txt", "/docs/target.txt"]
    );
}

#[tokio::test]
async fn file_rename_reports_an_ambiguous_hardlink_as_partial() {
    let connector = FakeConnector::with_nodes([
        ("/", FakeNode::directory()),
        ("/docs", FakeNode::directory()),
        ("/docs/source.txt", FakeNode::file("content")),
    ])
    .await;
    connector.fail_hardlink_after_create_at(1).await;
    let service = RemoteFileService::new(Arc::new(connector.clone()));

    let outcome = service
        .rename_no_clobber(
            &connection(),
            &RemotePath::try_new("/docs/source.txt").unwrap(),
            &RemotePath::try_new("/docs/target.txt").unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(outcome.status, opspilot_ssh_core::RenameStatus::Partial);
    assert!(!outcome.target_created);
    assert!(
        outcome
            .warning
            .as_deref()
            .is_some_and(|warning| warning.contains("无法确认"))
    );
    assert_eq!(outcome.error.unwrap().code(), CoreErrorCode::Internal);
    assert_eq!(
        connector.paths().await,
        vec!["/", "/docs", "/docs/source.txt", "/docs/target.txt"]
    );
}

#[tokio::test]
async fn file_rename_treats_an_already_missing_source_after_link_as_success() {
    let connector = FakeConnector::with_nodes([
        ("/", FakeNode::directory()),
        ("/docs", FakeNode::directory()),
        ("/docs/source.txt", FakeNode::file("content")),
    ])
    .await;
    connector
        .remove_before_returning_not_found("/docs/source.txt")
        .await;
    let service = RemoteFileService::new(Arc::new(connector.clone()));

    let outcome = service
        .rename_no_clobber(
            &connection(),
            &RemotePath::try_new("/docs/source.txt").unwrap(),
            &RemotePath::try_new("/docs/target.txt").unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(outcome.status, opspilot_ssh_core::RenameStatus::Renamed);
    assert!(outcome.target_created);
    assert!(outcome.error.is_none());
    assert_eq!(
        connector.paths().await,
        vec!["/", "/docs", "/docs/target.txt"]
    );
}

#[tokio::test]
async fn rename_fails_closed_for_directories_symlinks_and_existing_targets() {
    let connector = FakeConnector::with_nodes([
        ("/", FakeNode::directory()),
        ("/docs", FakeNode::directory()),
        ("/docs/sub", FakeNode::directory()),
        ("/docs/link", FakeNode::symlink()),
        ("/docs/source.txt", FakeNode::file("source")),
        ("/docs/existing.txt", FakeNode::file("existing")),
    ])
    .await;
    let service = RemoteFileService::new(Arc::new(connector.clone()));

    let directory_error = service
        .rename_no_clobber(
            &connection(),
            &RemotePath::try_new("/docs/sub").unwrap(),
            &RemotePath::try_new("/docs/renamed").unwrap(),
        )
        .await
        .expect_err("directory rename must fail closed");
    assert_eq!(directory_error.code(), CoreErrorCode::CapabilityUnavailable);

    let symlink_error = service
        .rename_no_clobber(
            &connection(),
            &RemotePath::try_new("/docs/link").unwrap(),
            &RemotePath::try_new("/docs/renamed-link").unwrap(),
        )
        .await
        .expect_err("symlink rename must fail closed");
    assert_eq!(symlink_error.code(), CoreErrorCode::Validation);

    let conflict = service
        .rename_no_clobber(
            &connection(),
            &RemotePath::try_new("/docs/source.txt").unwrap(),
            &RemotePath::try_new("/docs/existing.txt").unwrap(),
        )
        .await
        .expect_err("existing target must be rejected");
    assert_eq!(conflict.code(), CoreErrorCode::Conflict);
    assert_eq!(
        connector.node("/docs/existing.txt").await.unwrap().bytes,
        b"existing"
    );
}

#[tokio::test]
async fn create_directory_uses_one_atomic_directory_creation() {
    let connector = FakeConnector::with_nodes([
        ("/", FakeNode::directory()),
        ("/docs", FakeNode::directory()),
    ])
    .await;
    let service = RemoteFileService::new(Arc::new(connector.clone()));

    let result = service
        .create_directory(
            &connection(),
            &RemotePath::try_new("/docs/new-folder").unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(result.path, "/docs/new-folder");
    assert!(result.warning.is_none());
    assert_eq!(
        connector.paths().await,
        vec!["/", "/docs", "/docs/new-folder"]
    );
    assert_eq!(connector.closes().await, 1);
}

#[tokio::test]
async fn delete_removes_files_symlinks_and_only_empty_directories() {
    let connector = FakeConnector::with_nodes([
        ("/", FakeNode::directory()),
        ("/docs", FakeNode::directory()),
        ("/docs/file.txt", FakeNode::file("file")),
        ("/docs/link", FakeNode::symlink()),
        ("/docs/empty", FakeNode::directory()),
        ("/docs/nonempty", FakeNode::directory()),
        ("/docs/nonempty/child.txt", FakeNode::file("child")),
    ])
    .await;
    let service = RemoteFileService::new(Arc::new(connector.clone()));

    for path in ["/docs/file.txt", "/docs/link", "/docs/empty"] {
        let result = service
            .delete(&connection(), &RemotePath::try_new(path).unwrap())
            .await
            .unwrap();
        assert_eq!(result.path, path);
    }
    let nonempty = service
        .delete(
            &connection(),
            &RemotePath::try_new("/docs/nonempty").unwrap(),
        )
        .await
        .expect_err("non-empty directories must not be removed recursively");
    assert_eq!(nonempty.code(), CoreErrorCode::Conflict);
    assert_eq!(
        connector.paths().await,
        vec!["/", "/docs", "/docs/nonempty", "/docs/nonempty/child.txt"]
    );
    assert_eq!(connector.closes().await, 4);
}

#[tokio::test]
async fn create_directory_rejects_existing_targets_and_missing_parents() {
    let connector = FakeConnector::with_nodes([
        ("/", FakeNode::directory()),
        ("/docs", FakeNode::directory()),
        ("/docs/existing", FakeNode::directory()),
    ])
    .await;
    let service = RemoteFileService::new(Arc::new(connector.clone()));

    let conflict = service
        .create_directory(
            &connection(),
            &RemotePath::try_new("/docs/existing").unwrap(),
        )
        .await
        .expect_err("existing directory must conflict");
    assert_eq!(conflict.code(), CoreErrorCode::Conflict);

    let missing = service
        .create_directory(&connection(), &RemotePath::try_new("/missing/new").unwrap())
        .await
        .expect_err("missing parent must fail");
    assert_eq!(missing.code(), CoreErrorCode::NotFound);
}

#[tokio::test]
async fn upload_succeeds_with_a_warning_when_temp_cleanup_fails() {
    let connector = FakeConnector::with_nodes([
        ("/", FakeNode::directory()),
        ("/docs", FakeNode::directory()),
    ])
    .await;
    connector.fail_remove_containing(".harbor-upload-").await;
    let service = RemoteFileService::new(Arc::new(connector.clone()));

    let outcome = service
        .upload_batch(
            &connection(),
            &RemoteDirectoryPath::try_new("/docs").unwrap(),
            &[RemoteUploadFile {
                name: "one.txt".to_owned(),
                bytes: b"one".to_vec(),
            }],
        )
        .await
        .unwrap();

    assert_eq!(outcome.status, UploadBatchStatus::Succeeded);
    assert_eq!(outcome.committed, vec!["/docs/one.txt"]);
    assert_eq!(outcome.residual.len(), 1);
    assert!(outcome.residual[0].contains(".harbor-upload-"));
    assert!(
        outcome
            .warning
            .as_deref()
            .is_some_and(|warning| warning.contains("清理失败"))
    );
    assert_eq!(connector.node("/docs/one.txt").await.unwrap().bytes, b"one");
}

#[test]
fn file_mutation_contracts_serialize_with_camel_case_fields_and_statuses() {
    let succeeded = RemoteUploadOutcome {
        status: UploadBatchStatus::Succeeded,
        committed: vec!["/docs/one.txt".to_owned()],
        residual: Vec::new(),
        warning: None,
        error: None,
    };
    assert_eq!(
        serde_json::to_value(&succeeded).unwrap(),
        json!({
            "status": "succeeded",
            "committed": ["/docs/one.txt"],
            "residual": [],
        })
    );

    let residue = RemoteUploadOutcome {
        status: UploadBatchStatus::FailedWithResidue,
        committed: vec!["/docs/one.txt".to_owned()],
        residual: vec!["/docs/one.txt".to_owned()],
        warning: Some("回滚未完全完成".to_owned()),
        error: Some(CoreError::new(
            CoreErrorCode::Conflict,
            "第 2 个文件提交失败",
            false,
        )),
    };
    let residue_json = serde_json::to_value(&residue).unwrap();
    assert_eq!(residue_json["status"], json!("failed_with_residue"));
    assert_eq!(residue_json["committed"], json!(["/docs/one.txt"]));
    assert_eq!(residue_json["residual"], json!(["/docs/one.txt"]));
    assert_eq!(residue_json["warning"], json!("回滚未完全完成"));
    assert_eq!(residue_json["error"]["code"], json!("CONFLICT"));
    assert_eq!(residue_json["error"]["retryable"], json!(false));
    assert_eq!(
        serde_json::from_value::<RemoteUploadOutcome>(residue_json).unwrap(),
        residue
    );

    let renamed = RemoteRenameResult {
        status: RenameStatus::Partial,
        source_path: "/docs/one.txt".to_owned(),
        target_path: "/docs/two.txt".to_owned(),
        target_created: true,
        warning: Some("源文件删除失败".to_owned()),
        error: None,
    };
    let renamed_json = serde_json::to_value(&renamed).unwrap();
    assert_eq!(renamed_json["status"], json!("partial"));
    assert_eq!(renamed_json["sourcePath"], json!("/docs/one.txt"));
    assert_eq!(renamed_json["targetPath"], json!("/docs/two.txt"));
    assert_eq!(renamed_json["targetCreated"], json!(true));
    assert!(renamed_json.get("error").is_none());
    assert_eq!(
        serde_json::from_value::<RemoteRenameResult>(renamed_json).unwrap(),
        renamed
    );

    let mutation = RemoteFileMutationResult {
        path: "/docs".to_owned(),
        warning: None,
    };
    assert_eq!(
        serde_json::to_value(&mutation).unwrap(),
        json!({ "path": "/docs" })
    );
}
