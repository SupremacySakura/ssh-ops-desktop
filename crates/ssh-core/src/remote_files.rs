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
pub const FILE_UPLOAD_WARNING_BYTES: u64 = 4 * 1024 * 1024;
pub const MAX_FILE_UPLOAD_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_UPLOAD_BATCH_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_UPLOAD_BATCH_FILES: usize = 32;
const UPLOAD_TEMP_NAME_ATTEMPTS: usize = 3;

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

#[derive(Clone, Debug)]
pub struct CreateFileFailure {
    pub error: CoreError,
    pub residual: Option<String>,
    pub collision: bool,
}

impl CreateFileFailure {
    pub fn new(error: CoreError) -> Self {
        Self {
            error,
            residual: None,
            collision: false,
        }
    }

    pub fn with_residual(error: CoreError, residual: String) -> Self {
        Self {
            error,
            residual: Some(residual),
            collision: false,
        }
    }

    pub fn collision(error: CoreError) -> Self {
        Self {
            error,
            residual: None,
            collision: true,
        }
    }

    pub fn collision_with_residual(error: CoreError, residual: String) -> Self {
        Self {
            error,
            residual: Some(residual),
            collision: true,
        }
    }
}

struct StagedUpload {
    path: RemotePath,
    ambiguous: Vec<String>,
}

