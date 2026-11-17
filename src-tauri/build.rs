fn main() {
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(&["core_health"]));
    tauri_build::try_build(attributes).expect("failed to build Tauri command manifest");
}
