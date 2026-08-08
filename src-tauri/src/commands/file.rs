use opspilot_audit::AuditEvent;
use opspilot_domain::{CoreError, CoreErrorCode};
use opspilot_ssh_core::{ConnectionHandle, RemotePath};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;

use super::services;

const MAX_FILE_PREVIEW_BYTES: u64 = 1024 * 1024;
const MAX_FILE_DOWNLOAD_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FileListRequest {
    connection: ConnectionHandle,
    path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FileReadRequest {
    connection: ConnectionHandle,
    path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FileDownloadRequest {
    connection: ConnectionHandle,
    path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteFileEntry {
    name: String,
    path: String,
    kind: &'static str,
    size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    modified_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    permissions: Option<u32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteFileContent {
    path: String,
    bytes: Vec<u8>,
    sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    modified_at: Option<u64>,
    truncated: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteFileDownload {
    path: String,
    bytes: Vec<u8>,
    sha256: String,
}

#[tauri::command]
pub(crate) async fn file_list(
    app: AppHandle,
    request: FileListRequest,
) -> Result<Vec<RemoteFileEntry>, CoreError> {
    validate_directory_path(&request.path)?;
    let services = services(&app);
    let session = services
        .connection_manager
        .open_sftp(&request.connection)
        .await?;
    let result = async {
        let mut entries = session
            .read_dir(request.path.clone())
            .await
            .map_err(|error| sftp_error("list remote directory", error))?
            .map(|entry| {
                let metadata = entry.metadata();
                let kind = if metadata.is_dir() {
                    "directory"
                } else if metadata.is_regular() {
                    "file"
                } else if metadata.is_symlink() {
                    "symlink"
                } else {
                    "other"
                };
                RemoteFileEntry {
                    name: entry.file_name(),
                    path: entry.path(),
                    kind,
                    size: metadata.size.unwrap_or(0),
                    modified_at: metadata.mtime.map(u64::from),
                    permissions: metadata.permissions,
                }
            })
            .collect::<Vec<_>>();
        entries.sort_by(|left, right| {
            (left.kind != "directory", left.name.to_lowercase())
                .cmp(&(right.kind != "directory", right.name.to_lowercase()))
        });
        Ok(entries)
    }
    .await;
    let _ = session.close().await;
    let entries = result?;
    services
        .audit_writer
        .append(
            AuditEvent::new(
                "file.list",
                "remote_directory",
                "success",
                serde_json::json!({ "entryCount": entries.len() }),
            )
            .with_server_id(request.connection.server_id().to_string()),
        )
        .await?;
    Ok(entries)
}

#[tauri::command]
pub(crate) async fn file_read(
    app: AppHandle,
    request: FileReadRequest,
) -> Result<RemoteFileContent, CoreError> {
    let path = RemotePath::try_new(&request.path)?;
    let services = services(&app);
    let session = services
        .connection_manager
        .open_sftp(&request.connection)
        .await?;
    let result = async {
        let metadata = session
            .metadata(path.as_str())
            .await
            .map_err(|error| sftp_error("read remote file metadata", error))?;
        if !metadata.is_regular() {
            return Err(CoreError::new(
                CoreErrorCode::Validation,
                "remote preview requires a regular file",
                false,
            ));
        }
        if metadata.size.unwrap_or(0) > MAX_FILE_PREVIEW_BYTES {
            return Err(CoreError::new(
                CoreErrorCode::CapabilityUnavailable,
                "remote file exceeds the 1 MiB preview limit; use a bounded download task",
                false,
            ));
        }
        let bytes = session
            .read(path.as_str())
            .await
            .map_err(|error| sftp_error("read remote file", error))?;
        if bytes.len() as u64 > MAX_FILE_PREVIEW_BYTES {
            return Err(CoreError::new(
                CoreErrorCode::Conflict,
                "remote file grew beyond the 1 MiB preview limit while reading",
                true,
            ));
        }
        let sha256 = Sha256::digest(&bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        Ok(RemoteFileContent {
            path: path.as_str().to_owned(),
            bytes,
            sha256,
            modified_at: metadata.mtime.map(u64::from),
            truncated: false,
        })
    }
    .await;
    let _ = session.close().await;
    let content = result?;
    services
        .audit_writer
        .append(
            AuditEvent::new(
                "file.read",
                "remote_file",
                "success",
                serde_json::json!({ "size": content.bytes.len(), "sha256": content.sha256 }),
            )
            .with_server_id(request.connection.server_id().to_string()),
        )
        .await?;
    Ok(content)
}

#[tauri::command]
pub(crate) async fn file_download(
    app: AppHandle,
    request: FileDownloadRequest,
) -> Result<RemoteFileDownload, CoreError> {
    let path = RemotePath::try_new(&request.path)?;
    let services = services(&app);
    let session = services
        .connection_manager
        .open_sftp(&request.connection)
        .await?;
    let result = async {
        let metadata = session
            .symlink_metadata(path.as_str())
            .await
            .map_err(|error| sftp_error("read download metadata", error))?;
        if !metadata.is_regular() || metadata.is_symlink() {
            return Err(CoreError::new(
                CoreErrorCode::Validation,
                "remote download requires a regular non-symlink file",
                false,
            ));
        }
        if metadata.size.unwrap_or(0) > MAX_FILE_DOWNLOAD_BYTES {
            return Err(CoreError::new(
                CoreErrorCode::CapabilityUnavailable,
                "remote file exceeds the 16 MiB download limit",
                false,
            ));
        }
        let bytes = session
            .read(path.as_str())
            .await
            .map_err(|error| sftp_error("download remote file", error))?;
        if bytes.len() as u64 > MAX_FILE_DOWNLOAD_BYTES {
            return Err(CoreError::new(
                CoreErrorCode::Conflict,
                "remote file grew beyond the 16 MiB download limit",
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
    let _ = session.close().await;
    let download = result?;
    services
        .audit_writer
        .append(
            AuditEvent::new(
                "file.download",
                "remote_file",
                "success",
                serde_json::json!({
                    "size": download.bytes.len(),
                    "sha256": download.sha256,
                }),
            )
            .with_server_id(request.connection.server_id().to_string()),
        )
        .await?;
    Ok(download)
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn validate_directory_path(path: &str) -> Result<(), CoreError> {
    if path == "/" {
        return Ok(());
    }
    RemotePath::try_new(path).map(|_| ())
}

fn sftp_error(context: &str, error: impl std::fmt::Display) -> CoreError {
    CoreError::new(
        CoreErrorCode::SshConnection,
        format!("failed to {context}: {error}"),
        true,
    )
}
