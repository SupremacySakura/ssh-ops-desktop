use opspilot_domain::CoreError;
use opspilot_remote_adapters::{NginxAdapter, NginxPath, RemoteExecutor};
use opspilot_ssh_core::ConnectionHandle;
use serde::Deserialize;
use tauri::AppHandle;

use super::services;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NginxReadRequest {
    connection: ConnectionHandle,
    path: String,
}

fn adapter(app: &AppHandle) -> NginxAdapter<RemoteExecutor<opspilot_secrets::KeyringSecretStore>> {
    NginxAdapter::new(RemoteExecutor::new(services(app).connection_manager))
}

#[tauri::command]
pub(crate) async fn nginx_discover(
    app: AppHandle,
    connection: ConnectionHandle,
) -> Result<String, CoreError> {
    adapter(&app).discover(&connection).await
}

#[tauri::command]
pub(crate) async fn nginx_read(
    app: AppHandle,
    request: NginxReadRequest,
) -> Result<Vec<u8>, CoreError> {
    adapter(&app)
        .read(&request.connection, &NginxPath::try_new(&request.path)?)
        .await
}