struct StageFailure {
    failure: CreateFileFailure,
    ambiguous: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScopedDirectoryEntry {
    pub name: String,
    pub metadata: ScopedMetadata,
}

#[async_trait]
pub trait ScopedSftp: Send + Sync {
    async fn list_dir(
        &self,
        path: &RemoteDirectoryPath,
    ) -> Result<Vec<ScopedDirectoryEntry>, CoreError>;
    async fn directory_metadata(
        &self,
        path: &RemoteDirectoryPath,
    ) -> Result<Option<ScopedMetadata>, CoreError>;
    async fn symlink_metadata(
        &self,
        path: &RemotePath,
    ) -> Result<Option<ScopedMetadata>, CoreError>;
    async fn read_file(&self, path: &RemotePath, max_bytes: u64) -> Result<Vec<u8>, CoreError>;
    async fn create_new_file(
        &self,
        path: &RemotePath,
        bytes: &[u8],
        permissions: Option<u32>,
    ) -> Result<(), CreateFileFailure>;
    async fn rename(&self, source: &RemotePath, destination: &RemotePath) -> Result<(), CoreError>;
    async fn hardlink(
        &self,
        source: &RemotePath,
        destination: &RemotePath,
    ) -> Result<bool, CoreError>;
    async fn create_dir(&self, path: &RemotePath) -> Result<(), CoreError>;
    async fn remove_file(&self, path: &RemotePath) -> Result<(), CoreError>;
    async fn remove_dir(&self, path: &RemotePath) -> Result<(), CoreError>;
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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteUploadFile {
    pub name: String,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UploadBatchStatus {
    Succeeded,
    FailedRolledBack,
    FailedWithResidue,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteUploadOutcome {
    pub status: UploadBatchStatus,
    pub committed: Vec<String>,
    pub residual: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<CoreError>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RenameStatus {
    Renamed,
    Partial,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteRenameResult {
    pub status: RenameStatus,
    pub source_path: String,
    pub target_path: String,
    pub target_created: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<CoreError>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteFileMutationResult {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
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
            require_no_symlink_ancestors(session.as_ref(), directory.as_str(), true).await?;
            let metadata = session
                .directory_metadata(directory)
                .await?
                .ok_or_else(|| not_found("远程目录不存在"))?;
            if metadata.kind != RemoteFileKind::Directory {
                return Err(validation("远程路径不是普通目录"));
            }
            let mut entries = session
                .list_dir(directory)
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
                    written.warning = Some(match written.warning.take() {
                        Some(existing) => format!(
                            "{existing} 文件已保存，但 SFTP 会话清理失败；如列表未更新，请刷新确认。"
                        ),
                        None => "文件已保存，但 SFTP 会话清理失败；如列表未更新，请刷新确认。"
                            .to_owned(),
                    });
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
            require_no_symlink_ancestors(session.as_ref(), path.as_str(), true).await?;
            let metadata = session
                .symlink_metadata(path)
                .await?
                .ok_or_else(|| not_found("远程文件不存在"))?;
            require_regular_file(&metadata, "下载")?;
            if metadata.size > MAX_FILE_DOWNLOAD_BYTES {
                return Err(validation("远程文件超过 16 MiB 下载上限"));
            }
            let bytes = session.read_file(path, MAX_FILE_DOWNLOAD_BYTES).await?;
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

    pub async fn upload_batch(
        &self,
        connection: &ConnectionHandle,
        directory: &RemoteDirectoryPath,
        files: &[RemoteUploadFile],
    ) -> Result<RemoteUploadOutcome, CoreError> {
        validate_upload_files(directory, files)?;
        let session = self.connector.open_scoped(connection).await?;
        let result = upload_with_session(session.as_ref(), directory, files).await;
        let close_warning = session.close().await.err().map(|_| {
            "文件上传操作已结束，但 SFTP 会话清理失败；如目录未更新，请刷新确认。".to_owned()
        });
        match (result, close_warning) {
            (Ok(mut outcome), warning) => {
                append_warning(&mut outcome, warning);
                Ok(outcome)
            }
            (Err(error), _) => Err(error),
        }
    }

    pub async fn rename_no_clobber(
        &self,
        connection: &ConnectionHandle,
        source: &RemotePath,
        target: &RemotePath,
    ) -> Result<RemoteRenameResult, CoreError> {
        if source == target {
            return Err(validation("新名称必须与原名称不同"));
        }
        if source.parent_directory() != target.parent_directory() {
            return Err(validation("重命名只支持同一父目录内的文件"));
        }
        let session = self.connector.open_scoped(connection).await?;
        let result = rename_with_session(session.as_ref(), source, target).await;
        match result {
            Ok(mut outcome) => {
                if session.close().await.is_err() {
                    append_rename_warning(
                        &mut outcome,
                        "重命名已结束，但 SFTP 会话清理失败；请刷新目录确认结果。".to_owned(),
                    );
                }
                Ok(outcome)
            }
            Err(error) => {
                let _ = session.close().await;
                Err(error)
            }
        }
    }

    pub async fn create_directory(
        &self,
        connection: &ConnectionHandle,
        path: &RemotePath,
    ) -> Result<RemoteFileMutationResult, CoreError> {
        let session = self.connector.open_scoped(connection).await?;
        let result = create_directory_with_session(session.as_ref(), path).await;
        match result {
            Ok(mut outcome) => {
                if session.close().await.is_err() {
                    outcome.warning = Some(
                        "目录已创建，但 SFTP 会话清理失败；如列表未更新，请刷新确认。".to_owned(),
                    );
                }
                Ok(outcome)
            }
            Err(error) => {
                let _ = session.close().await;
                Err(error)
            }
        }
    }

    pub async fn delete(
        &self,
        connection: &ConnectionHandle,
        path: &RemotePath,
    ) -> Result<RemoteFileMutationResult, CoreError> {
        let session = self.connector.open_scoped(connection).await?;
        let result = delete_with_session(session.as_ref(), path).await;
        match result {
            Ok(mut outcome) => {
                if session.close().await.is_err() {
                    outcome.warning = Some(
                        "远程条目已删除，但 SFTP 会话清理失败；如列表未更新，请刷新确认。"
                            .to_owned(),
                    );
                }
                Ok(outcome)
            }
            Err(error) => {
                let _ = session.close().await;
                Err(error)
            }
        }
    }
}

async fn delete_with_session(
    session: &dyn ScopedSftp,
    path: &RemotePath,
) -> Result<RemoteFileMutationResult, CoreError> {
    require_no_symlink_ancestors(session, path.as_str(), false).await?;
    let parent = path.parent_directory();
    let parent_metadata = session
        .directory_metadata(&parent)
        .await?
        .ok_or_else(|| not_found("要删除条目的父目录不存在"))?;
    if parent_metadata.kind != RemoteFileKind::Directory {
        return Err(validation("要删除条目的父路径不是普通目录"));
    }
    let metadata = session
        .symlink_metadata(path)
        .await?
        .ok_or_else(|| not_found("要删除的远程条目不存在"))?;
    match metadata.kind {
        RemoteFileKind::File | RemoteFileKind::Symlink => {
            session.remove_file(path).await?;
        }
        RemoteFileKind::Directory => {
            session.remove_dir(path).await?;
        }
        RemoteFileKind::Other => {
            return Err(validation("该路径不是普通文件、符号链接或目录，已拒绝删除"));
        }
    }
    Ok(RemoteFileMutationResult {
        path: path.as_str().to_owned(),
        warning: None,
    })
}

async fn create_directory_with_session(
    session: &dyn ScopedSftp,
    path: &RemotePath,
) -> Result<RemoteFileMutationResult, CoreError> {
    require_no_symlink_ancestors(session, path.as_str(), false).await?;
    let parent = path.parent_directory();
    let parent_metadata = session
        .directory_metadata(&parent)
        .await?
        .ok_or_else(|| not_found("新建目录的父目录不存在"))?;
    if parent_metadata.kind != RemoteFileKind::Directory {
        return Err(validation("新建目录的父路径不是普通目录"));
    }
    if session.symlink_metadata(path).await?.is_some() {
        return Err(CoreError::new(
            CoreErrorCode::Conflict,
            format!("目标 {} 已存在，未创建目录", path.as_str()),
            false,
        ));
    }
    match session.create_dir(path).await {
        Ok(()) => Ok(RemoteFileMutationResult {
            path: path.as_str().to_owned(),
            warning: None,
        }),
        Err(error) => {
            if session.symlink_metadata(path).await?.is_some() {
                Err(CoreError::new(
                    CoreErrorCode::Conflict,
                    format!("目标 {} 已存在，未创建目录", path.as_str()),
                    false,
                ))
            } else {
                Err(error)
            }
        }
    }
}

async fn rename_with_session(
    session: &dyn ScopedSftp,
    source: &RemotePath,
    target: &RemotePath,
) -> Result<RemoteRenameResult, CoreError> {
    require_no_symlink_ancestors(session, source.as_str(), true).await?;
    require_no_symlink_ancestors(session, target.as_str(), true).await?;
    let parent = source.parent_directory();
    let parent_metadata = session
        .directory_metadata(&parent)
        .await?
        .ok_or_else(|| not_found("重命名源目录不存在"))?;
    if parent_metadata.kind != RemoteFileKind::Directory {
        return Err(validation("重命名源目录不是普通目录"));
    }
    let source_metadata = session
        .symlink_metadata(source)
        .await?
        .ok_or_else(|| not_found("重命名源文件不存在"))?;
    match source_metadata.kind {
        RemoteFileKind::File => {}
        RemoteFileKind::Directory => {
            return Err(CoreError::new(
                CoreErrorCode::CapabilityUnavailable,
                "当前 SFTP 服务器没有经过验证的原子 no-replace 目录重命名原语，已拒绝操作",
                false,
            ));
        }
        RemoteFileKind::Symlink => {
            return Err(validation("重命名源是符号链接，出于安全考虑已拒绝"));
        }
        RemoteFileKind::Other => {
            return Err(validation("重命名源不是普通文件，已拒绝"));
        }
    }
    if session.symlink_metadata(target).await?.is_some() {
        return Err(CoreError::new(
            CoreErrorCode::Conflict,
            format!("目标文件 {} 已存在，未覆盖", target.as_str()),
            false,
        ));
    }
    match session.hardlink(source, target).await {
        Ok(true) => {}
        Ok(false) => {
            return Err(CoreError::new(
                CoreErrorCode::CapabilityUnavailable,
                "SFTP 服务器未启用 hardlink@openssh.com，无法安全无覆盖重命名",
                false,
            ));
        }
        Err(error) => match session.symlink_metadata(target).await {
            Ok(None) => return Err(error),
            Ok(Some(_)) => {
                return Ok(RemoteRenameResult {
                        status: RenameStatus::Partial,
                        source_path: source.as_str().to_owned(),
                        target_path: target.as_str().to_owned(),
                        target_created: false,
                        warning: Some(
                            "目标文件已存在，但无法确认是否由本次重命名创建；源文件未删除，请刷新目录核对。"
                                .to_owned(),
                        ),
                        error: Some(error),
                    });
            }
            Err(_) => {
                return Ok(RemoteRenameResult {
                    status: RenameStatus::Partial,
                    source_path: source.as_str().to_owned(),
                    target_path: target.as_str().to_owned(),
                    target_created: false,
                    warning: Some(
                        "无法确认目标文件是否已创建；源文件未删除，请刷新目录核对。".to_owned(),
                    ),
                    error: Some(error),
                });
            }
        },
    }
    match session.remove_file(source).await {
        Ok(()) => Ok(RemoteRenameResult {
            status: RenameStatus::Renamed,
            source_path: source.as_str().to_owned(),
            target_path: target.as_str().to_owned(),
            target_created: true,
            warning: None,
            error: None,
        }),
        Err(error) if error.code() == CoreErrorCode::NotFound => Ok(RemoteRenameResult {
            status: RenameStatus::Renamed,
            source_path: source.as_str().to_owned(),
            target_path: target.as_str().to_owned(),
            target_created: true,
            warning: None,
            error: None,
        }),
        Err(error) => Ok(RemoteRenameResult {
            status: RenameStatus::Partial,
            source_path: source.as_str().to_owned(),
            target_path: target.as_str().to_owned(),
            target_created: true,
            warning: Some(
                "目标文件已创建，但源文件删除失败或结果未知；请刷新目录核对后重试清理源文件。"
                    .to_owned(),
            ),
            error: Some(error),
        }),
    }
}

fn append_rename_warning(outcome: &mut RemoteRenameResult, warning: String) {
    outcome.warning = Some(match outcome.warning.take() {
        Some(existing) => format!("{existing} {warning}"),
        None => warning,
    });
}

fn validate_upload_files(
    directory: &RemoteDirectoryPath,
    files: &[RemoteUploadFile],
) -> Result<Vec<RemotePath>, CoreError> {
    if files.is_empty() {
        return Err(validation("至少选择一个文件后才能上传"));
    }
    if files.len() > MAX_UPLOAD_BATCH_FILES {
        return Err(validation(format!(
            "单次最多上传 {MAX_UPLOAD_BATCH_FILES} 个文件"
        )));
    }
    let mut total = 0_u64;
    let mut names = std::collections::HashSet::new();
    let mut targets = Vec::with_capacity(files.len());
    for file in files {
        let size = file.bytes.len() as u64;
        if size > MAX_FILE_UPLOAD_BYTES {
            return Err(validation(format!(
                "文件 {} 超过 16 MiB 上传上限",
                file.name
            )));
        }
        total = total
            .checked_add(size)
            .ok_or_else(|| validation("上传批次总大小溢出"))?;
        if total > MAX_UPLOAD_BATCH_BYTES {
            return Err(validation("上传批次总大小超过 16 MiB 上限"));
        }
        if !names.insert(file.name.as_str()) {
            return Err(validation(format!("上传批次包含重复文件名：{}", file.name)));
        }
        targets.push(directory.join_resource(&file.name)?);
    }
    Ok(targets)
}

async fn upload_with_session(
    session: &dyn ScopedSftp,
    directory: &RemoteDirectoryPath,
    files: &[RemoteUploadFile],
) -> Result<RemoteUploadOutcome, CoreError> {
    require_no_symlink_ancestors(session, directory.as_str(), true).await?;
    let directory_metadata = session
        .directory_metadata(directory)
        .await?
        .ok_or_else(|| not_found("上传目标目录不存在"))?;
    if directory_metadata.kind != RemoteFileKind::Directory {
        return Err(validation("上传目标不是普通目录"));
    }

    let targets = validate_upload_files(directory, files)?;
    for target in &targets {
        if session.symlink_metadata(target).await?.is_some() {
            return Ok(RemoteUploadOutcome {
                status: UploadBatchStatus::FailedRolledBack,
                committed: Vec::new(),
                residual: Vec::new(),
                warning: None,
                error: Some(CoreError::new(
                    CoreErrorCode::Conflict,
                    format!("目标文件 {} 已存在，未覆盖", target.as_str()),
                    false,
                )),
            });
        }
    }

    let mut staged = Vec::with_capacity(files.len());
    let mut staging_residual = Vec::new();
    for (file, target) in files.iter().zip(targets.iter()) {
        match stage_upload_file(session, directory, &file.bytes).await {
            Ok(staged_upload) => {
                staging_residual.extend(staged_upload.ambiguous);
                staged.push((staged_upload.path, target.clone()));
            }
            Err(stage_failure) => {
                let mut residual =
                    cleanup_paths(session, staged.iter().map(|(path, _)| path)).await;
                if let Some(path) = stage_failure.failure.residual {
                    residual.insert(0, path);
                }
                extend_unique(&mut residual, stage_failure.ambiguous);
                extend_unique(&mut residual, staging_residual);
                return Ok(RemoteUploadOutcome {
                    status: if residual.is_empty() {
                        UploadBatchStatus::FailedRolledBack
                    } else {
                        UploadBatchStatus::FailedWithResidue
                    },
                    committed: Vec::new(),
                    warning: (!residual.is_empty()).then(|| {
                        format!(
                            "临时文件清理失败或可能残留，以下路径可能仍然存在：{}",
                            residual.join("、")
                        )
                    }),
                    residual,
                    error: Some(stage_failure.failure.error),
                });
            }
        }
    }

    let mut committed = Vec::with_capacity(staged.len());
    for (temp, target) in &staged {
        match session.hardlink(temp, target).await {
            Ok(true) => committed.push(target.clone()),
            Ok(false) => {
                return Ok(failed_upload_outcome(
                    session,
                    &staged,
                    &committed,
                    CoreError::new(
                        CoreErrorCode::CapabilityUnavailable,
                        "SFTP 服务器未启用 hardlink@openssh.com，无法安全无覆盖提交上传",
                        false,
                    ),
                    None,
                )
                .await);
            }
            Err(error) => {
                let ambiguous_target = match session.symlink_metadata(target).await {
                    Ok(None) => None,
                    Ok(Some(_)) | Err(_) => Some(target.clone()),
                };
                return Ok(failed_upload_outcome(
                    session,
                    &staged,
                    &committed,
                    error,
                    ambiguous_target.as_ref(),
                )
                .await);
            }
        }
    }

    let mut residual = cleanup_paths(session, staged.iter().map(|(path, _)| path)).await;
    extend_unique(&mut residual, staging_residual);
    let warning = (!residual.is_empty()).then(|| {
        format!(
            "文件已上传，但临时文件清理失败或状态未知；请稍后手动核对 {}",
            residual.join("、")
        )
    });
    Ok(RemoteUploadOutcome {
        status: UploadBatchStatus::Succeeded,
        committed: committed
            .into_iter()
            .map(|path| path.as_str().to_owned())
            .collect(),
        residual,
        warning,
        error: None,
    })
}

async fn failed_upload_outcome(
    session: &dyn ScopedSftp,
    staged: &[(RemotePath, RemotePath)],
    committed: &[RemotePath],
    error: CoreError,
    ambiguous_target: Option<&RemotePath>,
) -> RemoteUploadOutcome {
    let mut remaining_committed = Vec::new();
    for target in committed.iter().rev() {
        match session.remove_file(target).await {
            Ok(()) => {}
            Err(error) if error.code() == CoreErrorCode::NotFound => {}
            Err(_) => remaining_committed.push(target.clone()),
        }
    }
    remaining_committed.reverse();

    let rollback_failed = !remaining_committed.is_empty();
    let mut residual = remaining_committed
        .iter()
        .map(|path| path.as_str().to_owned())
        .collect::<Vec<_>>();
    if let Some(target) = ambiguous_target {
        let target = target.as_str().to_owned();
        if !residual.contains(&target) {
            residual.push(target);
        }
    }
    let temp_residual = cleanup_paths(session, staged.iter().map(|(path, _)| path)).await;
    let temp_cleanup_failed = !temp_residual.is_empty();
    extend_unique(&mut residual, temp_residual);
    let warning = (!residual.is_empty()).then(|| {
        let mut parts: Vec<String> = Vec::new();
        if ambiguous_target.is_some() {
            parts.push("目标提交状态未知，未尝试删除可能已创建的目标。".to_owned());
        }
        if rollback_failed {
            parts.push("已提交目标回滚未完全完成。".to_owned());
        }
        if temp_cleanup_failed {
            parts.push("临时文件清理失败。".to_owned());
        }
        parts.push(format!("以下路径可能仍然存在：{}", residual.join("、")));
        parts.join(" ")
    });
    RemoteUploadOutcome {
        status: if residual.is_empty() {
            UploadBatchStatus::FailedRolledBack
        } else {
            UploadBatchStatus::FailedWithResidue
        },
        committed: remaining_committed
            .iter()
            .map(|path| path.as_str().to_owned())
            .collect(),
        residual,
        warning,
        error: Some(error),
    }
}

async fn stage_upload_file(
    session: &dyn ScopedSftp,
    directory: &RemoteDirectoryPath,
    bytes: &[u8],
) -> Result<StagedUpload, StageFailure> {
    let mut ambiguous = Vec::new();
    let mut last_collision = None;
    for _ in 0..UPLOAD_TEMP_NAME_ATTEMPTS {
        let temp_name = format!(".harbor-upload-{}.part", Uuid::new_v4());
        let temp = directory
            .join_resource(&temp_name)
            .map_err(|error| StageFailure {
                failure: CreateFileFailure::new(error),
                ambiguous: Vec::new(),
            })?;
        match session.create_new_file(&temp, bytes, None).await {
            Ok(()) => {
                return Ok(StagedUpload {
                    path: temp,
                    ambiguous,
                });
            }
            Err(failure) if failure.collision => {
                if let Some(residual) = failure.residual.clone() {
                    ambiguous.push(residual);
                }
                last_collision = Some(failure);
            }
            Err(failure) => {
                return Err(StageFailure { failure, ambiguous });
            }
        }
    }
    Err(StageFailure {
        failure: last_collision.expect("at least one upload staging attempt"),
        ambiguous,
    })
}

async fn cleanup_paths<'a>(
    session: &dyn ScopedSftp,
    paths: impl Iterator<Item = &'a RemotePath>,
) -> Vec<String> {
    let mut residual = Vec::new();
    for path in paths {
        match session.remove_file(path).await {
            Ok(()) => {}
            Err(error) if error.code() == CoreErrorCode::NotFound => {}
            Err(_) => residual.push(path.as_str().to_owned()),
        }
    }
    residual
}

fn extend_unique(target: &mut Vec<String>, paths: impl IntoIterator<Item = String>) {
    for path in paths {
        if !target.contains(&path) {
            target.push(path);
        }
    }
}

fn append_warning(outcome: &mut RemoteUploadOutcome, warning: Option<String>) {
    if let Some(warning) = warning {
        outcome.warning = Some(match outcome.warning.take() {
            Some(existing) => format!("{existing} {warning}"),
            None => warning,
        });
    }
}

async fn read_with_session(
    session: &dyn ScopedSftp,
    path: &RemotePath,
) -> Result<RemoteTextFile, CoreError> {
    require_no_symlink_ancestors(session, path.as_str(), true).await?;
    let metadata = session
        .symlink_metadata(path)
        .await?
        .ok_or_else(|| not_found("远程文件不存在"))?;
    require_regular_file(&metadata, "在线编辑")?;
    if metadata.size > MAX_EDITABLE_FILE_BYTES {
        return Err(validation(
            "远程文件超过 1 MiB 在线编辑上限，未在编辑器中打开",
        ));
    }
    let bytes = session.read_file(path, MAX_EDITABLE_FILE_BYTES).await?;
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
    require_no_symlink_ancestors(session, path.as_str(), true).await?;
    let metadata = session.symlink_metadata(path).await?.ok_or_else(|| {
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

    let current = session.read_file(path, MAX_EDITABLE_FILE_BYTES).await?;
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
    if let Err(failure) = session
        .create_new_file(&temp, content.as_bytes(), metadata.permissions)
        .await
    {
        return Err(match failure.residual {
            Some(residual) => CoreError::new(
                failure.error.code(),
                format!(
                    "{}；临时文件 {} 可能残留或清理失败，请手动清理",
                    failure.error.message(),
                    residual
                ),
                failure.error.is_retryable(),
            ),
            None => failure.error,
        });
    }

    let replacement = async {
        let latest_metadata = session.symlink_metadata(path).await?.ok_or_else(|| {
            CoreError::new(
                CoreErrorCode::Conflict,
                "远程文件在提交前已不存在，草稿未写入",
                false,
            )
        })?;
        require_regular_file(&latest_metadata, "在线编辑保存")?;
        if latest_metadata.permissions != metadata.permissions {
            return Err(CoreError::new(
                CoreErrorCode::Conflict,
                "远程文件权限在保存期间发生变化，草稿未写入",
                false,
            ));
        }
        let latest = session.read_file(path, MAX_EDITABLE_FILE_BYTES).await?;
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
        session.rename(&temp, path).await
    }
    .await;

    if let Err(error) = replacement {
        let temp_state = session.symlink_metadata(&temp).await;
        if matches!(temp_state, Ok(None)) {
            return Err(CoreError::new(
                error.code(),
                format!(
                    "{}；临时文件已不存在，替换可能已成功，请重新加载远程文件核对后再决定是否重试",
                    error.message()
                ),
                error.is_retryable(),
            ));
        }
        if let Err(cleanup_error) = session.remove_file(&temp).await
            && cleanup_error.code() != CoreErrorCode::NotFound
        {
            return Err(CoreError::new(
                error.code(),
                format!(
                    "{}；临时文件 {} 清理失败，请手动清理",
                    error.message(),
                    temp.as_str()
                ),
                error.is_retryable(),
            ));
        }
        if temp_state.is_err() {
            return Err(CoreError::new(
                error.code(),
                format!(
                    "{}；无法确认临时文件 {} 的状态，请手动核对",
                    error.message(),
                    temp.as_str()
                ),
                error.is_retryable(),
            ));
        }
        return Err(error);
    }

    let final_metadata = session.symlink_metadata(path).await.ok().flatten();
    let modified_at = final_metadata
        .as_ref()
        .and_then(|latest| latest.modified_at);
    let warning = if final_metadata
        .as_ref()
        .and_then(|latest| latest.permissions)
        == metadata.permissions
    {
        None
    } else {
        Some("文件已保存，但无法确认远程权限保持不变；请检查文件权限。".to_owned())
    };
    Ok(RemoteFileWriteResult {
        path: path.as_str().to_owned(),
        sha256: sha256(content.as_bytes()),
        size: content.len() as u64,
        modified_at,
        warning,
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

async fn require_no_symlink_ancestors(
    session: &dyn ScopedSftp,
    path: &str,
    include_leaf: bool,
) -> Result<(), CoreError> {
    // SFTP v3 has no openat-style no-follow handle, so this is a fail-closed preflight,
    // not an atomic guarantee: a component can be swapped to a symlink between this
    // lstat walk and the subsequent operation. Callers that open a file re-check the
    // leaf after open; ancestor races remain a documented protocol limitation.
    if path == "/" {
        return Ok(());
    }
    let segments = path
        .strip_prefix('/')
        .unwrap_or(path)
        .split('/')
        .collect::<Vec<_>>();
    let checked = if include_leaf {
        segments.len()
    } else {
        segments.len().saturating_sub(1)
    };
    let mut current = String::new();
    for segment in segments.into_iter().take(checked) {
        current.push('/');
        current.push_str(segment);
        match session
            .symlink_metadata(&RemotePath::try_new(&current)?)
            .await?
        {
            Some(metadata) if metadata.kind == RemoteFileKind::Symlink => {
                return Err(CoreError::new(
                    CoreErrorCode::Validation,
                    format!(
                        "路径 {current} 是符号链接，出于安全考虑不允许经由符号链接访问远程路径"
                    ),
                    false,
                ));
            }
            Some(_) => {}
            None => {}
        }
    }
    Ok(())
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

impl RusshScopedSftp {
    async fn cleanup_created_file(&self, path: &RemotePath) -> Option<String> {
        match self.session.remove_file(path.as_str()).await {
            Ok(()) => None,
            Err(SftpError::Status(status)) if status.status_code == StatusCode::NoSuchFile => None,
            Err(_) => Some(path.as_str().to_owned()),
        }
    }
}

#[async_trait]
impl ScopedSftp for RusshScopedSftp {
    async fn list_dir(
        &self,
        path: &RemoteDirectoryPath,
    ) -> Result<Vec<ScopedDirectoryEntry>, CoreError> {
        let mut entries = self
            .session
            .read_dir(path.as_str())
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

    async fn directory_metadata(
        &self,
        path: &RemoteDirectoryPath,
    ) -> Result<Option<ScopedMetadata>, CoreError> {
        match self.session.symlink_metadata(path.as_str()).await {
            Ok(metadata) => Ok(Some(scoped_metadata(metadata))),
            Err(SftpError::Status(status)) if status.status_code == StatusCode::NoSuchFile => {
                Ok(None)
            }
            Err(error) => Err(sftp_error("读取远程目录属性", error)),
        }
    }

    async fn symlink_metadata(
        &self,
        path: &RemotePath,
    ) -> Result<Option<ScopedMetadata>, CoreError> {
        match self.session.symlink_metadata(path.as_str()).await {
            Ok(metadata) => Ok(Some(scoped_metadata(metadata))),
            Err(SftpError::Status(status)) if status.status_code == StatusCode::NoSuchFile => {
                Ok(None)
            }
            Err(error) => Err(sftp_error("读取远程文件属性", error)),
        }
    }

    async fn read_file(&self, path: &RemotePath, max_bytes: u64) -> Result<Vec<u8>, CoreError> {
        let mut file = self
            .session
            .open(path.as_str())
            .await
            .map_err(|error| sftp_error("打开远程文件", error))?;
        let path_metadata = self
            .session
            .symlink_metadata(path.as_str())
            .await
            .map_err(|error| sftp_error("读取远程文件属性", error))?;
        if !path_metadata.is_regular() || path_metadata.is_symlink() {
            return Err(validation("只能读取普通远程文件"));
        }
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
        path: &RemotePath,
        bytes: &[u8],
        permissions: Option<u32>,
    ) -> Result<(), CreateFileFailure> {
        let mut attributes = FileAttributes::empty();
        attributes.permissions = permissions.map(|mode| mode & 0o7777);
        let mut file = match self
            .session
            .open_with_flags_and_attributes(
                path.as_str(),
                OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::EXCLUDE,
                attributes,
            )
            .await
        {
            Ok(file) => file,
            Err(error) => {
                let error = sftp_error("创建远程临时文件", error);
                if error.code() == CoreErrorCode::Conflict {
                    return Err(CreateFileFailure::collision(error));
                }
                return Err(match self.session.symlink_metadata(path.as_str()).await {
                    Err(SftpError::Status(status))
                        if status.status_code == StatusCode::NoSuchFile =>
                    {
                        CreateFileFailure::new(error)
                    }
                    Ok(_) => {
                        CreateFileFailure::collision_with_residual(error, path.as_str().to_owned())
                    }
                    Err(_) => CreateFileFailure::with_residual(error, path.as_str().to_owned()),
                });
            }
        };
        if let Err(error) = file.write_all(bytes).await {
            drop(file);
            let error = io_error("写入远程临时文件", error);
            return Err(match self.cleanup_created_file(path).await {
                Some(residual) => CreateFileFailure::with_residual(error, residual),
                None => CreateFileFailure::new(error),
            });
        }
        if let Err(error) = file.sync_all().await {
            drop(file);
            let error = sftp_error("同步远程临时文件", error);
            return Err(match self.cleanup_created_file(path).await {
                Some(residual) => CreateFileFailure::with_residual(error, residual),
                None => CreateFileFailure::new(error),
            });
        }
        if let Err(error) = file.close().await {
            let error = io_error("关闭远程临时文件", error);
            return Err(match self.cleanup_created_file(path).await {
                Some(residual) => CreateFileFailure::with_residual(error, residual),
                None => CreateFileFailure::new(error),
            });
        }
        Ok(())
    }

    async fn rename(&self, source: &RemotePath, destination: &RemotePath) -> Result<(), CoreError> {
        self.session
            .rename(source.as_str(), destination.as_str())
            .await
            .map_err(|error| sftp_error("替换远程文件", error))
    }

    async fn hardlink(
        &self,
        source: &RemotePath,
        destination: &RemotePath,
    ) -> Result<bool, CoreError> {
        self.session
            .hardlink(source.as_str(), destination.as_str())
            .await
            .map_err(|error| sftp_error("创建远程硬链接", error))
    }

    async fn create_dir(&self, path: &RemotePath) -> Result<(), CoreError> {
        self.session
            .create_dir(path.as_str())
            .await
            .map_err(|error| sftp_error("创建远程目录", error))
    }

    async fn remove_file(&self, path: &RemotePath) -> Result<(), CoreError> {
        self.session
            .remove_file(path.as_str())
            .await
            .map_err(|error| sftp_error("删除远程文件", error))
    }

    async fn remove_dir(&self, path: &RemotePath) -> Result<(), CoreError> {
        self.session
            .remove_dir(path.as_str())
            .await
            .map_err(remove_dir_error)
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

fn remove_dir_error(error: SftpError) -> CoreError {
    match &error {
        SftpError::Status(status) if status.status_code == StatusCode::Failure => CoreError::new(
            CoreErrorCode::Conflict,
            "目录非空或服务器拒绝删除；Harbor 不会递归删除，请先清空目录",
            false,
        ),
        _ => sftp_error("删除远程目录", error),
    }
}

fn io_error(context: &str, error: std::io::Error) -> CoreError {
    use std::io::ErrorKind;

    match error.kind() {
        ErrorKind::PermissionDenied => CoreError::new(
            CoreErrorCode::RemotePermission,
            format!("{context}失败：没有权限访问该远程路径"),
            false,
        ),
        ErrorKind::NotFound => CoreError::new(
            CoreErrorCode::NotFound,
            format!("{context}失败：远程文件不存在"),
            false,
        ),
        ErrorKind::TimedOut | ErrorKind::WouldBlock => CoreError::new(
            CoreErrorCode::Timeout,
            format!("{context}超时，请重试"),
            true,
        ),
        ErrorKind::BrokenPipe
        | ErrorKind::ConnectionReset
        | ErrorKind::ConnectionAborted
        | ErrorKind::NotConnected
        | ErrorKind::UnexpectedEof => CoreError::new(
            CoreErrorCode::SshConnection,
            format!("{context}时 SFTP 通道中断，请重新连接"),
            true,
        ),
        _ => CoreError::new(
            CoreErrorCode::Internal,
            format!("{context}失败，请稍后重试"),
            false,
        ),
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Error, ErrorKind};

    use opspilot_domain::CoreErrorCode;

    use super::io_error;

    #[test]
    fn file_io_errors_do_not_all_look_like_a_dropped_connection() {
        assert_eq!(
            io_error("读取远程文件", Error::from(ErrorKind::PermissionDenied)).code(),
            CoreErrorCode::RemotePermission
        );
        assert_eq!(
            io_error("读取远程文件", Error::from(ErrorKind::NotFound)).code(),
            CoreErrorCode::NotFound
        );
        assert_eq!(
            io_error("读取远程文件", Error::from(ErrorKind::TimedOut)).code(),
            CoreErrorCode::Timeout
        );
        assert_eq!(
            io_error("读取远程文件", Error::from(ErrorKind::BrokenPipe)).code(),
            CoreErrorCode::SshConnection
        );
        assert_eq!(
            io_error("读取远程文件", Error::other("remote status failure")).code(),
            CoreErrorCode::Internal
        );
    }
}
