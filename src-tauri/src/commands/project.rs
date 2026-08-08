use opspilot_domain::{
    CoreError, DeployStrategy, Id, ProjectInput, ProjectRoot, ProjectSummary, RuntimeType,
};
use opspilot_persistence::ProjectRepository;
use opspilot_remote_adapters::{ProjectDetection, ProjectDetector, RemoteExecutor};
use opspilot_ssh_core::ConnectionHandle;
use serde::Deserialize;
use tauri::{AppHandle, State};

use super::{CoreServices, services};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProjectDetectRequest {
    connection: ConnectionHandle,
    root_path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProjectCreateRequest {
    server_id: Id,
    name: String,
    root_path: String,
    repository_url: Option<String>,
    runtime: RuntimeType,
    deploy_strategy: DeployStrategy,
}

#[tauri::command]
pub(crate) async fn project_detect(
    app: AppHandle,
    request: ProjectDetectRequest,
) -> Result<ProjectDetection, CoreError> {
    let services = services(&app);
    let root = ProjectRoot::try_new(&request.root_path)?;
    ProjectDetector
        .detect_remote(
            &RemoteExecutor::new(services.connection_manager),
            &request.connection,
            &root,
        )
        .await
}

#[tauri::command]
pub(crate) async fn project_create(
    services: State<'_, CoreServices>,
    request: ProjectCreateRequest,
) -> Result<ProjectSummary, CoreError> {
    let input = ProjectInput::try_new(
        request.server_id,
        &request.name,
        &request.root_path,
        request.repository_url.as_deref(),
        request.runtime,
        request.deploy_strategy,
    )?;
    ProjectRepository::new(services.database.clone())
        .create(input)
        .await
}

#[tauri::command]
pub(crate) async fn project_list(
    services: State<'_, CoreServices>,
    server_id: Id,
) -> Result<Vec<ProjectSummary>, CoreError> {
    ProjectRepository::new(services.database.clone())
        .list_for_server(server_id)
        .await
}
