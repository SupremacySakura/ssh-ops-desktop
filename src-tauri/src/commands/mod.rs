use std::sync::Arc;

use opspilot_audit::{AuditWriter, Redactor};
use opspilot_persistence::Database;
use opspilot_secrets::{KeyringSecretStore, SecretStore};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

mod agent;
mod connection;
mod docker;
mod file;
mod health;
mod model;
mod nginx;
mod operation;
mod project;
mod server;
mod system;
mod task;

pub(crate) use agent::{
    agent_catalog, agent_run_start, agent_run_status, agent_status, agent_thread_create,
    agent_thread_list,
};
pub(crate) use connection::{
    connection_connect, connection_disconnect, connection_trust_host_key, terminal_close,
    terminal_open, terminal_resize, terminal_write, tunnel_close, tunnel_list, tunnel_open,
};
pub(crate) use docker::{
    docker_container_exec, docker_container_list, docker_container_logs, docker_container_stats,
    docker_version,
};
pub(crate) use file::{file_download, file_list, file_read};
pub(crate) use health::core_health;
pub(crate) use model::{
    model_profile_delete, model_profile_list, model_profile_save, model_profile_test_connection,
};
pub(crate) use nginx::{nginx_discover, nginx_read};
pub(crate) use operation::{
    operation_approve, operation_prepare, operation_reject, operation_status,
};
pub(crate) use project::{project_create, project_detect, project_list};
pub(crate) use server::{
    server_create, server_credential_set, server_delete, server_group_create, server_group_delete,
    server_group_list, server_group_update, server_import_apply, server_import_preview,
    server_list, server_tag_create, server_tag_delete, server_tag_list, server_tag_update,
    server_update,
};
pub(crate) use system::{system_metrics, system_ports, system_probe, system_services};
pub(crate) use task::{audit_list, task_events_since, task_list};

#[derive(Clone)]
pub(crate) struct CoreServices<S = KeyringSecretStore> {
    pub(crate) database: Database,
    pub(crate) secret_store: Arc<S>,
    pub(crate) audit_writer: AuditWriter,
    pub(crate) import_previews: Arc<Mutex<server::ImportPreviewStore>>,
    pub(crate) operation_gateway: opspilot_task_engine::SqliteOperationGateway,
    pub(crate) connection_manager: opspilot_ssh_core::RusshConnectionManager<S>,
    pub(crate) terminal_backend: opspilot_ssh_core::RusshShellBackend<S>,
    pub(crate) terminal_manager:
        opspilot_ssh_core::TerminalManager<opspilot_ssh_core::RusshShellBackend<S>>,
    pub(crate) tunnel_manager: opspilot_ssh_core::TunnelManager<S>,
    pub(crate) agent_sidecar: Arc<Mutex<Option<opspilot_agent_bridge::AgentSidecar>>>,
    pub(crate) agent_unavailable_reason: Arc<Mutex<Option<String>>>,
    pub(crate) agent_tools: opspilot_agent_bridge::ToolRegistry,
}

impl<S> CoreServices<S>
where
    S: SecretStore + 'static,
{
    pub(crate) fn new(database: Database, secret_store: S) -> Self {
        let secret_store = Arc::new(secret_store);
        let connection_manager = opspilot_ssh_core::RusshConnectionManager::new(
            database.clone(),
            secret_store.clone(),
            std::time::Duration::from_secs(5 * 60),
        );
        let operation_gateway =
            operation::operation_gateway_with_remote(database.clone(), connection_manager.clone())
                .expect("built-in operation catalog must be valid");
        let agent_tools = opspilot_agent_bridge::ToolRegistry::new(
            Arc::new(operation_gateway.clone()),
            operation::agent_tool_descriptors(),
        )
        .expect("built-in Agent tool catalog must be valid");
        let terminal_backend =
            opspilot_ssh_core::RusshShellBackend::new(connection_manager.clone());
        let terminal_manager = opspilot_ssh_core::TerminalManager::new(terminal_backend.clone());
        let tunnel_manager = opspilot_ssh_core::TunnelManager::new(connection_manager.clone());
        Self {
            audit_writer: AuditWriter::new(database.clone(), Redactor::default()),
            database,
            secret_store,
            import_previews: Arc::new(Mutex::new(server::ImportPreviewStore::default())),
            operation_gateway,
            connection_manager,
            terminal_backend,
            terminal_manager,
            tunnel_manager,
            agent_sidecar: Arc::new(Mutex::new(None)),
            agent_unavailable_reason: Arc::new(Mutex::new(Some(
                "Agent Sidecar runtime has not started".to_owned(),
            ))),
            agent_tools,
        }
    }
}

pub(super) fn services(app: &AppHandle) -> CoreServices<KeyringSecretStore> {
    app.state::<CoreServices<KeyringSecretStore>>()
        .inner()
        .clone()
}
