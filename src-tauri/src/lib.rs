#![forbid(unsafe_code)]

use std::fs;

use commands::{
    CoreServices, connection_connect, connection_disconnect, connection_trust_host_key,
    core_health, docker_action, docker_exec, docker_list, docker_logs, monitor_snapshot,
    server_create, server_credential_set, server_delete, server_group_create, server_group_delete,
    server_group_list, server_group_update, server_list, server_update, ssh_config_import_apply,
    ssh_config_import_preview, terminal_close, terminal_open, terminal_resize, terminal_write,
};
use opspilot_persistence::Database;
use opspilot_secrets::KeyringSecretStore;
use opspilot_ssh_core::TerminalEvent;
use tauri::{Emitter, Manager};

mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            fs::create_dir_all(&app_data_dir)?;
            let database = tauri::async_runtime::block_on(Database::open(
                app_data_dir.join("harbor.sqlite3"),
            ))?;
            let services = CoreServices::new(database, KeyringSecretStore::new());
            let mut terminal_events = services.terminal_manager.subscribe();
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                while let Some(event) = terminal_events.recv().await {
                    match event {
                        TerminalEvent::Data(data) => {
                            let _ = app_handle.emit("terminal:data", data);
                        }
                        TerminalEvent::Gap(gap) => {
                            let _ = app_handle.emit("terminal:gap", gap);
                        }
                        TerminalEvent::Closed(closed) => {
                            let _ = app_handle.emit("terminal:closed", closed);
                        }
                    }
                }
            });
            app.manage(services);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            core_health,
            server_list,
            server_create,
            server_update,
            server_delete,
            server_credential_set,
            server_group_list,
            server_group_create,
            server_group_update,
            server_group_delete,
            connection_connect,
            connection_trust_host_key,
            connection_disconnect,
            terminal_open,
            terminal_write,
            terminal_resize,
            terminal_close,
            docker_list,
            docker_logs,
            docker_action,
            docker_exec,
            monitor_snapshot,
            ssh_config_import_preview,
            ssh_config_import_apply,
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let services = window.state::<CoreServices>().inner().clone();
                tauri::async_runtime::spawn(async move {
                    services.shutdown().await;
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run Harbor");
}
