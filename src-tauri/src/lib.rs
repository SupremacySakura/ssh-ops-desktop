#![forbid(unsafe_code)]

use std::fs;

use commands::{
    CoreServices, core_health, server_create, server_credential_set, server_delete,
    server_group_create, server_group_delete, server_group_list, server_group_update, server_list,
    server_update,
};
use opspilot_persistence::Database;
use opspilot_secrets::KeyringSecretStore;
use tauri::Manager;

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
            app.manage(CoreServices::new(database, KeyringSecretStore::new()));
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
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Harbor");
}
