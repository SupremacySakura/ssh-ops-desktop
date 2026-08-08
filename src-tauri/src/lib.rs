#![forbid(unsafe_code)]

use std::fs;
use std::path::PathBuf;

use commands::{
    CoreServices, agent_catalog, agent_run_start, agent_run_status, agent_status,
    agent_thread_create, agent_thread_list, audit_list, connection_connect, connection_disconnect,
    connection_trust_host_key, core_health, docker_container_exec, docker_container_list,
    docker_container_logs, docker_container_stats, docker_version, file_download, file_list,
    file_read, model_profile_delete, model_profile_list, model_profile_save,
    model_profile_test_connection, nginx_discover, nginx_read, operation_approve,
    operation_prepare, operation_reject, operation_status, project_create, project_detect,
    project_list, server_create, server_credential_set, server_delete, server_group_create,
    server_group_delete, server_group_list, server_group_update, server_import_apply,
    server_import_preview, server_list, server_tag_create, server_tag_delete, server_tag_list,
    server_tag_update, server_update, system_metrics, system_ports, system_probe, system_services,
    task_events_since, task_list, terminal_close, terminal_open, terminal_resize, terminal_write,
    tunnel_close, tunnel_list, tunnel_open,
};
use opspilot_persistence::Database;
use opspilot_secrets::KeyringSecretStore;
use tauri::{Emitter, Manager};

mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(all(debug_assertions, feature = "native-e2e"))]
    let builder = builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init());

    builder
        .setup(|app| {
            #[cfg(all(debug_assertions, feature = "native-e2e"))]
            app.add_capability(include_str!("../test-capabilities/wdio.json"))?;

            let app_data_dir = app.path().app_data_dir()?;
            fs::create_dir_all(&app_data_dir)?;
            let database = tauri::async_runtime::block_on(Database::open(
                app_data_dir.join("opspilot.sqlite3"),
            ))?;
            tauri::async_runtime::block_on(async {
                opspilot_persistence::TaskRepository::new(database.clone())
                    .recover_interrupted()
                    .await?;
                opspilot_persistence::AgentRepository::new(database.clone())
                    .recover_incomplete()
                    .await?;
                Ok::<(), opspilot_domain::CoreError>(())
            })?;
            let services = CoreServices::new(database, KeyringSecretStore::new());
            let agent_entry = if cfg!(debug_assertions) {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/agent-runtime/main.mjs")
            } else {
                app.path()
                    .resource_dir()?
                    .join("resources/agent-runtime/main.mjs")
            };
            let agent_program = if cfg!(debug_assertions) {
                PathBuf::from("node")
            } else {
                std::env::current_exe()?
                    .parent()
                    .unwrap_or_else(|| std::path::Path::new("."))
                    .join(if cfg!(windows) {
                        "opspilot-agent-node.exe"
                    } else {
                        "opspilot-agent-node"
                    })
            };
            let agent_start = tauri::async_runtime::block_on(
                opspilot_agent_bridge::AgentSidecar::start(opspilot_agent_bridge::SidecarCommand {
                    program: agent_program,
                    args: vec![agent_entry.to_string_lossy().into_owned()],
                    storage_url: app_data_dir
                        .join("agent-workflows.db")
                        .to_string_lossy()
                        .into_owned(),
                }),
            );
            match agent_start {
                Ok(sidecar) => {
                    *services.agent_sidecar.blocking_lock() = Some(sidecar);
                    *services.agent_unavailable_reason.blocking_lock() = None;
                }
                Err(error) => {
                    *services.agent_unavailable_reason.blocking_lock() =
                        Some(error.message().to_owned());
                }
            }
            let mut terminal_output = services.terminal_backend.subscribe();
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    match terminal_output.recv().await {
                        Ok(event) => {
                            let _ = app_handle.emit("terminal:data", event);
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(missed)) => {
                            let _ = app_handle
                                .emit("terminal:gap", serde_json::json!({ "missed": missed }));
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            });
            app.manage(services);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            core_health,
            agent_status,
            agent_catalog,
            agent_thread_list,
            agent_thread_create,
            agent_run_start,
            agent_run_status,
            docker_version,
            docker_container_list,
            docker_container_logs,
            docker_container_stats,
            docker_container_exec,
            file_list,
            file_read,
            file_download,
            nginx_discover,
            nginx_read,
            model_profile_list,
            model_profile_save,
            model_profile_delete,
            model_profile_test_connection,
            server_list,
            server_create,
            server_update,
            server_credential_set,
            server_delete,
            server_group_list,
            server_group_create,
            server_group_update,
            server_group_delete,
            server_tag_list,
            server_tag_create,
            server_tag_update,
            server_tag_delete,
            server_import_preview,
            server_import_apply,
            operation_prepare,
            operation_approve,
            operation_reject,
            operation_status,
            project_detect,
            project_create,
            project_list,
            task_events_since,
            task_list,
            audit_list,
            system_probe,
            system_metrics,
            system_ports,
            system_services,
            connection_connect,
            connection_trust_host_key,
            connection_disconnect,
            terminal_open,
            terminal_write,
            terminal_resize,
            terminal_close,
            tunnel_open,
            tunnel_close,
            tunnel_list,
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let session_id = window.label().to_owned();
                let previews = window
                    .state::<CoreServices<KeyringSecretStore>>()
                    .import_previews
                    .clone();
                tauri::async_runtime::spawn(async move {
                    previews.lock().await.clear_session(&session_id);
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run OpsPilot");
}
