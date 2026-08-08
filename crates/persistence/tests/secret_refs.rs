use std::collections::HashSet;

use opspilot_persistence::Database;
use sqlx::{
    Row, SqlitePool,
    migrate::Migrator,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use tempfile::tempdir;

static MIGRATOR: Migrator = sqlx::migrate!("./migrations");

#[tokio::test]
async fn secret_refs_store_only_constrained_reference_metadata() {
    let database = Database::open(":memory:")
        .await
        .expect("in-memory database should open");

    let columns = sqlx::query("PRAGMA table_info('secret_refs')")
        .fetch_all(database.pool())
        .await
        .expect("secret_refs columns should be readable")
        .into_iter()
        .map(|row| row.get::<String, _>("name"))
        .collect::<HashSet<_>>();
    let expected = [
        "ref",
        "kind",
        "owner_type",
        "owner_id",
        "created_at",
        "updated_at",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect::<HashSet<_>>();
    assert_eq!(columns, expected);

    let invalid_kind = sqlx::query(
        "INSERT INTO secret_refs (
            ref, kind, owner_type, owner_id, created_at, updated_at
         ) VALUES ('invalid-kind-ref', 'token', 'server', 'server-1', ?, ?)",
    )
    .bind("2026-08-07T12:34:56Z")
    .bind("2026-08-07T12:34:56Z")
    .execute(database.pool())
    .await
    .expect_err("unregistered secret kinds should be rejected");
    assert!(invalid_kind.to_string().contains("CHECK constraint failed"));
}

#[tokio::test]
async fn migration_backfills_refs_and_preserves_server_relations() {
    let directory = tempdir().expect("temporary directory should be created");
    let database_path = directory.path().join("upgrade.sqlite3");
    let options = SqliteConnectOptions::new()
        .filename(&database_path)
        .create_if_missing(true)
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .expect("legacy database should open");

    MIGRATOR
        .run_to(1, &pool)
        .await
        .expect("v1 migration should apply");
    let timestamp = "2026-08-07T12:34:56Z";
    insert_legacy_server(
        &pool,
        "legacy-server",
        "192.0.2.20",
        "password",
        Some("legacy-secret-ref"),
        timestamp,
    )
    .await;
    insert_legacy_server(
        &pool,
        "legacy-key-server",
        "192.0.2.21",
        "private_key",
        Some("legacy-key-ref"),
        timestamp,
    )
    .await;
    insert_legacy_server(
        &pool,
        "legacy-certificate-server",
        "192.0.2.22",
        "certificate",
        Some("legacy-certificate-ref"),
        timestamp,
    )
    .await;
    insert_legacy_server(
        &pool,
        "legacy-agent-server",
        "192.0.2.23",
        "ssh_agent",
        None,
        timestamp,
    )
    .await;
    sqlx::query(
        "INSERT INTO tags (id, name, created_at, updated_at)
         VALUES ('legacy-tag', 'legacy', ?, ?)",
    )
    .bind(timestamp)
    .bind(timestamp)
    .execute(&pool)
    .await
    .expect("legacy tag should be inserted");
    sqlx::query(
        "INSERT INTO server_tags (server_id, tag_id, created_at)
         VALUES ('legacy-server', 'legacy-tag', ?)",
    )
    .bind(timestamp)
    .execute(&pool)
    .await
    .expect("legacy tag relation should be inserted");
    pool.close().await;

    let database = Database::open(&database_path)
        .await
        .expect("legacy database should upgrade");
    for (secret_ref, expected_kind, expected_owner) in [
        ("legacy-secret-ref", "password", "legacy-server"),
        ("legacy-key-ref", "private_key", "legacy-key-server"),
        (
            "legacy-certificate-ref",
            "certificate",
            "legacy-certificate-server",
        ),
    ] {
        let (kind, owner_type, owner_id, created_at, updated_at): (
            String,
            String,
            String,
            String,
            String,
        ) = sqlx::query_as(
            "SELECT kind, owner_type, owner_id, created_at, updated_at
             FROM secret_refs WHERE ref = ?",
        )
        .bind(secret_ref)
        .fetch_one(database.pool())
        .await
        .expect("legacy secret reference should be backfilled");
        assert_eq!(kind, expected_kind);
        assert_eq!(owner_type, "server");
        assert_eq!(owner_id, expected_owner);
        assert_eq!(created_at, timestamp);
        assert_eq!(updated_at, timestamp);
    }
    let agent_ref_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM secret_refs WHERE owner_id = 'legacy-agent-server'",
    )
    .fetch_one(database.pool())
    .await
    .expect("agent metadata count should be readable");
    assert_eq!(agent_ref_count, 0);

    let persisted_ref: String =
        sqlx::query_scalar("SELECT secret_ref FROM servers WHERE id = 'legacy-server'")
            .fetch_one(database.pool())
            .await
            .expect("legacy server should remain");
    let relation_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM server_tags
         WHERE server_id = 'legacy-server' AND tag_id = 'legacy-tag'",
    )
    .fetch_one(database.pool())
    .await
    .expect("legacy tag relation should remain");
    assert_eq!(persisted_ref, "legacy-secret-ref");
    assert_eq!(relation_count, 1);

    let secret_fk = sqlx::query("PRAGMA foreign_key_list('servers')")
        .fetch_all(database.pool())
        .await
        .expect("server foreign keys should be readable")
        .into_iter()
        .find(|row| row.get::<String, _>("from") == "secret_ref")
        .expect("servers.secret_ref should have a foreign key");
    assert_eq!(secret_fk.get::<String, _>("table"), "secret_refs");
    assert_eq!(secret_fk.get::<String, _>("to"), "ref");
    assert_eq!(secret_fk.get::<String, _>("on_delete"), "RESTRICT");

    let delete_error = sqlx::query("DELETE FROM secret_refs WHERE ref = 'legacy-secret-ref'")
        .execute(database.pool())
        .await
        .expect_err("referenced secret metadata should not be deletable");
    assert!(
        delete_error
            .to_string()
            .contains("FOREIGN KEY constraint failed")
    );

    let foreign_key_violations = sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(database.pool())
        .await
        .expect("foreign key check should run");
    assert!(foreign_key_violations.is_empty());

    let index_plan =
        sqlx::query("EXPLAIN QUERY PLAN SELECT * FROM servers WHERE group_id = 'legacy-group'")
            .fetch_all(database.pool())
            .await
            .expect("query plan should be available")
            .into_iter()
            .map(|row| row.get::<String, _>("detail"))
            .collect::<Vec<_>>()
            .join("\n");
    assert!(index_plan.contains("idx_servers_group_id"));

    let secret_ref_index_plan = sqlx::query(
        "EXPLAIN QUERY PLAN SELECT * FROM servers WHERE secret_ref = 'legacy-secret-ref'",
    )
    .fetch_all(database.pool())
    .await
    .expect("secret reference query plan should be available")
    .into_iter()
    .map(|row| row.get::<String, _>("detail"))
    .collect::<Vec<_>>()
    .join("\n");
    assert!(
        secret_ref_index_plan.contains("idx_servers_secret_ref")
            || secret_ref_index_plan.contains("idx_servers_unique_secret_ref"),
        "secret_ref lookup should use a dedicated index: {secret_ref_index_plan}"
    );
}

