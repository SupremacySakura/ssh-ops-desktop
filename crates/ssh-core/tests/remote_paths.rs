use opspilot_domain::CoreErrorCode;
use opspilot_ssh_core::{RemoteDirectoryPath, RemotePath};

#[test]
fn remote_path_rejects_parent_components_nul_and_relative_paths() {
    for path in [
        "../etc/passwd",
        "/srv/../etc/passwd",
        "/srv/a\0b",
        "relative",
    ] {
        let error = RemotePath::try_new(path).expect_err("unsafe path must be rejected");
        assert_eq!(error.code(), CoreErrorCode::Validation, "path: {path:?}");
    }

    assert_eq!(
        RemotePath::try_new("/srv/releases/-candidate;safe")
            .unwrap()
            .as_str(),
        "/srv/releases/-candidate;safe"
    );
}

#[test]
fn directory_paths_accept_root_and_normalize_like_resource_paths() {
    assert_eq!(RemoteDirectoryPath::try_new("/").unwrap().as_str(), "/");
    assert_eq!(
        RemoteDirectoryPath::try_new("//srv/./releases//")
            .unwrap()
            .as_str(),
        "/srv/releases"
    );
    assert_eq!(
        RemotePath::try_new("/srv/releases/").unwrap().as_str(),
        "/srv/releases"
    );

    for path in ["", "relative", "/srv/../etc", "/srv/a\0b", "/srv/a\nb"] {
        let error =
            RemoteDirectoryPath::try_new(path).expect_err("unsafe directory path must be rejected");
        assert_eq!(error.code(), CoreErrorCode::Validation, "path: {path:?}");
    }
    assert_eq!(
        RemotePath::try_new("/").unwrap_err().code(),
        CoreErrorCode::Validation
    );
}

#[test]
fn remote_paths_validate_during_deserialization() {
    let directory: RemoteDirectoryPath = serde_json::from_str("\"/srv/./app\"").unwrap();
    assert_eq!(directory.as_str(), "/srv/app");
    assert!(serde_json::from_str::<RemoteDirectoryPath>("\"/srv/../etc\"").is_err());
    assert!(serde_json::from_str::<RemoteDirectoryPath>("\"relative\"").is_err());

    let file: RemotePath = serde_json::from_str("\"/srv/app/config.yml\"").unwrap();
    assert_eq!(file.as_str(), "/srv/app/config.yml");
    assert!(serde_json::from_str::<RemotePath>("\"/\"").is_err());
    assert!(serde_json::from_str::<RemotePath>("\"/srv/../etc/passwd\"").is_err());
}

#[test]
fn directory_joins_only_single_safe_resource_names() {
    let directory = RemoteDirectoryPath::try_new("/srv/app").unwrap();
    assert_eq!(
        directory.join_resource("config.yml").unwrap().as_str(),
        "/srv/app/config.yml"
    );
    for name in ["", ".", "..", "nested/file", "bad\0name", "bad\nname"] {
        assert_eq!(
            directory
                .join_resource(name)
                .expect_err("unsafe entry must be rejected")
                .code(),
            CoreErrorCode::Validation
        );
    }
}
