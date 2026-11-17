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
            "connection_connect",
            "connection_trust_host_key",
            "connection_disconnect",
            "terminal_open",
            "terminal_write",
            "terminal_resize",
            "terminal_close",
        ]));
    tauri_build::try_build(attributes).expect("failed to build Tauri command manifest");
}
