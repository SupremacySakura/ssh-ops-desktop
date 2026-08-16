use async_trait::async_trait;
use opspilot_domain::{CoreError, CoreErrorCode, Id, ToolCall};
use opspilot_persistence::{Database, ProjectRepository, ServerRepository};
use opspilot_remote_adapters::{
    ContainerIdentifier, DockerCliAdapter, GitRevision, NginxAdapter, NginxApplyPlan,
    ReleaseDeployer, RemoteExecutor, ServiceAction, SystemdAdapter,
};
use opspilot_secrets::SecretStore;
use opspilot_ssh_core::{ConnectionHandle, RemotePath, RusshConnectionManager};
use opspilot_task_engine::{
    ApprovalProof, ApprovedOperation, OperationActor, OperationGateway, OperationState,
    PrepareResult, SqliteOperationGateway, TaskRef, ToolAction, ToolCatalog, ToolDefinition,
    ToolEffect, ToolExecutor, ToolResult,
};
use tauri::{State, WebviewWindow};
use tokio::io::AsyncWriteExt;

use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::CoreServices;

pub(super) fn agent_tool_descriptors() -> Vec<opspilot_agent_bridge::ToolDescriptor> {
    let empty = || serde_json::json!({ "type": "object", "additionalProperties": false });
    let connection = || {
        serde_json::json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["serverId", "connectionId"],
            "properties": {
                "serverId": { "type": "string", "format": "uuid" },
                "connectionId": { "type": "string", "format": "uuid" }
            }
        })
    };
    let with_connection = |mut properties: serde_json::Map<String, serde_json::Value>,
                           required: Vec<&str>| {
        properties.insert("connection".to_owned(), connection());
        let mut required = required.into_iter().map(str::to_owned).collect::<Vec<_>>();
        required.push("connection".to_owned());
        serde_json::json!({
            "type": "object", "additionalProperties": false,
            "required": required, "properties": properties,
        })
    };
    let service_schema = || {
        with_connection(
            serde_json::Map::from_iter([(
                "unit".to_owned(),
                serde_json::json!({ "type": "string", "minLength": 1, "maxLength": 256 }),
            )]),
            vec!["unit"],
        )
    };
    let container_schema = || {
        with_connection(
            serde_json::Map::from_iter([(
                "container".to_owned(),
                serde_json::json!({ "type": "string", "minLength": 1, "maxLength": 256 }),
            )]),
            vec!["container"],
        )
    };
    [
        ("server.overview", "Read a redacted server overview", empty()),
        ("file.write", "Atomically write one conflict-checked remote file", with_connection(
            serde_json::Map::from_iter([
                ("path".to_owned(), serde_json::json!({ "type": "string", "pattern": "^/" })),
                ("bytes".to_owned(), serde_json::json!({ "type": "array", "maxItems": 4194304, "items": { "type": "integer", "minimum": 0, "maximum": 255 } })),
                ("expectedSha256".to_owned(), serde_json::json!({ "type": ["string", "null"], "pattern": "^[0-9a-f]{64}$" })),
            ]), vec!["path", "bytes"],
        )),
        ("file.rename", "Rename one conflict-checked remote path", with_connection(
            serde_json::Map::from_iter([
                ("path".to_owned(), serde_json::json!({ "type": "string", "pattern": "^/" })),
                ("target".to_owned(), serde_json::json!({ "type": "string", "pattern": "^/" })),
            ]), vec!["path", "target"],
        )),
        ("file.upload_tree", "Atomically upload a small conflict-checked file tree", with_connection(
            serde_json::Map::from_iter([
                ("rootPath".to_owned(), serde_json::json!({ "type": "string", "pattern": "^/" })),
                ("files".to_owned(), serde_json::json!({
                    "type": "array", "maxItems": MAX_UPLOAD_TREE_FILES,
                    "items": {
                        "type": "object", "additionalProperties": false,
                        "required": ["path", "bytes"],
                        "properties": {
                            "path": { "type": "string", "minLength": 1 },
                            "bytes": {
                                "type": "array",
                                "maxItems": MAX_UPLOAD_TREE_BYTES,
                                "items": { "type": "integer", "minimum": 0, "maximum": 255 }
                            }
                        }
                    }
                })),
            ]), vec!["rootPath", "files"],
        )),
        ("systemd.service.start", "Start one validated systemd service", service_schema()),
        ("systemd.service.stop", "Stop one validated systemd service", service_schema()),
        ("systemd.service.restart", "Restart one validated systemd service", service_schema()),
        ("deploy.run", "Deploy a reviewed project release", with_connection(
            serde_json::Map::from_iter([
                ("projectId".to_owned(), serde_json::json!({ "type": "string", "format": "uuid" })),
                ("revision".to_owned(), serde_json::json!({ "type": "string", "minLength": 1, "maxLength": 256 })),
                ("healthUrl".to_owned(), serde_json::json!({ "type": ["string", "null"], "maxLength": 2048 })),
            ]), vec!["projectId", "revision"],
        )),
        ("docker.container.start", "Start one Docker container", container_schema()),
        ("docker.container.stop", "Stop one Docker container", container_schema()),
        ("docker.container.restart", "Restart one Docker container", container_schema()),
        ("docker.container.remove", "Remove one Docker container", container_schema()),
        ("nginx.apply", "Apply a snapshotted and validated Nginx change", with_connection(
            serde_json::Map::from_iter([
                ("livePath".to_owned(), serde_json::json!({ "type": "string", "pattern": "^/" })),
                ("mainConfigPath".to_owned(), serde_json::json!({ "type": "string", "pattern": "^/" })),
                ("candidate".to_owned(), serde_json::json!({ "type": "string", "minLength": 1, "maxLength": 1048576 })),
                ("healthUrl".to_owned(), serde_json::json!({ "type": ["string", "null"], "maxLength": 2048 })),
                ("confirmationTarget".to_owned(), serde_json::json!({ "type": "string", "pattern": "^/" })),
            ]), vec!["livePath", "mainConfigPath", "candidate", "confirmationTarget"],
        )),
    ]
    .into_iter()
    .map(|(name, description, schema)| {
        opspilot_agent_bridge::ToolDescriptor::try_new(name, description, schema)
            .expect("built-in Agent tool descriptor is valid")
    })
    .collect()
}

#[derive(Clone)]
struct ServerOverviewExecutor {
    repository: ServerRepository,
}

