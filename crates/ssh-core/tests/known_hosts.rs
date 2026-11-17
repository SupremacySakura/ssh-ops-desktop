use std::time::{Duration, SystemTime};

use opspilot_domain::{CoreErrorCode, Id};
use opspilot_persistence::Database;
use opspilot_ssh_core::{HostEndpoint, HostKeyDecision, HostKeyVerifier, HostPublicKey};

#[tokio::test]
async fn unknown_key_is_one_time_trusted_and_a_changed_key_is_blocked() {
    let database = Database::open(":memory:")
        .await
        .expect("in-memory database should open");
    let server_id = Id::new();
    insert_server(&database, server_id, "first.example.com").await;
    let verifier = HostKeyVerifier::new(database, Duration::from_secs(600));
    let endpoint =
        HostEndpoint::try_new(server_id, " Example.COM ", 2222).expect("endpoint should normalize");
    let key_a =
        HostPublicKey::try_new("ssh-ed25519", b"host-key-a").expect("first key should be valid");
    let key_b =
        HostPublicKey::try_new("ssh-ed25519", b"host-key-b").expect("second key should be valid");
    let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);

    let first = verifier
        .verify_at(&endpoint, &key_a, now)
        .await
        .expect("unknown key should produce a decision");
    let verification_id = match first {
        HostKeyDecision::Unknown {
            verification_id,
            algorithm,
            sha256,
            expires_at,
        } => {
            assert_eq!(algorithm, "ssh-ed25519");
            assert!(sha256.starts_with("SHA256:"));
            assert_eq!(expires_at, now + Duration::from_secs(600));
            verification_id
        }
        other => panic!("expected unknown key, got {other:?}"),
    };
    assert_eq!(endpoint.host(), "example.com");

    verifier
        .trust_at(verification_id, &endpoint, &key_a, now)
        .await
        .expect("matching verification should persist trust");
    assert_eq!(
        verifier.verify_at(&endpoint, &key_a, now).await.unwrap(),
        HostKeyDecision::Trusted
    );

    let changed = verifier.verify_at(&endpoint, &key_b, now).await.unwrap();
    assert!(matches!(
        changed,
        HostKeyDecision::Changed {
            expected_sha256: _,
            actual_sha256: _
        }
    ));
    assert_eq!(
        verifier.verify_at(&endpoint, &key_a, now).await.unwrap(),
        HostKeyDecision::Trusted,
        "changed-key verification must not mutate persisted trust"
    );

    let replay = verifier
        .trust_at(verification_id, &endpoint, &key_a, now)
        .await
        .expect_err("verification IDs must be consumed exactly once");
    assert_eq!(replay.code(), CoreErrorCode::NotFound);
}

#[tokio::test]
async fn expired_or_mismatched_verification_never_writes_trust() {
    let database = Database::open(":memory:")
        .await
        .expect("in-memory database should open");
    let server_id = Id::new();
    let other_server_id = Id::new();
    insert_server(&database, server_id, "host.example.com").await;
    insert_server(&database, other_server_id, "other.example.com").await;
    let verifier = HostKeyVerifier::new(database, Duration::from_secs(600));
    let endpoint = HostEndpoint::try_new(server_id, "host.example.com", 22).unwrap();
    let other_endpoint = HostEndpoint::try_new(other_server_id, "host.example.com", 22).unwrap();
    let key = HostPublicKey::try_new("ssh-ed25519", b"host-key").unwrap();
    let other_key = HostPublicKey::try_new("ssh-ed25519", b"other-key").unwrap();
    let now = SystemTime::UNIX_EPOCH + Duration::from_secs(2_000_000);

    let decision = verifier.verify_at(&endpoint, &key, now).await.unwrap();
    let verification_id = match decision {
        HostKeyDecision::Unknown {
            verification_id, ..
        } => verification_id,
        other => panic!("expected unknown key, got {other:?}"),
    };

    for (candidate_endpoint, candidate_key, at) in [
        (&other_endpoint, &key, now),
        (&endpoint, &other_key, now),
        (&endpoint, &key, now + Duration::from_secs(601)),
    ] {
        let error = verifier
            .trust_at(verification_id, candidate_endpoint, candidate_key, at)
            .await
            .expect_err("mismatched or expired verification must fail closed");
        assert!(matches!(
            error.code(),
            CoreErrorCode::Conflict | CoreErrorCode::NotFound
        ));
    }

    assert!(matches!(
        verifier.verify_at(&endpoint, &key, now).await.unwrap(),
        HostKeyDecision::Unknown { .. }
    ));
}

async fn insert_server(database: &Database, id: Id, host: &str) {
    sqlx::query(
        "INSERT INTO servers (
            id, name, host, port, user, auth_type, secret_ref, created_at
         ) VALUES (?, 'Host key fixture', ?, 22, 'deploy', 'key', 'secret-ref',
                   strftime('%s', 'now'))",
    )
    .bind(id.to_string())
    .bind(host)
    .execute(database.pool())
    .await
    .expect("server fixture should be inserted");
}
