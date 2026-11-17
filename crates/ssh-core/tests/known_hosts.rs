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
    let changed_id = match changed {
        HostKeyDecision::Changed {
            verification_id,
            expected_sha256,
            actual_sha256,
            expires_at,
        } => {
            assert_eq!(expected_sha256, key_a.sha256());
            assert_eq!(actual_sha256, key_b.sha256());
            assert_eq!(expires_at, now + Duration::from_secs(600));
            verification_id
        }
        other => panic!("expected changed key, got {other:?}"),
    };
    assert_eq!(
        verifier.verify_at(&endpoint, &key_a, now).await.unwrap(),
        HostKeyDecision::Trusted,
        "observing a changed key must not mutate persisted trust"
    );
    verifier
        .trust_at(changed_id, &endpoint, &key_b, now)
        .await
        .expect("explicit trust should permit an intentional host-key replacement");
    assert_eq!(
        verifier.verify_at(&endpoint, &key_b, now).await.unwrap(),
        HostKeyDecision::Trusted
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

#[tokio::test]
async fn concurrent_pending_keys_cannot_replace_an_already_trusted_fingerprint() {
    let database = Database::open(":memory:")
        .await
        .expect("in-memory database should open");
    let server_id = Id::new();
    insert_server(&database, server_id, "concurrent.example.com").await;
    let verifier = HostKeyVerifier::new(database.clone(), Duration::from_secs(600));
    let endpoint = HostEndpoint::try_new(server_id, "concurrent.example.com", 22).unwrap();
    let key_a = HostPublicKey::try_new("ssh-ed25519", b"concurrent-key-a").unwrap();
    let key_b = HostPublicKey::try_new("ssh-ed25519", b"concurrent-key-b").unwrap();
    let now = SystemTime::UNIX_EPOCH + Duration::from_secs(3_000_000);

    let first_pending = pending_id(verifier.verify_at(&endpoint, &key_a, now).await.unwrap());
    let second_pending = pending_id(verifier.verify_at(&endpoint, &key_b, now).await.unwrap());

    verifier
        .trust_at(first_pending, &endpoint, &key_a, now)
        .await
        .expect("the first explicit trust should persist");
    let takeover = verifier
        .trust_at(second_pending, &endpoint, &key_b, now)
        .await
        .expect_err("a second pending key must not replace trusted identity");
    assert!(matches!(
        takeover.code(),
        CoreErrorCode::Conflict | CoreErrorCode::SshHostKeyChanged
    ));

    assert_eq!(
        verifier.verify_at(&endpoint, &key_a, now).await.unwrap(),
        HostKeyDecision::Trusted
    );
    assert!(matches!(
        verifier.verify_at(&endpoint, &key_b, now).await.unwrap(),
        HostKeyDecision::Changed { .. }
    ));
    let persisted: (String,) = sqlx::query_as(
        "SELECT sha256 FROM known_host_keys
         WHERE server_id = ? AND host = ? AND port = ?",
    )
    .bind(server_id.to_string())
    .bind("concurrent.example.com")
    .bind(22_i64)
    .fetch_one(database.pool())
    .await
    .unwrap();
    assert_eq!(persisted.0, key_a.sha256());
}

#[tokio::test]
async fn concurrent_explicit_replacements_only_commit_the_expected_fingerprint() {
    let database = Database::open(":memory:")
        .await
        .expect("in-memory database should open");
    let server_id = Id::new();
    insert_server(&database, server_id, "replace.example.com").await;
    let verifier = HostKeyVerifier::new(database.clone(), Duration::from_secs(600));
    let endpoint = HostEndpoint::try_new(server_id, "replace.example.com", 22).unwrap();
    let key_a = HostPublicKey::try_new("ssh-ed25519", b"replace-key-a").unwrap();
    let key_b = HostPublicKey::try_new("ssh-ed25519", b"replace-key-b").unwrap();
    let key_c = HostPublicKey::try_new("ssh-ed25519", b"replace-key-c").unwrap();
    let now = SystemTime::UNIX_EPOCH + Duration::from_secs(4_000_000);

    let initial = pending_id(verifier.verify_at(&endpoint, &key_a, now).await.unwrap());
    verifier
        .trust_at(initial, &endpoint, &key_a, now)
        .await
        .unwrap();
    let replace_b = changed_id(verifier.verify_at(&endpoint, &key_b, now).await.unwrap());
    let replace_c = changed_id(verifier.verify_at(&endpoint, &key_c, now).await.unwrap());

    verifier
        .trust_at(replace_b, &endpoint, &key_b, now)
        .await
        .expect("the first explicit replacement should commit");
    let stale = verifier
        .trust_at(replace_c, &endpoint, &key_c, now)
        .await
        .expect_err("a pending replacement based on an older fingerprint must fail closed");
    assert_eq!(stale.code(), CoreErrorCode::SshHostKeyChanged);
    assert_eq!(
        verifier.verify_at(&endpoint, &key_b, now).await.unwrap(),
        HostKeyDecision::Trusted
    );
}

fn pending_id(decision: HostKeyDecision) -> Id {
    match decision {
        HostKeyDecision::Unknown {
            verification_id, ..
        } => verification_id,
        other => panic!("expected unknown key, got {other:?}"),
    }
}

fn changed_id(decision: HostKeyDecision) -> Id {
    match decision {
        HostKeyDecision::Changed {
            verification_id, ..
        } => verification_id,
        other => panic!("expected changed key, got {other:?}"),
    }
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