const MAX_REMOTE_WRITE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileWriteArgs {
    connection: ConnectionHandle,
    path: String,
    bytes: Vec<u8>,
    expected_sha256: Option<String>,
}

#[derive(Clone)]
struct FileWriteExecutor<S> {
    servers: ServerRepository,
    connections: RusshConnectionManager<S>,
}

#[async_trait]
impl<S> ToolExecutor for FileWriteExecutor<S>
where
    S: SecretStore + 'static,
{
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::new(
            "file.write",
            1,
            ToolEffect::Write {
                minimum_risk: opspilot_domain::RiskLevel::L2,
                snapshot_required: false,
                confirmation_arg: None,
            },
        )
        .expect("built-in file write policy is valid")
    }

    async fn prepare(&self, call: &ToolCall) -> Result<ToolAction, CoreError> {
        let args = parse_file_write_args(&call.args)?;
        validate_connection_scope(call.server_id, &args.connection)?;
        self.servers.get(call.server_id).await?;
        self.verify_precondition(&args).await?;
        Ok(ToolAction::Write(
            opspilot_task_engine::OperationPlan::new(
                call.args.clone(),
                if args.expected_sha256.is_some() {
                    format!("conflict-check and replace remote file {}", args.path)
                } else {
                    format!("create new remote file {}", args.path)
                },
            )
            .with_target_label(&args.path),
        ))
    }

    async fn execute(&self, operation: ApprovedOperation) -> Result<ToolResult, CoreError> {
        let args = parse_file_write_args(operation.args())?;
        validate_connection_scope(operation.server_id(), &args.connection)?;
        self.verify_precondition(&args).await?;

        let session = self.connections.open_sftp(&args.connection).await?;
        let temporary = sibling_operation_path(&args.path, operation.tool_call_id(), "tmp")?;
        let backup = args
            .expected_sha256
            .as_ref()
            .map(|_| sibling_operation_path(&args.path, operation.tool_call_id(), "bak"))
            .transpose()?;
        if session
            .try_exists(&temporary)
            .await
            .map_err(|error| remote_file_error("check temporary file", error))?
        {
            let _ = session.close().await;
            return Err(CoreError::new(
                CoreErrorCode::Conflict,
                "remote temporary file already exists",
                false,
            ));
        }
        let write_result = async {
            let mut file = session
                .create(&temporary)
                .await
                .map_err(|error| remote_file_error("create temporary file", error))?;
            file.write_all(&args.bytes)
                .await
                .map_err(|error| remote_file_error("write temporary file", error))?;
            file.sync_all()
                .await
                .map_err(|error| remote_file_error("sync temporary file", error))?;
            file.shutdown()
                .await
                .map_err(|error| remote_file_error("close temporary file", error))?;

            if let Some(backup) = &backup {
                session
                    .rename(&args.path, backup)
                    .await
                    .map_err(|error| remote_file_error("snapshot existing file", error))?;
            }
            if let Err(error) = session.rename(&temporary, &args.path).await {
                if let Some(backup) = &backup {
                    let _ = session.rename(backup, &args.path).await;
                }
                return Err(remote_file_error("commit remote file", error));
            }
            Ok::<(), CoreError>(())
        }
        .await;
        if write_result.is_err() {
            let _ = session.remove_file(&temporary).await;
        }
        let _ = session.close().await;
        write_result?;
        Ok(ToolResult::new(serde_json::json!({
            "path": args.path,
            "size": args.bytes.len(),
            "sha256": sha256_bytes(&args.bytes),
            "backupPath": backup,
        })))
    }
}

