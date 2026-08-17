#[cfg(unix)]
use opspilot_domain::CoreErrorCode;
use opspilot_domain::Id;
use opspilot_secrets::{MemorySecretStore, SecretKind, SecretStore, SecretValue};
use opspilot_ssh_core::{AuthRequest, AuthResolver, ResolvedAuth};

#[tokio::test]
async fn resolves_password_only_inside_the_rust_secret_boundary() {
    let store = MemorySecretStore::default();
    let secret_ref = store
        .put(
            SecretKind::Password,
            Id::new(),
            SecretValue::new("fixture-password-never-log"),
        )
        .await
        .expect("password fixture should be stored");
    let resolver = AuthResolver::new(&store);

    let resolved = resolver
        .resolve(AuthRequest::Password { secret_ref })
        .await
        .expect("password should resolve");

    match &resolved {
        ResolvedAuth::Password(value) => assert_eq!(value.expose(), "fixture-password-never-log"),
        other => panic!("expected password auth, got {other:?}"),
    }
    assert!(!format!("{resolved:?}").contains("fixture-password-never-log"));
}

#[cfg(unix)]
#[tokio::test]
async fn rejects_world_writable_private_key_files_before_reading_them() {
    use std::os::unix::fs::PermissionsExt;

    let store = MemorySecretStore::default();
    let resolver = AuthResolver::new(&store);
    let file = tempfile::NamedTempFile::new().expect("private-key fixture should be created");
    std::fs::set_permissions(file.path(), std::fs::Permissions::from_mode(0o666))
        .expect("fixture permissions should be set");

    let error = resolver
        .resolve(AuthRequest::PrivateKey {
            path: file.path().to_path_buf(),
            passphrase_ref: None,
        })
        .await
        .expect_err("world-writable private keys must be rejected");

    assert_eq!(error.code(), CoreErrorCode::RemotePermission);
    assert!(
        !error
            .message()
            .contains(file.path().to_string_lossy().as_ref())
    );
}
