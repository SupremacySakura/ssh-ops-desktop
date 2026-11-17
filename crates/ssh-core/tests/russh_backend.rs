use opspilot_domain::{CoreErrorCode, Id};
use opspilot_persistence::Database;
use opspilot_secrets::{MemorySecretStore, SecretKind, SecretStore, SecretValue};
use opspilot_ssh_core::{AuthRequest, ConnectionRequest, HostEndpoint, RusshConnectionManager};
use std::{sync::Arc, time::Duration};

#[tokio::test]
async fn connection_request_validates_identity_without_resolving_secrets_in_webview() {
    let store = MemorySecretStore::default();
    let owner_id = Id::new();
    let secret_ref = store
        .put(
            SecretKind::Password,
            owner_id,
            SecretValue::new("super-secret"),
        )
        .await
        .unwrap();
    let endpoint = HostEndpoint::try_new(owner_id, "example.com", 22).unwrap();

    let request =
        ConnectionRequest::try_new(endpoint, " deploy ", AuthRequest::Password { secret_ref })
            .unwrap();
    assert_eq!(request.username(), "deploy");
    assert!(!format!("{request:?}").contains("super-secret"));

    let invalid = ConnectionRequest::try_new(
        HostEndpoint::try_new(owner_id, "example.com", 22).unwrap(),
        "bad\nuser",
        AuthRequest::SshAgent,
    )
    .expect_err("control characters must be rejected");
    assert_eq!(invalid.code(), CoreErrorCode::Validation);
}

#[tokio::test]
async fn manager_can_trust_a_pending_host_key_without_round_tripping_key_bytes_through_ui() {
    let database = Database::open(":memory:").await.unwrap();
    let server_id = Id::new();
    sqlx::query(
        "INSERT INTO servers (
            id, name, host, port, user, auth_type, secret_ref, created_at
         ) VALUES (?, 'Test', 'example.com', 22, 'deploy', 'key', 'secret-ref',
                   strftime('%s', 'now'))",
    )
    .bind(server_id.to_string())
    .execute(database.pool())
    .await
    .unwrap();
    let endpoint = HostEndpoint::try_new(server_id, "example.com", 22).unwrap();
    let store = Arc::new(MemorySecretStore::default());
    let manager = RusshConnectionManager::new(database, store, Duration::from_secs(60));
    let prompt = manager
        .simulate_host_key_for_test(&endpoint, "ssh-ed25519", b"fixture-key")
        .await
        .unwrap();

    manager
        .trust_host_key(prompt.verification_id.unwrap(), &endpoint)
        .await
        .unwrap();
    let trusted = manager
        .simulate_host_key_for_test(&endpoint, "ssh-ed25519", b"fixture-key")
        .await
        .unwrap();
    assert!(trusted.already_trusted);
}