impl<S> FileWriteExecutor<S>
where
    S: SecretStore + 'static,
{
    async fn verify_precondition(&self, args: &FileWriteArgs) -> Result<(), CoreError> {
        RemotePath::try_new(&args.path)?;
        if args.bytes.len() > MAX_REMOTE_WRITE_BYTES {
            return Err(CoreError::new(
                CoreErrorCode::Validation,
                "remote file write exceeds the 4 MiB limit",
                false,
            ));
        }
        if let Some(expected) = &args.expected_sha256 {
            validate_sha256(expected)?;
        }
        let session = self.connections.open_sftp(&args.connection).await?;
        let result = async {
            let exists = session
                .try_exists(&args.path)
                .await
                .map_err(|error| remote_file_error("check remote file", error))?;
            match &args.expected_sha256 {
                None if exists => Err(CoreError::new(
                    CoreErrorCode::Conflict,
                    "remote upload target already exists",
                    false,
                )),
                None => Ok(()),
                Some(_) if !exists => Err(CoreError::new(
                    CoreErrorCode::Conflict,
                    "remote file was removed after it was opened",
                    true,
                )),
                Some(expected) => {
                    let metadata = session
                        .symlink_metadata(&args.path)
                        .await
                        .map_err(|error| remote_file_error("read remote file metadata", error))?;
                    if !metadata.is_regular() || metadata.is_symlink() {
                        return Err(CoreError::new(
                            CoreErrorCode::Validation,
                            "remote write requires a regular non-symlink file",
                            false,
                        ));
                    }
                    if metadata.size.unwrap_or(0) > MAX_REMOTE_WRITE_BYTES as u64 {
                        return Err(CoreError::new(
                            CoreErrorCode::CapabilityUnavailable,
                            "remote file is too large for conflict-checked editing",
                            false,
                        ));
                    }
                    let current = session
                        .read(&args.path)
                        .await
                        .map_err(|error| remote_file_error("read remote file", error))?;
                    if sha256_bytes(&current) != *expected {
                        return Err(CoreError::new(
                            CoreErrorCode::Conflict,
                            "remote file changed after it was opened; reload before saving",
                            true,
                        ));
                    }
                    Ok(())
                }
            }
        }
        .await;
        let _ = session.close().await;
        result
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileRenameArgs {
    connection: ConnectionHandle,
    path: String,
    target: String,
}

#[derive(Clone)]
struct FileRenameExecutor<S> {
    servers: ServerRepository,
    connections: RusshConnectionManager<S>,
}

#[async_trait]
impl<S> ToolExecutor for FileRenameExecutor<S>
where
    S: SecretStore + 'static,
{
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::new(
            "file.rename",
            1,
            ToolEffect::Write {
                minimum_risk: opspilot_domain::RiskLevel::L2,
                snapshot_required: false,
                confirmation_arg: None,
            },
        )
        .expect("built-in file rename policy is valid")
    }

    async fn prepare(&self, call: &ToolCall) -> Result<ToolAction, CoreError> {
        let args = parse_file_rename_args(&call.args)?;
        validate_connection_scope(call.server_id, &args.connection)?;
        self.servers.get(call.server_id).await?;
        self.verify_precondition(&args).await?;
        Ok(ToolAction::Write(
            opspilot_task_engine::OperationPlan::new(
                call.args.clone(),
                format!("rename remote path {} to {}", args.path, args.target),
            )
            .with_target_label(&args.target),
        ))
    }

    async fn execute(&self, operation: ApprovedOperation) -> Result<ToolResult, CoreError> {
        let args = parse_file_rename_args(operation.args())?;
        validate_connection_scope(operation.server_id(), &args.connection)?;
        self.verify_precondition(&args).await?;
        let session = self.connections.open_sftp(&args.connection).await?;
        // SFTP v3 rename 在 OpenSSH 服务器上按 POSIX 语义执行，若检查后目标被并发创建会被静默覆盖；
        // 前置冲突检查与 rename 之间仍存在极小竞态窗口（russh-sftp 未暴露 posix-rename@openssh.com，
        // 无法做到原子"不覆盖"重命名）。这里在 rename 成功后做结果验证，把异常状态暴露给用户而非静默通过。
        let result = async {
            session
                .rename(&args.path, &args.target)
                .await
                .map_err(|error| remote_file_error("rename remote path", error))?;
            if !session
                .try_exists(&args.target)
                .await
                .map_err(|error| remote_file_error("verify remote rename target", error))?
            {
                return Err(CoreError::new(
                    CoreErrorCode::SshConnection,
                    "remote rename committed but the target is missing; verify the remote state",
                    true,
                ));
            }
            Ok(())
        }
        .await;
        let _ = session.close().await;
        result?;
        Ok(ToolResult::new(serde_json::json!({
            "path": args.path,
            "target": args.target,
        })))
    }
}

impl<S> FileRenameExecutor<S>
where
    S: SecretStore + 'static,
{
    async fn verify_precondition(&self, args: &FileRenameArgs) -> Result<(), CoreError> {
        validate_rename_paths(&args.path, &args.target)?;
        let session = self.connections.open_sftp(&args.connection).await?;
        let result = async {
            if !session
                .try_exists(&args.path)
                .await
                .map_err(|error| remote_file_error("check remote rename source", error))?
            {
                return Err(CoreError::new(
                    CoreErrorCode::Conflict,
                    "remote rename source does not exist",
                    true,
                ));
            }
            if session
                .try_exists(&args.target)
                .await
                .map_err(|error| remote_file_error("check remote rename target", error))?
            {
                return Err(CoreError::new(
                    CoreErrorCode::Conflict,
                    "remote rename target already exists",
                    false,
                ));
            }
            Ok(())
        }
        .await;
        let _ = session.close().await;
        result
    }
}

fn validate_rename_paths(path: &str, target: &str) -> Result<(), CoreError> {
    RemotePath::try_new(path)?;
    RemotePath::try_new(target)?;
    Ok(())
}

const MAX_UPLOAD_TREE_FILES: usize = 128;
const MAX_UPLOAD_TREE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UploadTreeFile {
    path: String,
    bytes: Vec<u8>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileUploadTreeArgs {
    connection: ConnectionHandle,
    root_path: String,
    files: Vec<UploadTreeFile>,
}

/// Validate an upload tree offline and return the absolute target path of each file,
/// in the same order as `files`.
fn resolve_upload_tree(
    root_path: &str,
    files: &[UploadTreeFile],
) -> Result<Vec<String>, CoreError> {
    let root = root_path.trim_end_matches('/');
    // "/" alone is rejected by RemotePath but is a legitimate upload root;
    // every joined target is still validated as a RemotePath below.
    if root.is_empty() {
        if root_path.is_empty() {
            RemotePath::try_new(root_path)?;
        }
    } else {
        RemotePath::try_new(root)?;
    }
    if files.is_empty() {
        return Err(CoreError::new(
            CoreErrorCode::Validation,
            "upload tree requires at least one file",
            false,
        ));
    }
    if files.len() > MAX_UPLOAD_TREE_FILES {
        return Err(CoreError::new(
            CoreErrorCode::Validation,
            "upload tree exceeds the 128 file limit",
            false,
        ));
    }
    let total_bytes: usize = files.iter().map(|file| file.bytes.len()).sum();
    if total_bytes > MAX_UPLOAD_TREE_BYTES {
        return Err(CoreError::new(
            CoreErrorCode::Validation,
            "upload tree exceeds the 16 MiB total size limit",
            false,
        ));
    }
    files
        .iter()
        .map(|file| {
            for segment in file.path.split('/') {
                if segment.is_empty()
                    || segment == "."
                    || segment == ".."
                    || segment.contains('\\')
                    || segment.chars().any(char::is_control)
                {
                    return Err(CoreError::new(
                        CoreErrorCode::Validation,
                        format!("upload tree path segment is invalid: {:?}", file.path),
                        false,
                    ));
                }
            }
            let absolute = format!("{root}/{}", file.path);
            RemotePath::try_new(&absolute)?;
            Ok(absolute)
        })
        .collect()
}

#[derive(Clone)]
struct FileUploadTreeExecutor<S> {
    servers: ServerRepository,
    connections: RusshConnectionManager<S>,
}

#[async_trait]
impl<S> ToolExecutor for FileUploadTreeExecutor<S>
where
    S: SecretStore + 'static,
{
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::new(
            "file.upload_tree",
            1,
            ToolEffect::Write {
                minimum_risk: opspilot_domain::RiskLevel::L2,
                snapshot_required: false,
                confirmation_arg: None,
            },
        )
        .expect("built-in upload tree policy is valid")
    }

    async fn prepare(&self, call: &ToolCall) -> Result<ToolAction, CoreError> {
        let args = parse_file_upload_tree_args(&call.args)?;
        let targets = resolve_upload_tree(&args.root_path, &args.files)?;
        validate_connection_scope(call.server_id, &args.connection)?;
        self.servers.get(call.server_id).await?;
        self.verify_precondition(&args, &targets).await?;
        Ok(ToolAction::Write(
            opspilot_task_engine::OperationPlan::new(
                call.args.clone(),
                format!(
                    "upload {} files to remote directory {}",
                    args.files.len(),
                    args.root_path
                ),
            )
            .with_target_label(&args.root_path),
        ))
    }

    async fn execute(&self, operation: ApprovedOperation) -> Result<ToolResult, CoreError> {
        let args = parse_file_upload_tree_args(operation.args())?;
        let targets = resolve_upload_tree(&args.root_path, &args.files)?;
        validate_connection_scope(operation.server_id(), &args.connection)?;
        self.verify_precondition(&args, &targets).await?;

        let session = self.connections.open_sftp(&args.connection).await?;
        let result = self
            .upload_files(&session, &args, &targets, operation.tool_call_id())
            .await;
        let _ = session.close().await;
        result?;
        Ok(ToolResult::new(serde_json::json!({
            "rootPath": args.root_path,
            "uploaded": args.files.len(),
            "bytes": args.files.iter().map(|file| file.bytes.len()).sum::<usize>(),
        })))
    }
}

impl<S> FileUploadTreeExecutor<S>
where
    S: SecretStore + 'static,
{
    async fn verify_precondition(
        &self,
        args: &FileUploadTreeArgs,
        targets: &[String],
    ) -> Result<(), CoreError> {
        let session = self.connections.open_sftp(&args.connection).await?;
        let result = async {
            if !session
                .try_exists(&args.root_path)
                .await
                .map_err(|error| remote_file_error("check remote upload root", error))?
            {
                return Err(CoreError::new(
                    CoreErrorCode::Validation,
                    "remote upload root does not exist",
                    false,
                ));
            }
            let metadata = session
                .symlink_metadata(&args.root_path)
                .await
                .map_err(|error| remote_file_error("read remote upload root metadata", error))?;
            if !metadata.is_dir() {
                return Err(CoreError::new(
                    CoreErrorCode::Validation,
                    "remote upload root is not a directory",
                    false,
                ));
            }
            for target in targets {
                if session
                    .try_exists(target)
                    .await
                    .map_err(|error| remote_file_error("check remote upload target", error))?
                {
                    return Err(CoreError::new(
                        CoreErrorCode::Conflict,
                        format!("remote upload target already exists: {target}"),
                        false,
                    ));
                }
            }
            Ok(())
        }
        .await;
        let _ = session.close().await;
        result
    }

    async fn upload_files(
        &self,
        session: &russh_sftp::client::SftpSession,
        args: &FileUploadTreeArgs,
        targets: &[String],
        operation_id: Id,
    ) -> Result<(), CoreError> {
        // 已提交到最终路径的文件；任一步失败时回滚，兑现"原子上传"的承诺。
        let mut committed: Vec<String> = Vec::new();
        for (file, target) in args.files.iter().zip(targets) {
            self.ensure_parent_directories(session, &args.root_path, &file.path)
                .await?;
            let temporary = sibling_operation_path(target, operation_id, "tmp")?;
            if session
                .try_exists(&temporary)
                .await
                .map_err(|error| remote_file_error("check temporary file", error))?
            {
                return Err(CoreError::new(
                    CoreErrorCode::Conflict,
                    "remote temporary file already exists",
                    false,
                ));
            }
            let write_result = async {
                let mut temporary_file = session
                    .create(&temporary)
                    .await
                    .map_err(|error| remote_file_error("create temporary file", error))?;
                temporary_file
                    .write_all(&file.bytes)
                    .await
                    .map_err(|error| remote_file_error("write temporary file", error))?;
                temporary_file
                    .sync_all()
                    .await
                    .map_err(|error| remote_file_error("sync temporary file", error))?;
                temporary_file
                    .shutdown()
                    .await
                    .map_err(|error| remote_file_error("close temporary file", error))?;
                Self::commit_upload(session, &temporary, target).await?;
                Ok::<(), CoreError>(())
            }
            .await;
            if let Err(error) = write_result {
                let _ = session.remove_file(&temporary).await;
                // 回滚本次操作已经提交的文件，避免失败后残留部分树。
                for committed_target in committed.iter().rev() {
                    let _ = session.remove_file(committed_target).await;
                }
                return Err(CoreError::new(
                    error.code(),
                    format!(
                        "{}; {} previously uploaded file(s) were rolled back",
                        error.message(),
                        committed.len()
                    ),
                    error.is_retryable(),
                ));
            }
            committed.push(target.clone());
        }
        Ok(())
    }

    /// Commit `temporary` to `target` without ever overwriting an existing file.
    ///
    /// 优先走 `hardlink@openssh.com`（POSIX `link(2)`，目标已存在时原子失败），随后删除临时文件：
    /// 在 OpenSSH 服务器上是无竞态的原子提交。服务器未声明该扩展时（`Ok(false)`），退化为
    /// "recheck + rename"，此时检查与 rename 之间仍存在已知的小竞态窗口（russh-sftp 2.3.0
    /// 未暴露 posix-rename@openssh.com 扩展请求）。
    async fn commit_upload(
        session: &russh_sftp::client::SftpSession,
        temporary: &str,
        target: &str,
    ) -> Result<(), CoreError> {
        match session.hardlink(temporary, target).await {
            Ok(true) => {
                let _ = session.remove_file(temporary).await;
                Ok(())
            }
            Ok(false) => {
                // 服务器不支持 hardlink 扩展：退化路径，提交前再次确认目标不存在。
                if session
                    .try_exists(target)
                    .await
                    .map_err(|error| remote_file_error("recheck remote upload target", error))?
                {
                    return Err(CoreError::new(
                        CoreErrorCode::Conflict,
                        format!("remote upload target already exists: {target}"),
                        false,
                    ));
                }
                session
                    .rename(temporary, target)
                    .await
                    .map_err(|error| remote_file_error("commit remote file", error))
            }
            Err(error) => {
                // hardlink 失败：目标已存在判定为冲突，否则透传远端错误。
                if session
                    .try_exists(target)
                    .await
                    .map_err(|error| remote_file_error("check remote upload target", error))?
                {
                    return Err(CoreError::new(
                        CoreErrorCode::Conflict,
                        format!("remote upload target already exists: {target}"),
                        false,
                    ));
                }
                Err(remote_file_error("commit remote file", error))
            }
        }
    }

    async fn ensure_parent_directories(
        &self,
        session: &russh_sftp::client::SftpSession,
        root_path: &str,
        relative_path: &str,
    ) -> Result<(), CoreError> {
        let root = root_path.trim_end_matches('/');
        let mut prefix = root.to_owned();
        let segments: Vec<&str> = relative_path.split('/').collect();
        for segment in &segments[..segments.len().saturating_sub(1)] {
            prefix = format!("{prefix}/{segment}");
            if let Err(error) = session.create_dir(&prefix).await {
                // Tolerate a directory that already exists; fail otherwise.
                let is_dir = session
                    .symlink_metadata(&prefix)
                    .await
                    .map(|metadata| metadata.is_dir())
                    .unwrap_or(false);
                if !is_dir {
                    return Err(remote_file_error("create remote directory", error));
                }
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeployRunArgs {
    connection: ConnectionHandle,
    project_id: Id,
    revision: String,
    health_url: Option<String>,
}

#[derive(Clone)]
struct ReleaseDeployExecutor<S> {
    projects: ProjectRepository,
    deployer: ReleaseDeployer<RemoteExecutor<S>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DockerContainerActionArgs {
    connection: ConnectionHandle,
    container: String,
}

#[derive(Clone)]
struct DockerContainerActionExecutor<S> {
    name: &'static str,
    action: &'static str,
    risk: opspilot_domain::RiskLevel,
    servers: ServerRepository,
    adapter: DockerCliAdapter<RemoteExecutor<S>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServiceActionArgs {
    connection: ConnectionHandle,
    unit: String,
}

#[derive(Clone)]
struct SystemdServiceActionExecutor<S> {
    name: &'static str,
    action: ServiceAction,
    servers: ServerRepository,
    remote: RemoteExecutor<S>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NginxApplyArgs {
    connection: ConnectionHandle,
    live_path: String,
    main_config_path: String,
    candidate: String,
    health_url: Option<String>,
    confirmation_target: String,
}

#[derive(Clone)]
struct NginxApplyExecutor<S> {
    servers: ServerRepository,
    adapter: NginxAdapter<RemoteExecutor<S>>,
}

#[async_trait]
impl<S> ToolExecutor for NginxApplyExecutor<S>
where
    S: SecretStore + 'static,
{
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::new(
            "nginx.apply",
            1,
            ToolEffect::Write {
                minimum_risk: opspilot_domain::RiskLevel::L3,
                snapshot_required: true,
                confirmation_arg: Some("confirmationTarget".to_owned()),
            },
        )
        .expect("built-in Nginx policy is valid")
    }

    async fn prepare(&self, call: &ToolCall) -> Result<ToolAction, CoreError> {
        let args = parse_nginx_args(&call.args)?;
        validate_connection_scope(call.server_id, &args.connection)?;
        self.servers.get(call.server_id).await?;
        if args.confirmation_target != args.live_path {
            return Err(CoreError::new(
                CoreErrorCode::ApprovalMismatch,
                "Nginx confirmation target must match the live path",
                false,
            ));
        }
        NginxApplyPlan::try_new(
            call.tool_call_id,
            &args.live_path,
            &args.main_config_path,
            args.candidate.into_bytes(),
            args.health_url.as_deref(),
        )?;
        Ok(ToolAction::Write(
            opspilot_task_engine::OperationPlan::new(
                call.args.clone(),
                format!(
                    "snapshot, validate, atomically replace, reload, and health-check {}",
                    args.live_path
                ),
            )
            .with_target_label(&args.live_path),
        ))
    }

    async fn execute(&self, operation: ApprovedOperation) -> Result<ToolResult, CoreError> {
        let args = parse_nginx_args(operation.args())?;
        validate_connection_scope(operation.server_id(), &args.connection)?;
        if args.confirmation_target != args.live_path {
            return Err(CoreError::new(
                CoreErrorCode::ApprovalMismatch,
                "Nginx confirmation target must match the live path",
                false,
            ));
        }
        let plan = NginxApplyPlan::try_new(
            operation.tool_call_id(),
            &args.live_path,
            &args.main_config_path,
            args.candidate.into_bytes(),
            args.health_url.as_deref(),
        )?;
        let result = self.adapter.apply(&args.connection, &plan).await?;
        serde_json::to_value(result)
            .map(ToolResult::new)
            .map_err(|error| {
                CoreError::new(
                    CoreErrorCode::Internal,
                    format!("failed to serialize Nginx result: {error}"),
                    false,
                )
            })
    }
}

#[async_trait]
impl<S> ToolExecutor for SystemdServiceActionExecutor<S>
where
    S: SecretStore + 'static,
{
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::new(
            self.name,
            1,
            ToolEffect::Write {
                minimum_risk: opspilot_domain::RiskLevel::L2,
                snapshot_required: false,
                confirmation_arg: None,
            },
        )
        .expect("built-in systemd action policy is valid")
    }

    async fn prepare(&self, call: &ToolCall) -> Result<ToolAction, CoreError> {
        let args = parse_service_action_args(&call.args)?;
        validate_connection_scope(call.server_id, &args.connection)?;
        self.servers.get(call.server_id).await?;
        SystemdAdapter::action_command(&args.unit, self.action)?;
        Ok(ToolAction::Write(
            opspilot_task_engine::OperationPlan::new(
                call.args.clone(),
                format!("{} systemd service {}", self.name, args.unit),
            )
            .with_target_label(&args.unit),
        ))
    }

    async fn execute(&self, operation: ApprovedOperation) -> Result<ToolResult, CoreError> {
        let args = parse_service_action_args(operation.args())?;
        validate_connection_scope(operation.server_id(), &args.connection)?;
        let output = self
            .remote
            .execute(
                &args.connection,
                SystemdAdapter::action_command(&args.unit, self.action)?,
            )
            .await?;
        if output.exit_status != 0 {
            return Err(CoreError::new(
                CoreErrorCode::RemoteCommand,
                format!("systemd action exited with status {}", output.exit_status),
                false,
            ));
        }
        Ok(ToolResult::new(serde_json::json!({ "ok": true })))
    }
}

#[async_trait]
impl<S> ToolExecutor for DockerContainerActionExecutor<S>
where
    S: SecretStore + 'static,
{
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::new(
            self.name,
            1,
            ToolEffect::Write {
                minimum_risk: self.risk,
                snapshot_required: false,
                confirmation_arg: None,
            },
        )
        .expect("built-in Docker action policy is valid")
    }

    async fn prepare(&self, call: &ToolCall) -> Result<ToolAction, CoreError> {
        let args = parse_docker_action_args(&call.args)?;
        validate_connection_scope(call.server_id, &args.connection)?;
        self.servers.get(call.server_id).await?;
        ContainerIdentifier::try_new(&args.container)?;
        Ok(ToolAction::Write(
            opspilot_task_engine::OperationPlan::new(
                call.args.clone(),
                format!("{} Docker container {}", self.action, args.container),
            )
            .with_target_label(&args.container),
        ))
    }

    async fn execute(&self, operation: ApprovedOperation) -> Result<ToolResult, CoreError> {
        let args = parse_docker_action_args(operation.args())?;
        validate_connection_scope(operation.server_id(), &args.connection)?;
        let container = ContainerIdentifier::try_new(&args.container)?;
        self.adapter
            .container_action(&args.connection, self.action, &container)
            .await?;
        Ok(ToolResult::new(serde_json::json!({ "ok": true })))
    }
}

#[async_trait]
impl<S> ToolExecutor for ReleaseDeployExecutor<S>
where
    S: SecretStore + 'static,
{
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::new(
            "deploy.run",
            1,
            ToolEffect::Write {
                minimum_risk: opspilot_domain::RiskLevel::L2,
                snapshot_required: false,
                confirmation_arg: None,
            },
        )
        .expect("built-in deployment policy is valid")
    }

    async fn prepare(&self, call: &ToolCall) -> Result<ToolAction, CoreError> {
        let args = parse_deploy_args(&call.args)?;
        let project = self.projects.get(args.project_id).await?;
        validate_deploy_scope(call.server_id, &args.connection, &project)?;
        let plan = self.deployer.plan(
            &project,
            call.tool_call_id,
            GitRevision::try_new(&args.revision)?,
            args.health_url.as_deref(),
        )?;
        Ok(ToolAction::Write(
            opspilot_task_engine::OperationPlan::new(
                call.args.clone(),
                format!("{}; {} commands", plan.impact_summary, plan.commands.len()),
            )
            .with_target_label(&project.name),
        ))
    }

    async fn execute(&self, operation: ApprovedOperation) -> Result<ToolResult, CoreError> {
        let args = parse_deploy_args(operation.args())?;
        let project = self.projects.get(args.project_id).await?;
        validate_deploy_scope(operation.server_id(), &args.connection, &project)?;
        let plan = self.deployer.plan(
            &project,
            operation.tool_call_id(),
            GitRevision::try_new(&args.revision)?,
            args.health_url.as_deref(),
        )?;
        let result = self.deployer.run(&args.connection, &project, &plan).await?;
        serde_json::to_value(result)
            .map(ToolResult::new)
            .map_err(|error| {
                CoreError::new(
                    CoreErrorCode::Internal,
                    format!("failed to serialize deployment result: {error}"),
                    false,
                )
            })
    }
}

fn parse_deploy_args(value: &serde_json::Value) -> Result<DeployRunArgs, CoreError> {
    serde_json::from_value(value.clone()).map_err(|error| {
        CoreError::new(
            CoreErrorCode::Validation,
            format!("deployment arguments are invalid: {error}"),
            false,
        )
    })
}

fn parse_file_write_args(value: &serde_json::Value) -> Result<FileWriteArgs, CoreError> {
    serde_json::from_value(value.clone()).map_err(|error| {
        CoreError::new(
            CoreErrorCode::Validation,
            format!("file write arguments are invalid: {error}"),
            false,
        )
    })
}

fn parse_file_rename_args(value: &serde_json::Value) -> Result<FileRenameArgs, CoreError> {
    serde_json::from_value(value.clone()).map_err(|error| {
        CoreError::new(
            CoreErrorCode::Validation,
            format!("file rename arguments are invalid: {error}"),
            false,
        )
    })
}

fn parse_file_upload_tree_args(value: &serde_json::Value) -> Result<FileUploadTreeArgs, CoreError> {
    serde_json::from_value(value.clone()).map_err(|error| {
        CoreError::new(
            CoreErrorCode::Validation,
            format!("upload tree arguments are invalid: {error}"),
            false,
        )
    })
}

fn validate_sha256(value: &str) -> Result<(), CoreError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(CoreError::new(
            CoreErrorCode::Validation,
            "expected file digest must be a lowercase SHA-256 value",
            false,
        ));
    }
    Ok(())
}

fn sha256_bytes(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn sibling_operation_path(path: &str, operation_id: Id, suffix: &str) -> Result<String, CoreError> {
    let path = RemotePath::try_new(path)?;
    let (parent, _) = path.as_str().rsplit_once('/').ok_or_else(|| {
        CoreError::new(CoreErrorCode::Validation, "remote path is invalid", false)
    })?;
    Ok(if parent.is_empty() {
        format!("/.opspilot-{operation_id}.{suffix}")
    } else {
        format!("{parent}/.opspilot-{operation_id}.{suffix}")
    })
}

fn remote_file_error(context: &str, error: impl std::fmt::Display) -> CoreError {
    CoreError::new(
        CoreErrorCode::SshConnection,
        format!("failed to {context}: {error}"),
        true,
    )
}

fn validate_deploy_scope(
    server_id: Id,
    connection: &ConnectionHandle,
    project: &opspilot_domain::ProjectSummary,
) -> Result<(), CoreError> {
    if server_id != project.server_id || connection.server_id() != server_id {
        return Err(CoreError::new(
            CoreErrorCode::ToolScopeViolation,
            "deployment tool call, project, and SSH connection do not share a server",
            false,
        ));
    }
    Ok(())
}

fn parse_docker_action_args(
    value: &serde_json::Value,
) -> Result<DockerContainerActionArgs, CoreError> {
    serde_json::from_value(value.clone()).map_err(|error| {
        CoreError::new(
            CoreErrorCode::Validation,
            format!("Docker action arguments are invalid: {error}"),
            false,
        )
    })
}

fn parse_service_action_args(value: &serde_json::Value) -> Result<ServiceActionArgs, CoreError> {
    serde_json::from_value(value.clone()).map_err(|error| {
        CoreError::new(
            CoreErrorCode::Validation,
            format!("systemd action arguments are invalid: {error}"),
            false,
        )
    })
}

fn parse_nginx_args(value: &serde_json::Value) -> Result<NginxApplyArgs, CoreError> {
    serde_json::from_value(value.clone()).map_err(|error| {
        CoreError::new(
            CoreErrorCode::Validation,
            format!("Nginx apply arguments are invalid: {error}"),
            false,
        )
    })
}

fn validate_connection_scope(
    server_id: Id,
    connection: &ConnectionHandle,
) -> Result<(), CoreError> {
    if connection.server_id() != server_id {
        return Err(CoreError::new(
            CoreErrorCode::ToolScopeViolation,
            "tool call and SSH connection do not share a server",
            false,
        ));
    }
    Ok(())
}

#[async_trait]
impl ToolExecutor for ServerOverviewExecutor {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::new("server.overview", 1, ToolEffect::Read)
            .expect("built-in tool definition is valid")
    }

    async fn prepare(&self, call: &ToolCall) -> Result<ToolAction, CoreError> {
        if call.args != serde_json::json!({}) {
            return Err(CoreError::new(
                CoreErrorCode::Validation,
                "server overview does not accept arguments",
                false,
            ));
        }
        let server = self.repository.get(call.server_id).await?;
        let value = serde_json::to_value(server).map_err(|error| {
            CoreError::new(
                CoreErrorCode::Internal,
                format!("failed to serialize server overview: {error}"),
                false,
            )
        })?;
        Ok(ToolAction::Read(ToolResult::new(value)))
    }

    async fn execute(&self, _operation: ApprovedOperation) -> Result<ToolResult, CoreError> {
        Err(CoreError::new(
            CoreErrorCode::Internal,
            "read-only tools cannot enter the approved write executor",
            false,
        ))
    }
}

#[cfg(test)]
pub(super) fn operation_gateway(database: Database) -> Result<SqliteOperationGateway, CoreError> {
    let catalog = ToolCatalog::new().register(ServerOverviewExecutor {
        repository: ServerRepository::new(database.clone()),
    })?;
    Ok(SqliteOperationGateway::new(database, catalog))
}

pub(super) fn operation_gateway_with_remote<S>(
    database: Database,
    connections: RusshConnectionManager<S>,
) -> Result<SqliteOperationGateway, CoreError>
where
    S: SecretStore + 'static,
{
    let remote = RemoteExecutor::new(connections.clone());
    let docker = DockerCliAdapter::new(remote.clone());
    let nginx = NginxAdapter::new(remote.clone());
    let servers = ServerRepository::new(database.clone());
    let catalog = ToolCatalog::new()
        .register(ServerOverviewExecutor {
            repository: servers.clone(),
        })?
        .register(FileWriteExecutor {
            servers: servers.clone(),
            connections: connections.clone(),
        })?
        .register(FileRenameExecutor {
            servers: servers.clone(),
            connections: connections.clone(),
        })?
        .register(FileUploadTreeExecutor {
            servers: servers.clone(),
            connections,
        })?
        .register(ReleaseDeployExecutor {
            projects: ProjectRepository::new(database.clone()),
            deployer: ReleaseDeployer::new(remote.clone()),
        })?
        .register(DockerContainerActionExecutor {
            name: "docker.container.start",
            action: "start",
            risk: opspilot_domain::RiskLevel::L1,
            servers: servers.clone(),
            adapter: docker.clone(),
        })?
        .register(DockerContainerActionExecutor {
            name: "docker.container.stop",
            action: "stop",
            risk: opspilot_domain::RiskLevel::L2,
            servers: servers.clone(),
            adapter: docker.clone(),
        })?
        .register(DockerContainerActionExecutor {
            name: "docker.container.restart",
            action: "restart",
            risk: opspilot_domain::RiskLevel::L2,
            servers: servers.clone(),
            adapter: docker.clone(),
        })?
        .register(DockerContainerActionExecutor {
            name: "docker.container.remove",
            action: "rm",
            risk: opspilot_domain::RiskLevel::L2,
            servers: servers.clone(),
            adapter: docker,
        })?
        .register(SystemdServiceActionExecutor {
            name: "systemd.service.start",
            action: ServiceAction::Start,
            servers: servers.clone(),
            remote: remote.clone(),
        })?
        .register(SystemdServiceActionExecutor {
            name: "systemd.service.stop",
            action: ServiceAction::Stop,
            servers: servers.clone(),
            remote: remote.clone(),
        })?
        .register(SystemdServiceActionExecutor {
            name: "systemd.service.restart",
            action: ServiceAction::Restart,
            servers: servers.clone(),
            remote: remote.clone(),
        })?
        .register(NginxApplyExecutor {
            servers,
            adapter: nginx,
        })?;
    Ok(SqliteOperationGateway::new(database, catalog))
}

pub(super) async fn prepare_manual_operation(
    gateway: &SqliteOperationGateway,
    window_id: &str,
    call: ToolCall,
) -> Result<PrepareResult, CoreError> {
    gateway
        .prepare(
            call.clone(),
            OperationActor::Manual {
                manual_run_id: call.run_id,
                window_id: window_id.to_owned(),
            },
        )
        .await
}

#[tauri::command]
pub(crate) async fn operation_prepare(
    window: WebviewWindow,
    services: State<'_, CoreServices>,
    call: ToolCall,
) -> Result<PrepareResult, CoreError> {
    prepare_manual_operation(&services.operation_gateway, window.label(), call).await
}

#[tauri::command]
pub(crate) async fn operation_approve(
    services: State<'_, CoreServices>,
    proof: ApprovalProof,
) -> Result<TaskRef, CoreError> {
    services.operation_gateway.approve_and_submit(proof).await
}

#[tauri::command]
pub(crate) async fn operation_reject(
    services: State<'_, CoreServices>,
    approval_id: Id,
) -> Result<(), CoreError> {
    services.operation_gateway.reject(approval_id).await
}

#[tauri::command]
pub(crate) async fn operation_status(
    services: State<'_, CoreServices>,
    tool_call_id: Id,
) -> Result<OperationState, CoreError> {
    services.operation_gateway.status(tool_call_id).await
}

#[cfg(test)]
mod tests {
    use opspilot_domain::{AuthType, CoreErrorCode, Id, ServerEnvironment, ServerInput, ToolCall};
    use opspilot_persistence::{Database, ServerRepository};
    use opspilot_task_engine::{OperationGateway, OperationState, PrepareResult};

    use super::{
        MAX_UPLOAD_TREE_BYTES, MAX_UPLOAD_TREE_FILES, UploadTreeFile, agent_tool_descriptors,
        operation_gateway, prepare_manual_operation, resolve_upload_tree, validate_rename_paths,
    };

    #[test]
    fn agent_write_tools_publish_their_real_required_argument_schema() {
        let tools = agent_tool_descriptors();
        let nginx = tools
            .iter()
            .find(|tool| tool.name == "nginx.apply")
            .unwrap();
        let required = nginx.input_schema["required"].as_array().unwrap();
        for field in [
            "connection",
            "livePath",
            "mainConfigPath",
            "candidate",
            "confirmationTarget",
        ] {
            assert!(required.iter().any(|value| value == field));
        }
        assert_eq!(nginx.input_schema["additionalProperties"], false);

        let rename = tools
            .iter()
            .find(|tool| tool.name == "file.rename")
            .unwrap();
        let required = rename.input_schema["required"].as_array().unwrap();
        for field in ["connection", "path", "target"] {
            assert!(required.iter().any(|value| value == field));
        }
        assert_eq!(rename.input_schema["additionalProperties"], false);

        let upload_tree = tools
            .iter()
            .find(|tool| tool.name == "file.upload_tree")
            .unwrap();
        let required = upload_tree.input_schema["required"].as_array().unwrap();
        for field in ["connection", "rootPath", "files"] {
            assert!(required.iter().any(|value| value == field));
        }
        assert_eq!(upload_tree.input_schema["additionalProperties"], false);
        let files = &upload_tree.input_schema["properties"]["files"];
        assert_eq!(files["maxItems"], MAX_UPLOAD_TREE_FILES);
        assert_eq!(files["items"]["additionalProperties"], false);
        let item_required = files["items"]["required"].as_array().unwrap();
        for field in ["path", "bytes"] {
            assert!(item_required.iter().any(|value| value == field));
        }
        assert_eq!(
            files["items"]["properties"]["bytes"]["maxItems"],
            MAX_UPLOAD_TREE_BYTES
        );
    }

    fn upload_file(path: &str, bytes: &[u8]) -> UploadTreeFile {
        UploadTreeFile {
            path: path.to_owned(),
            bytes: bytes.to_vec(),
        }
    }

    #[test]
    fn resolve_upload_tree_accepts_nested_relative_paths() {
        let files = vec![
            upload_file("index.html", b"<html>"),
            upload_file("assets/css/site.css", b"body{}"),
        ];
        let targets = resolve_upload_tree("/var/www/site", &files).unwrap();
        assert_eq!(
            targets,
            vec![
                "/var/www/site/index.html".to_owned(),
                "/var/www/site/assets/css/site.css".to_owned()
            ]
        );
        let targets = resolve_upload_tree("/var/www/site/", &files[..1]).unwrap();
        assert_eq!(targets, vec!["/var/www/site/index.html".to_owned()]);
    }

    #[test]
    fn resolve_upload_tree_accepts_filesystem_root() {
        let files = vec![upload_file("bundle/a.txt", b"x")];
        let targets = resolve_upload_tree("/", &files).unwrap();
        assert_eq!(targets, vec!["/bundle/a.txt".to_owned()]);
        let error = resolve_upload_tree("", &files).unwrap_err();
        assert_eq!(error.code(), CoreErrorCode::Validation);
    }

    #[test]
    fn resolve_upload_tree_rejects_unsafe_relative_paths() {
        for path in [
            "../escape.txt",
            "a/../../escape.txt",
            "a\\b.txt",
            "a//b.txt",
            "/leading.txt",
            ".",
            "a/./b.txt",
            "con\ttrol.txt",
            "",
        ] {
            let files = vec![upload_file(path, b"x")];
            let error = resolve_upload_tree("/srv/app", &files).unwrap_err();
            assert_eq!(error.code(), CoreErrorCode::Validation, "path: {path:?}");
        }
    }

    #[test]
    fn resolve_upload_tree_enforces_count_and_size_limits() {
        let error = resolve_upload_tree("/srv/app", &[]).unwrap_err();
        assert_eq!(error.code(), CoreErrorCode::Validation);

        let too_many = vec![upload_file("f.txt", b"x"); 129];
        let error = resolve_upload_tree("/srv/app", &too_many).unwrap_err();
        assert_eq!(error.code(), CoreErrorCode::Validation);

        let too_large = vec![upload_file("big.bin", &vec![0u8; 16 * 1024 * 1024 + 1])];
        let error = resolve_upload_tree("/srv/app", &too_large).unwrap_err();
        assert_eq!(error.code(), CoreErrorCode::Validation);

        let split_too_large = vec![
            upload_file("a.bin", &vec![0u8; 10 * 1024 * 1024]),
            upload_file("b.bin", &vec![0u8; 7 * 1024 * 1024]),
        ];
        let error = resolve_upload_tree("/srv/app", &split_too_large).unwrap_err();
        assert_eq!(error.code(), CoreErrorCode::Validation);
    }

    #[test]
    fn file_rename_rejects_non_absolute_paths_before_touching_sftp() {
        assert!(validate_rename_paths("/etc/app.conf", "/etc/app.conf.bak").is_ok());
        for (path, target) in [
            ("relative.conf", "/etc/app.conf"),
            ("/etc/app.conf", "relative.conf"),
            ("/etc/../etc/app.conf", "/etc/app.conf"),
        ] {
            assert!(validate_rename_paths(path, target).is_err());
        }
    }

    #[tokio::test]
    async fn server_overview_runs_through_the_shared_gateway() {
        let database = Database::open(":memory:").await.unwrap();
        let server = ServerRepository::new(database.clone())
            .create(
                ServerInput::try_new(
                    "Production",
                    "prod.example.com",
                    22,
                    "deploy",
                    ServerEnvironment::Production,
                    AuthType::SshAgent,
                    None,
                    vec![],
                )
                .unwrap(),
            )
            .await
            .unwrap();
        let gateway = operation_gateway(database).unwrap();
        let call = ToolCall {
            tool_call_id: Id::new(),
            run_id: Id::new(),
            server_id: server.id,
            name: "server.overview".to_owned(),
            schema_version: 1,
            args: serde_json::json!({}),
        };

        let result = prepare_manual_operation(&gateway, "main", call.clone())
            .await
            .unwrap();
        assert!(matches!(result, PrepareResult::ReadCompleted { .. }));
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(value["kind"], "read_completed");
        assert_eq!(value["tool_call_id"], serde_json::Value::Null);
        assert_eq!(value["toolCallId"], call.tool_call_id.to_string());
        assert_eq!(value["result"]["name"], "Production");
        assert_eq!(
            gateway.status(call.tool_call_id).await.unwrap(),
            OperationState::ReadCompleted
        );
    }
}
