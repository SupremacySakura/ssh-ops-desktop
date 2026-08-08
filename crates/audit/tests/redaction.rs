use std::{
    error::Error,
    fmt, fs,
    time::{SystemTime, UNIX_EPOCH},
};

use opspilot_audit::{AuditEvent, AuditReader, AuditWriter, Redactor};
use opspilot_persistence::Database;
use serde_json::json;
use tempfile::tempdir;

#[test]
fn redacts_sensitive_fields_and_registered_values() {
    let redactor = Redactor::new(["p@ssw0rd", "sk-live-123"]);
    let value = json!({
        "password": "p@ssw0rd",
        "Authorization": "Bearer sk-live-123",
        "safe": "nginx uses sk-live-123",
        "nested": { "API_KEY": "not-registered-but-sensitive" }
    });

    assert_eq!(
        redactor.json(value),
        json!({
            "password": "[REDACTED]",
            "Authorization": "[REDACTED]",
            "safe": "nginx uses [REDACTED]",
            "nested": { "API_KEY": "[REDACTED]" }
        })
    );
}

#[test]
fn replaces_registered_values_longest_first() {
    let redactor = Redactor::new(["token", "token-long"]);

    assert_eq!(
        redactor.text("token-long then token"),
        "[REDACTED] then [REDACTED]"
    );
}

#[test]
fn redacts_environment_maps_without_hiding_deployment_environment() {
    let redactor = Redactor::new(Vec::<String>::new());
    let value = json!({
        "env": { "DATABASE_URL": "postgres://secret", "PORT": 5432 },
        "environment_variables": { "TOKEN": "fixture-token" },
        "environmentVariables": { "PRIVATE_KEY": "fixture-key" },
        "environment": "production"
    });

    assert_eq!(
        redactor.json(value),
        json!({
            "env": { "DATABASE_URL": "[REDACTED]", "PORT": "[REDACTED]" },
            "environment_variables": { "TOKEN": "[REDACTED]" },
            "environmentVariables": { "PRIVATE_KEY": "[REDACTED]" },
            "environment": "production"
        })
    );
}

#[test]
fn redacts_every_error_in_the_source_chain() {
    let redactor = Redactor::new(["fixture-secret"]);
    let error = RequestError {
        source: CredentialError,
    };

    assert_eq!(
        redactor.error(&error),
        "request failed: credential fixture [REDACTED]"
    );
}

#[tokio::test]
async fn audit_writer_assigns_the_current_utc_creation_time() {
    let database = Database::open(":memory:")
        .await
        .expect("audit database should open");
    let writer = AuditWriter::new(database.clone(), Redactor::default());
    let before = unix_timestamp();

    writer
        .append(AuditEvent::new(
            "server.connect",
            "server",
            "success",
            json!({}),
        ))
        .await
        .expect("audit event should be persisted");

    let after = unix_timestamp();
    let (created_at, created_at_epoch): (String, i64) = sqlx::query_as(
        "SELECT created_at, unixepoch(created_at) FROM audit_logs WHERE id IS NOT NULL",
    )
    .fetch_one(database.pool())
    .await
    .expect("audit creation time should be readable");
    assert!(created_at.ends_with('Z'));
    assert!((before..=after).contains(&created_at_epoch));
}

#[tokio::test]
async fn audit_reader_returns_structured_redacted_records() {
    let database = Database::open(":memory:")
        .await
        .expect("audit database should open");
    let writer = AuditWriter::new(database.clone(), Redactor::new(["fixture-secret"]));
    writer
        .append(
            AuditEvent::new(
                "task.complete",
                "task",
                "success",
                json!({ "token": "fixture-secret", "count": 2 }),
            )
            .with_resource_id("task-1")
            .with_server_id("server-1"),
        )
        .await
        .expect("audit event should be persisted");

    let records = AuditReader::new(database)
        .list(10)
        .await
        .expect("audit records should be readable");
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].action, "task.complete");
    assert_eq!(records[0].resource_id.as_deref(), Some("task-1"));
    assert_eq!(records[0].server_id.as_deref(), Some("server-1"));
    assert_eq!(
        records[0].redacted_payload,
        json!({ "token": "[REDACTED]", "count": 2 })
    );
}

#[tokio::test]
async fn audit_writer_never_persists_registered_secret_bytes() {
    let directory = tempdir().expect("temporary directory should be created");
    let database_path = directory.path().join("audit.sqlite3");
    let database = Database::open(&database_path)
        .await
        .expect("audit database should open");
    let writer = AuditWriter::new(
        database.clone(),
        Redactor::new(["credential-fixture-value", "model-key-fixture"]),
    );

    writer
        .append(
            AuditEvent::new(
                "server.connect.credential-fixture-value",
                "server-model-key-fixture",
                "failure: credential-fixture-value",
                json!({
                "password": "credential-fixture-value",
                "safe": "Bearer model-key-fixture",
                "environment": "production"
                }),
            )
            .with_resource_id("resource-credential-fixture-value")
            .with_server_id("server-model-key-fixture"),
        )
        .await
        .expect("redacted audit event should be persisted");

    let (action, resource_type, resource_id, server_id, result, payload_json): (
        String,
        String,
        Option<String>,
        Option<String>,
        String,
        String,
    ) = sqlx::query_as(
        "SELECT action, resource_type, resource_id, server_id, result, redacted_payload
         FROM audit_logs WHERE id IS NOT NULL",
    )
    .fetch_one(database.pool())
    .await
    .expect("redacted audit record should be readable");
    assert_eq!(action, "server.connect.[REDACTED]");
    assert_eq!(resource_type, "server-[REDACTED]");
    assert_eq!(resource_id.as_deref(), Some("resource-[REDACTED]"));
    assert_eq!(server_id.as_deref(), Some("server-[REDACTED]"));
    assert_eq!(result, "failure: [REDACTED]");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&payload_json)
            .expect("audit payload should remain valid JSON"),
        json!({
            "password": "[REDACTED]",
            "safe": "Bearer [REDACTED]",
            "environment": "production"
        })
    );

    drop(writer);
    database.pool().close().await;
    drop(database);

    for entry in fs::read_dir(directory.path()).expect("database directory should be readable") {
        let path = entry.expect("database entry should be readable").path();
        if path.is_file() {
            let bytes = fs::read(path).expect("database file should be readable");
            assert!(!contains_bytes(&bytes, b"credential-fixture-value"));
            assert!(!contains_bytes(&bytes, b"model-key-fixture"));
        }
    }
}

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|candidate| candidate == needle)
}

fn unix_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time should be after the Unix epoch")
        .as_secs() as i64
}

#[derive(Debug)]
struct RequestError {
    source: CredentialError,
}

impl fmt::Display for RequestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("request failed")
    }
}

impl Error for RequestError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(&self.source)
    }
}

#[derive(Debug)]
struct CredentialError;

impl fmt::Display for CredentialError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("credential fixture fixture-secret")
    }
}

impl Error for CredentialError {}
