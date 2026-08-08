use opspilot_audit::AuditEvent;
use opspilot_domain::CoreError;
use opspilot_remote_adapters::{
    ContainerIdentifier, DockerCliAdapter, DockerContainer, DockerStats, DockerVersion,
    RemoteExecutor,
};
use opspilot_ssh_core::{ConnectionHandle, PtySize, TerminalCommand, TerminalSession};
use serde::Deserialize;
use tauri::AppHandle;

use super::services;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DockerListRequest {
    connection: ConnectionHandle,
    include_stopped: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DockerContainerRequest {
    connection: ConnectionHandle,
    container: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DockerLogsRequest {
    connection: ConnectionHandle,
    container: String,
    tail: u32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DockerExecRequest {
    connection: ConnectionHandle,
    container: String,
    columns: u32,
    rows: u32,
}

fn adapter(
    app: &AppHandle,
) -> DockerCliAdapter<RemoteExecutor<opspilot_secrets::KeyringSecretStore>> {
    DockerCliAdapter::new(RemoteExecutor::new(services(app).connection_manager))
}

#[tauri::command]
pub(crate) async fn docker_version(
    app: AppHandle,
    connection: ConnectionHandle,
) -> Result<DockerVersion, CoreError> {
    adapter(&app).version(&connection).await
}

#[tauri::command]
pub(crate) async fn docker_container_list(
    app: AppHandle,
    request: DockerListRequest,
) -> Result<Vec<DockerContainer>, CoreError> {
    adapter(&app)
        .list_containers(&request.connection, request.include_stopped)
        .await
}

#[tauri::command]
pub(crate) async fn docker_container_logs(
    app: AppHandle,
    request: DockerLogsRequest,
) -> Result<String, CoreError> {
    adapter(&app)
        .logs(
            &request.connection,
            &ContainerIdentifier::try_new(&request.container)?,
            request.tail,
        )
        .await
}

#[tauri::command]
pub(crate) async fn docker_container_stats(
    app: AppHandle,
    request: DockerContainerRequest,
) -> Result<DockerStats, CoreError> {
    adapter(&app)
        .stats(
            &request.connection,
            &ContainerIdentifier::try_new(&request.container)?,
        )
        .await
}

#[tauri::command]
pub(crate) async fn docker_container_exec(
    app: AppHandle,
    request: DockerExecRequest,
) -> Result<TerminalSession, CoreError> {
    let container = ContainerIdentifier::try_new(&request.container)?;
    let command =
        TerminalCommand::try_new(format!("docker exec -it -- {} sh", container.as_str()))?;
    let core = services(&app);
    let session = core
        .terminal_manager
        .open_command(
            request.connection.clone(),
            PtySize::try_new(request.columns, request.rows)?,
            command,
        )
        .await?;
    if let Err(error) = core
        .audit_writer
        .append(
            AuditEvent::new(
                "docker.container.exec",
                "container",
                "success",
                serde_json::json!({ "container": container.as_str() }),
            )
            .with_server_id(request.connection.server_id().to_string()),
        )
        .await
    {
        let _ = core.terminal_manager.close(session.id()).await;
        return Err(error);
    }
    Ok(session)
}
