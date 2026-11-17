use std::sync::Arc;

use async_trait::async_trait;
use opspilot_domain::{CoreError, CoreErrorCode};
use opspilot_secrets::SecretStore;
use russh_sftp::{
    client::{SftpSession, error::Error as SftpError},
    protocol::{FileAttributes, OpenFlags, StatusCode},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

use crate::{ConnectionHandle, RemoteDirectoryPath, RemotePath, RusshConnectionManager};

pub const MAX_EDITABLE_FILE_BYTES: u64 = 1024 * 1024;
pub const MAX_EDIT_WRITE_BYTES: u64 = 4 * 1024 * 1024;
pub const FILE_DOWNLOAD_WARNING_BYTES: u64 = 4 * 1024 * 1024;
pub const MAX_FILE_DOWNLOAD_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteFileKind {
    File,
    Directory,
    Symlink,
    Other,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScopedMetadata {
    pub kind: RemoteFileKind,
    pub size: u64,
    pub modified_at: Option<u64>,
    pub permissions: Option<u32>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScopedDirectoryEntry {
    pub name: String,
    pub metadata: ScopedMetadata,
}

#[async_trait]
pub trait ScopedSftp: Send + Sync {
    async fn list_dir(&self, path: &str) -> Result<Vec<ScopedDirectoryEntry>, CoreError>;
    async fn symlink_metadata(&self, path: &str) -> Result<Option<ScopedMetadata>, CoreError>;
    async fn read_file(&self, path: &str, max_bytes: u64) -> Result<Vec<u8>, CoreError>;
    async fn create_new_file(
        &self,
        path: &str,
        bytes: &[u8],
        permissions: Option<u32>,
    ) -> Result<(), CoreError>;
    async fn rename(&self, source: &str, destination: &str) -> Result<(), CoreError>;
    async fn remove_file(&self, path: &str) -> Result<(), CoreError>;
    async fn close(&self) -> Result<(), CoreError>;
}

#[async_trait]
pub trait SftpConnector: Send + Sync {
    async fn open_scoped(
        &self,
        connection: &ConnectionHandle,
    ) -> Result<Box<dyn ScopedSftp>, CoreError>;
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteFileEntry {
    pub name: String,
    pub path: String,
    pub kind: RemoteFileKind,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permissions: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteTextFile {
    pub path: String,
    pub text: String,
    pub sha256: String,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_at: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteFileWriteResult {
    pub path: String,
    pub sha256: String,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteFileDownload {
    pub path: String,
    pub bytes: Vec<u8>,
    pub sha256: String,
}

#[derive(Clone)]
pub struct RemoteFileService {
    connector: Arc<dyn SftpConnector>,
}

impl RemoteFileService {
    pub fn new(connector: Arc<dyn SftpConnector>) -> Self {
        Self { connector }
    }

    pub async fn list(
        &self,
        connection: &ConnectionHandle,
        directory: &RemoteDirectoryPath,
    ) -> Result<Vec<RemoteFileEntry>, CoreError> {
        let session = self.connector.open_scoped(connection).await?;
        let result = async {
            let mut entries = session
                .list_dir(directory.as_str())
                .await?
                .into_iter()
                .map(|entry| {
                    let path = directory.join_resource(&entry.name)?;
                    Ok(RemoteFileEntry {
                        name: entry.name,
                        path: path.as_str().to_owned(),
                        kind: entry.metadata.kind,
                        size: entry.metadata.size,
                        modified_at: entry.metadata.modified_at,
                        permissions: entry.metadata.permissions.map(|mode| mode & 0o7777),
                    })
                })
                .collect::<Result<Vec<_>, CoreError>>()?;
            entries.sort_by(|left, right| {
                let left_directory = left.kind == RemoteFileKind::Directory;
                let right_directory = right.kind == RemoteFileKind::Directory;
                (!left_directory, left.name.to_lowercase(), &left.name).cmp(&(
                    !right_directory,
                    right.name.to_lowercase(),
                    &right.name,
                ))
            });
            Ok(entries)
        }
        .await;
        finish_strict(session, result, "关闭远程目录会话失败").await
    }

    pub async fn read(
        &self,
        connection: &ConnectionHandle,
        path: &RemotePath,
    ) -> Result<RemoteTextFile, CoreError> {
        let session = self.connector.open_scoped(connection).await?;
        let result = read_with_session(session.as_ref(), path).await;
        finish_strict(session, result, "关闭远程文件会话失败").await
    }

    pub async fn write(
        &self,
        connection: &ConnectionHandle,
        path: &RemotePath,
        content: String,
        expected_sha256: &str,
    ) -> Result<RemoteFileWriteResult, CoreError> {
        validate_sha256(expected_sha256)?;
        if content.len() as u64 > MAX_EDIT_WRITE_BYTES {
            return Err(validation("保存内容超过 4 MiB 上限，未写入远程文件"));
        }
        if content.contains('\0') {
            return Err(validation("保存内容包含 NUL，拒绝写入文本文件"));
        }

        let session = self.connector.open_scoped(connection).await?;
        let result = write_with_session(session.as_ref(), path, &content, expected_sha256).await;
        match result {
            Err(error) => {
                let _ = session.close().await;
                Err(error)
            }
            Ok(mut written) => match session.close().await {
                Ok(()) => Ok(written),
                Err(_) => {
                    written.warning = Some(
                        "文件已保存，但 SFTP 会话清理失败；如列表未更新，请刷新确认。".to_owned(),
                    );
                    Ok(written)
                }
            },
        }
    }

    pub async fn download(
        &self,
        connection: &ConnectionHandle,
        path: &RemotePath,
    ) -> Result<RemoteFileDownload, CoreError> {
        let session = self.connector.open_scoped(connection).await?;
        let result = async {
            let metadata = session
                .symlink_metadata(path.as_str())
                .await?
                .ok_or_else(|| not_found("远程文件不存在"))?;
            require_regular_file(&metadata, "下载")?;
            if metadata.size > MAX_FILE_DOWNLOAD_BYTES {
                return Err(validation("远程文件超过 16 MiB 下载上限"));
            }
            let bytes = session
                .read_file(path.as_str(), MAX_FILE_DOWNLOAD_BYTES)
                .await?;
            if bytes.len() as u64 > MAX_FILE_DOWNLOAD_BYTES {
                return Err(CoreError::new(
                    CoreErrorCode::Conflict,
                    "远程文件在下载期间超过 16 MiB 上限",
                    true,
                ));
            }
            Ok(RemoteFileDownload {
                path: path.as_str().to_owned(),
                sha256: sha256(&bytes),
                bytes,
            })
        }
        .await;
        finish_strict(session, result, "关闭远程下载会话失败").await
    }
}

async fn read_with_session(
    session: &dyn ScopedSftp,
    path: &RemotePath,
) -> Result<RemoteTextFile, CoreError> {
    let metadata = session
        .symlink_metadata(path.as_str())
        .await?
        .ok_or_else(|| not_found("远程文件不存在"))?;
    require_regular_file(&metadata, "在线编辑")?;
    if metadata.size > MAX_EDITABLE_FILE_BYTES {
        return Err(validation(
            "远程文件超过 1 MiB 在线编辑上限，未在编辑器中打开",
        ));
    }
    let bytes = session
        .read_file(path.as_str(), MAX_EDITABLE_FILE_BYTES)
        .await?;
    if bytes.len() as u64 > MAX_EDITABLE_FILE_BYTES {
        return Err(CoreError::new(
            CoreErrorCode::Conflict,
            "远程文件在读取期间变大，超过 1 MiB 在线编辑上限",
            true,
        ));
    }
    if bytes.contains(&0) {
        return Err(validation(
            "远程文件包含 NUL，按二进制文件处理，未打开编辑器",
        ));
    }
    let text = String::from_utf8(bytes.clone())
        .map_err(|_| validation("远程文件不是有效 UTF-8 文本，未打开编辑器"))?;
    Ok(RemoteTextFile {
        path: path.as_str().to_owned(),
        text,
        sha256: sha256(&bytes),
        size: bytes.len() as u64,
        modified_at: metadata.modified_at,
    })
}

async fn write_with_session(
    session: &dyn ScopedSftp,
    path: &RemotePath,
    content: &str,
    expected_sha256: &str,
) -> Result<RemoteFileWriteResult, CoreError> {
    let metadata = session
        .symlink_metadata(path.as_str())
        .await?
        .ok_or_else(|| {
            CoreError::new(
                CoreErrorCode::Conflict,
                "远程文件已不存在，草稿未写入",
                false,
            )
        })?;
    require_regular_file(&metadata, "在线编辑保存")?;
    if metadata.size > MAX_EDITABLE_FILE_BYTES {
        return Err(CoreError::new(
            CoreErrorCode::Conflict,
            "远程文件已超过在线编辑上限，无法安全校验，草稿未写入",
            false,
        ));
    }

    let current = session
        .read_file(path.as_str(), MAX_EDITABLE_FILE_BYTES)
        .await?;
    if current.len() as u64 > MAX_EDITABLE_FILE_BYTES {
        return Err(CoreError::new(
            CoreErrorCode::Conflict,
            "远程文件在保存前变大，无法安全校验，草稿未写入",
            false,
        ));
    }
    if sha256(&current) != expected_sha256 {
        return Err(CoreError::new(
            CoreErrorCode::Conflict,
            "远程文件已在别处修改，草稿保留；请重新加载后再保存",
            false,
        ));
    }

    let temp_name = format!(".harbor-edit-{}.tmp", Uuid::new_v4());
    let temp = path.parent_directory().join_resource(&temp_name)?;
    session
        .create_new_file(temp.as_str(), content.as_bytes(), metadata.permissions)
        .await?;

    let replacement = async {
        let latest = session
            .read_file(path.as_str(), MAX_EDITABLE_FILE_BYTES)
            .await?;
        if latest.len() as u64 > MAX_EDITABLE_FILE_BYTES {
            return Err(CoreError::new(
                CoreErrorCode::Conflict,
                "远程文件在提交前变大，草稿未写入",
                false,
            ));
        }
        if sha256(&latest) != expected_sha256 {
            return Err(CoreError::new(
                CoreErrorCode::Conflict,
                "远程文件在提交前发生变化，草稿保留",
                false,
            ));
        }
        session.rename(temp.as_str(), path.as_str()).await
    }
    .await;

    if let Err(error) = replacement {
        let _ = session.remove_file(temp.as_str()).await;
        return Err(error);
    }

    let modified_at = session
        .symlink_metadata(path.as_str())
        .await
        .ok()
        .flatten()
        .and_then(|latest| latest.modified_at);
    Ok(RemoteFileWriteResult {
        path: path.as_str().to_owned(),
        sha256: sha256(content.as_bytes()),
        size: content.len() as u64,
        modified_at,
        warning: None,
    })
}

fn require_regular_file(metadata: &ScopedMetadata, operation: &str) -> Result<(), CoreError> {
    match metadata.kind {
        RemoteFileKind::File => Ok(()),
        RemoteFileKind::Symlink => Err(validation(format!(
            "该路径是符号链接，出于安全考虑不允许{operation}"
        ))),
        RemoteFileKind::Directory => Err(validation(format!("目录不能用于{operation}"))),
        RemoteFileKind::Other => Err(validation(format!(
            "该路径不是普通文件，不能用于{operation}"
        ))),
    }
}

async fn finish_strict<T>(
    session: Box<dyn ScopedSftp>,
    result: Result<T, CoreError>,
    close_message: &str,
) -> Result<T, CoreError> {
    let result = match result {
        Ok(value) => Ok(value),
        Err(error) => {
            let _ = session.close().await;
            return Err(error);
        }
    };
    match session.close().await {
        Ok(()) => result,
        Err(_) => Err(CoreError::new(
            CoreErrorCode::SshConnection,
            close_message,
            true,
        )),
    }
}

fn validate_sha256(value: &str) -> Result<(), CoreError> {
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err(validation("保存时必须提供有效的 SHA-256 冲突校验值"))
    }
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn validation(message: impl Into<String>) -> CoreError {
    CoreError::new(CoreErrorCode::Validation, message, false)
}

fn not_found(message: &'static str) -> CoreError {
    CoreError::new(CoreErrorCode::NotFound, message, false)
}

#[derive(Clone)]
pub struct RusshSftpConnector<S> {
    manager: RusshConnectionManager<S>,
}

impl<S> RusshSftpConnector<S> {
    pub fn new(manager: RusshConnectionManager<S>) -> Self {
        Self { manager }
    }
}

#[async_trait]
impl<S> SftpConnector for RusshSftpConnector<S>
where
    S: SecretStore + Send + Sync + 'static,
{
    async fn open_scoped(
        &self,
        connection: &ConnectionHandle,
    ) -> Result<Box<dyn ScopedSftp>, CoreError> {
        let session = self.manager.open_sftp(connection).await?;
        Ok(Box::new(RusshScopedSftp { session }))
    }
}

struct RusshScopedSftp {
    session: SftpSession,
}

#[async_trait]
impl ScopedSftp for RusshScopedSftp {
    async fn list_dir(&self, path: &str) -> Result<Vec<ScopedDirectoryEntry>, CoreError> {
        let mut entries = self
            .session
            .read_dir(path)
            .await
            .map_err(|error| sftp_error("读取远程目录", error))?
            .map(|entry| ScopedDirectoryEntry {
                name: entry.file_name(),
                metadata: scoped_metadata(entry.metadata()),
            })
            .collect::<Vec<_>>();
        entries.sort_by(|left, right| {
            left.name
                .to_lowercase()
                .cmp(&right.name.to_lowercase())
                .then_with(|| left.name.cmp(&right.name))
        });
        Ok(entries)
    }

    async fn symlink_metadata(&self, path: &str) -> Result<Option<ScopedMetadata>, CoreError> {
        match self.session.symlink_metadata(path).await {
            Ok(metadata) => Ok(Some(scoped_metadata(metadata))),
            Err(SftpError::Status(status)) if status.status_code == StatusCode::NoSuchFile => {
                Ok(None)
            }
            Err(error) => Err(sftp_error("读取远程文件属性", error)),
        }
    }

    async fn read_file(&self, path: &str, max_bytes: u64) -> Result<Vec<u8>, CoreError> {
        let mut file = self
            .session
            .open(path)
            .await
            .map_err(|error| sftp_error("打开远程文件", error))?;
        let metadata = file
            .metadata()
            .await
            .map_err(|error| sftp_error("读取远程文件属性", error))?;
        if !metadata.is_regular() || metadata.is_symlink() {
            return Err(validation("只能读取普通远程文件"));
        }
        if metadata.len() > max_bytes {
            return Err(validation("远程文件超过允许的读取上限"));
        }
        let mut bytes = Vec::with_capacity(metadata.len().min(max_bytes) as usize);
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = file
                .read(&mut buffer)
                .await
                .map_err(|error| io_error("读取远程文件", error))?;
            if read == 0 {
                break;
            }
            if bytes.len() as u64 + read as u64 > max_bytes {
                return Err(CoreError::new(
                    CoreErrorCode::Conflict,
                    "远程文件在读取期间超过允许上限",
                    true,
                ));
            }
            bytes.extend_from_slice(&buffer[..read]);
        }
        file.close()
            .await
            .map_err(|error| io_error("关闭远程文件", error))?;
        Ok(bytes)
    }

    async fn create_new_file(
        &self,
        path: &str,
        bytes: &[u8],
        permissions: Option<u32>,
    ) -> Result<(), CoreError> {
        let mut attributes = FileAttributes::empty();
        attributes.permissions = permissions.map(|mode| mode & 0o7777);
        let mut file = self
            .session
            .open_with_flags_and_attributes(
                path,
                OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::EXCLUDE,
                attributes,
            )
            .await
            .map_err(|error| sftp_error("创建远程临时文件", error))?;
        file.write_all(bytes)
            .await
            .map_err(|error| io_error("写入远程临时文件", error))?;
        file.sync_all()
            .await
            .map_err(|error| sftp_error("同步远程临时文件", error))?;
        file.close()
            .await
            .map_err(|error| io_error("关闭远程临时文件", error))
    }

    async fn rename(&self, source: &str, destination: &str) -> Result<(), CoreError> {
        self.session
            .rename(source, destination)
            .await
            .map_err(|error| sftp_error("替换远程文件", error))
    }

    async fn remove_file(&self, path: &str) -> Result<(), CoreError> {
        self.session
            .remove_file(path)
            .await
            .map_err(|error| sftp_error("清理远程临时文件", error))
    }

    async fn close(&self) -> Result<(), CoreError> {
        self.session
            .close()
            .await
            .map_err(|error| sftp_error("关闭 SFTP 会话", error))
    }
}

fn scoped_metadata(metadata: russh_sftp::client::fs::Metadata) -> ScopedMetadata {
    let kind = if metadata.is_dir() {
        RemoteFileKind::Directory
    } else if metadata.is_symlink() {
        RemoteFileKind::Symlink
    } else if metadata.is_regular() {
        RemoteFileKind::File
    } else {
        RemoteFileKind::Other
    };
    ScopedMetadata {
        kind,
        size: metadata.size.unwrap_or(0),
        modified_at: metadata.mtime.map(u64::from),
        permissions: metadata.permissions.map(|mode| mode & 0o7777),
    }
}

fn sftp_error(context: &str, error: SftpError) -> CoreError {
    match error {
        SftpError::Status(status) => match status.status_code {
            StatusCode::NoSuchFile => {
                CoreError::new(CoreErrorCode::NotFound, "远程路径不存在", false)
            }
            StatusCode::PermissionDenied => CoreError::new(
                CoreErrorCode::RemotePermission,
                "没有权限访问该远程路径",
                false,
            ),
            StatusCode::OpUnsupported => CoreError::new(
                CoreErrorCode::CapabilityUnavailable,
                "SFTP 服务器不支持该文件操作",
                false,
            ),
            StatusCode::NoConnection | StatusCode::ConnectionLost => CoreError::new(
                CoreErrorCode::SshConnection,
                "SSH/SFTP 连接已断开，请重新连接",
                true,
            ),
            _ => CoreError::new(
                CoreErrorCode::Internal,
                format!("{context}失败，请稍后重试"),
                false,
            ),
        },
        SftpError::Timeout => {
            CoreError::new(CoreErrorCode::Timeout, "远程文件操作超时，请重试", true)
        }
        SftpError::IO(_) | SftpError::UnexpectedPacket => CoreError::new(
            CoreErrorCode::SshConnection,
            "SFTP 通道不可用，请检查连接后重试",
            true,
        ),
        SftpError::Limited(_) => CoreError::new(
            CoreErrorCode::CapabilityUnavailable,
            "远程文件超过服务器允许的大小",
            false,
        ),
        SftpError::UnexpectedBehavior(_) => CoreError::new(
            CoreErrorCode::Internal,
            format!("{context}失败，请稍后重试"),
            false,
        ),
    }
}

fn io_error(context: &str, _error: std::io::Error) -> CoreError {
    CoreError::new(
        CoreErrorCode::SshConnection,
        format!("{context}时 SFTP 通道中断，请重新连接"),
        true,
    )
}
