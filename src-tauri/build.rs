fn main() {
    let attributes =
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "core_health",
            "server_list",
            "server_create",
            "server_update",
            "server_delete",
            "server_credential_set",
            "server_group_list",
            "server_group_create",
            "server_group_update",
            "server_group_delete",
            "ssh_config_import_preview",
            "ssh_config_import_apply",
        ]));
    tauri_build::try_build(attributes).expect("failed to build Tauri command manifest");
}
