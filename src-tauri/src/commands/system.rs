use opspilot_domain::CoreError;
use opspilot_remote_adapters::{
    LinuxMetrics, ListeningPort, OsRelease, RemoteExecutor, RemoteLinuxAdapter, SystemService,
};
use opspilot_ssh_core::ConnectionHandle;
use tauri::AppHandle;

use super::services;

fn adapter(app: &AppHandle) -> RemoteLinuxAdapter<opspilot_secrets::KeyringSecretStore> {
    RemoteLinuxAdapter::new(RemoteExecutor::new(
        services(app).connection_manager.clone(),
    ))
}

#[tauri::command]
pub(crate) async fn system_probe(
    app: AppHandle,
    connection: ConnectionHandle,
) -> Result<OsRelease, CoreError> {
    adapter(&app).probe(&connection).await
}

#[tauri::command]
pub(crate) async fn system_metrics(
    app: AppHandle,
    connection: ConnectionHandle,
) -> Result<LinuxMetrics, CoreError> {
    adapter(&app).metrics(&connection).await
}

#[tauri::command]
pub(crate) async fn system_ports(
    app: AppHandle,
    connection: ConnectionHandle,
) -> Result<Vec<ListeningPort>, CoreError> {
    adapter(&app).ports(&connection).await
}

#[tauri::command]
pub(crate) async fn system_services(
    app: AppHandle,
    connection: ConnectionHandle,
) -> Result<Vec<SystemService>, CoreError> {
    adapter(&app).services(&connection).await
}