#[tokio::test]
async fn migration_reports_unsupported_legacy_secret_reference_owner() {
    let directory = tempdir().expect("temporary directory should be created");
    let database_path = directory.path().join("unsupported-auth-upgrade.sqlite3");
    let pool = open_legacy_database(&database_path).await;
    insert_legacy_server(
        &pool,
        "legacy-agent-with-ref",
        "192.0.2.30",
        "ssh_agent",
        Some("stale-agent-secret-ref"),
        "2026-08-07T12:34:56Z",
    )
    .await;
    pool.close().await;

    let error = Database::open(&database_path)
        .await
        .expect_err("unsupported legacy references should stop with a diagnostic");

    assert!(error.message().contains("legacy-agent-with-ref"));
    assert!(error.message().contains("ssh_agent"));
    assert!(error.message().contains("stale secret_ref"));
}

#[tokio::test]
async fn migration_reports_every_owner_of_a_shared_legacy_secret_reference() {
    let directory = tempdir().expect("temporary directory should be created");
    let database_path = directory.path().join("shared-ref-upgrade.sqlite3");
    let pool = open_legacy_database(&database_path).await;
    let timestamp = "2026-08-07T12:34:56Z";
    insert_legacy_server(
        &pool,
        "legacy-shared-a",
        "192.0.2.31",
        "password",
        Some("shared-legacy-secret-ref"),
        timestamp,
    )
    .await;
    insert_legacy_server(
        &pool,
        "legacy-shared-b",
        "192.0.2.32",
        "password",
        Some("shared-legacy-secret-ref"),
        timestamp,
    )
    .await;
    pool.close().await;

    let error = Database::open(&database_path)
        .await
        .expect_err("shared legacy references should stop with a diagnostic");

    assert!(error.message().contains("shared-legacy-secret-ref"));
    assert!(error.message().contains("legacy-shared-a"));
    assert!(error.message().contains("legacy-shared-b"));
    assert!(error.message().contains("unique secret_ref"));
}

async fn open_legacy_database(path: &std::path::Path) -> SqlitePool {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .expect("legacy database should open");

    MIGRATOR
        .run_to(1, &pool)
        .await
        .expect("v1 migration should apply");

    pool
}

async fn insert_legacy_server(
    pool: &SqlitePool,
    id: &str,
    host: &str,
    auth_type: &str,
    secret_ref: Option<&str>,
    timestamp: &str,
) {
    sqlx::query(
        "INSERT INTO servers (
            id, name, host, port, username, auth_type, secret_ref, created_at, updated_at
         ) VALUES (?, ?, ?, 22, 'operator', ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(format!("Server {id}"))
    .bind(host)
    .bind(auth_type)
    .bind(secret_ref)
    .bind(timestamp)
    .bind(timestamp)
    .execute(pool)
    .await
    .expect("legacy server should be inserted");
}
