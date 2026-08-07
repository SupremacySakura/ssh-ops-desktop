#![forbid(unsafe_code)]

use std::fs;

use commands::{CoreServices, core_health};
use opspilot_persistence::Database;
use opspilot_secrets::KeyringSecretStore;
use tauri::Manager;

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
            app.manage(CoreServices::new(database, KeyringSecretStore::new()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![core_health])
        .run(tauri::generate_context!())
        .expect("failed to run OpsPilot");
}
