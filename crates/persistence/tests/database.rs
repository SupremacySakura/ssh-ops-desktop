use std::collections::HashSet;

use opspilot_persistence::Database;
use sqlx::Row;
use tempfile::tempdir;

const EXPECTED_TABLES: [&str; 6] = [
    "app_settings",
    "audit_logs",
    "server_groups",
    "server_tags",
    "servers",
    "tags",
];

#[tokio::test]
async fn in_memory_database_enables_connection_policy_and_core_tables() {
    let database = Database::open(":memory:")
        .await
        .expect("in-memory database should open");

    let journal_mode: String = sqlx::query_scalar("PRAGMA journal_mode")
        .fetch_one(database.pool())
        .await
        .expect("journal mode should be readable");
    let foreign_keys: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
        .fetch_one(database.pool())
        .await
        .expect("foreign key policy should be readable");
    let busy_timeout: i64 = sqlx::query_scalar("PRAGMA busy_timeout")
        .fetch_one(database.pool())
        .await
        .expect("busy timeout should be readable");

    assert_eq!(journal_mode, "memory");
    assert_eq!(foreign_keys, 1);
    assert_eq!(busy_timeout, 5_000);

    let table_rows = sqlx::query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .fetch_all(database.pool())
    .await
    .expect("table names should be readable");
    let actual_tables: HashSet<String> = table_rows
        .into_iter()
        .map(|row| row.get::<String, _>("name"))
        .collect();

    for expected_table in EXPECTED_TABLES {
        assert!(
            actual_tables.contains(expected_table),
            "expected table {expected_table} to exist; found {actual_tables:?}"
        );
    }
}

#[tokio::test]
async fn file_database_uses_wal_and_busy_timeout() {
    let directory = tempdir().expect("temporary directory should be created");
    let database_path = directory.path().join("opspilot.sqlite3");

    let database = Database::open(&database_path)
        .await
        .expect("file database should open");

    let journal_mode: String = sqlx::query_scalar("PRAGMA journal_mode")
        .fetch_one(database.pool())
        .await
        .expect("journal mode should be readable");
    let foreign_keys: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
        .fetch_one(database.pool())
        .await
        .expect("foreign key policy should be readable");
    let busy_timeout: i64 = sqlx::query_scalar("PRAGMA busy_timeout")
        .fetch_one(database.pool())
        .await
        .expect("busy timeout should be readable");

    assert_eq!(journal_mode, "wal");
    assert_eq!(foreign_keys, 1);
    assert_eq!(busy_timeout, 5_000);
    assert!(database_path.is_file());
}

#[tokio::test]
async fn reopening_a_migrated_file_database_preserves_existing_data() {
    let directory = tempdir().expect("temporary directory should be created");
    let database_path = directory.path().join("reopen.sqlite3");
    let database = Database::open(&database_path)
        .await
        .expect("file database should open the first time");

    sqlx::query("INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)")
        .bind("theme")
        .bind(r#"{"mode":"dark"}"#)
        .bind("2026-08-07T12:34:56Z")
        .execute(database.pool())
        .await
        .expect("existing data should be inserted");
    database.pool().close().await;
    drop(database);

    let reopened = Database::open(&database_path)
        .await
        .expect("migrated file database should reopen");
    let value_json: String =
        sqlx::query_scalar("SELECT value_json FROM app_settings WHERE key = 'theme'")
            .fetch_one(reopened.pool())
            .await
            .expect("existing data should remain after reopening");

    assert_eq!(value_json, r#"{"mode":"dark"}"#);
    reopened.pool().close().await;
}

#[tokio::test]
async fn foreign_key_filters_use_dedicated_indexes() {
    let database = Database::open(":memory:")
        .await
        .expect("in-memory database should open");
    let cases = [
        (
            "EXPLAIN QUERY PLAN SELECT * FROM servers WHERE group_id = 'group-1'",
            "idx_servers_group_id",
        ),
        (
            "EXPLAIN QUERY PLAN SELECT * FROM servers WHERE jump_host_id = 'server-1'",
            "idx_servers_jump_host_id",
        ),
        (
            "EXPLAIN QUERY PLAN SELECT * FROM server_tags WHERE tag_id = 'tag-1'",
            "idx_server_tags_tag_id",
        ),
    ];

    for (query, expected_index) in cases {
        let plan_rows = sqlx::query(query)
            .fetch_all(database.pool())
            .await
            .expect("query plan should be available");
        let plan = plan_rows
            .into_iter()
            .map(|row| row.get::<String, _>("detail"))
            .collect::<Vec<_>>()
            .join("\n");

        assert!(
            plan.contains(expected_index),
            "expected query plan to use {expected_index}; got {plan}"
        );
    }
}

#[tokio::test]
async fn timestamp_constraints_reject_malformed_non_utc_and_nonexistent_values() {
    let database = Database::open(":memory:")
        .await
        .expect("in-memory database should open");
    let valid_timestamp = "2026-08-07T12:34:56Z";

    sqlx::query(
        "INSERT INTO servers (
            id, name, host, port, username, auth_type, created_at, updated_at
        ) VALUES ('timestamp-server', 'Timestamp server', '192.0.2.11', 22,
                  'operator', 'ssh_agent', ?, ?)",
    )
    .bind(valid_timestamp)
    .bind(valid_timestamp)
    .execute(database.pool())
    .await
    .expect("valid server fixture should be inserted");
    sqlx::query(
        "INSERT INTO tags (id, name, created_at, updated_at)
         VALUES ('timestamp-tag', 'timestamp-test', ?, ?)",
    )
    .bind(valid_timestamp)
    .bind(valid_timestamp)
    .execute(database.pool())
    .await
    .expect("valid tag fixture should be inserted");

    let malformed_cases = [
        (
            "server_groups.created_at",
            "INSERT INTO server_groups (id, name, created_at, updated_at)
             VALUES ('invalid-group-created', 'Group', 'not-a-timestamp',
                     '2026-08-07T12:34:56Z')",
        ),
        (
            "server_groups.updated_at",
            "INSERT INTO server_groups (id, name, created_at, updated_at)
             VALUES ('invalid-group-updated', 'Group', '2026-08-07T12:34:56Z',
                     'not-a-timestamp')",
        ),
        (
            "servers.created_at",
            "INSERT INTO servers (
                id, name, host, port, username, auth_type, created_at, updated_at
             ) VALUES ('invalid-server-created', 'Server', '192.0.2.12', 22,
                       'operator', 'ssh_agent', 'not-a-timestamp',
                       '2026-08-07T12:34:56Z')",
        ),
        (
            "servers.updated_at",
            "INSERT INTO servers (
                id, name, host, port, username, auth_type, created_at, updated_at
             ) VALUES ('invalid-server-updated', 'Server', '192.0.2.13', 22,
                       'operator', 'ssh_agent', '2026-08-07T12:34:56Z',
                       'not-a-timestamp')",
        ),
        (
            "servers.last_connected_at",
            "INSERT INTO servers (
                id, name, host, port, username, auth_type, created_at, updated_at,
                last_connected_at
             ) VALUES ('invalid-server-connected', 'Server', '192.0.2.14', 22,
                       'operator', 'ssh_agent', '2026-08-07T12:34:56Z',
                       '2026-08-07T12:34:56Z', 'not-a-timestamp')",
        ),
        (
            "tags.created_at",
            "INSERT INTO tags (id, name, created_at, updated_at)
             VALUES ('invalid-tag-created', 'Tag created', 'not-a-timestamp',
                     '2026-08-07T12:34:56Z')",
        ),
        (
            "tags.updated_at",
            "INSERT INTO tags (id, name, created_at, updated_at)
             VALUES ('invalid-tag-updated', 'Tag updated',
                     '2026-08-07T12:34:56Z', 'not-a-timestamp')",
        ),
        (
            "server_tags.created_at",
            "INSERT INTO server_tags (server_id, tag_id, created_at)
             VALUES ('timestamp-server', 'timestamp-tag', 'not-a-timestamp')",
        ),
        (
            "app_settings.updated_at",
            "INSERT INTO app_settings (key, value_json, updated_at)
             VALUES ('invalid-setting-time', '{}', 'not-a-timestamp')",
        ),
        (
            "audit_logs.created_at",
            "INSERT INTO audit_logs (
                id, action, resource_type, result, redacted_payload, created_at
             ) VALUES ('invalid-audit-time', 'server.list', 'server', 'success',
                       '{}', 'not-a-timestamp')",
        ),
    ];

    for (column, statement) in malformed_cases {
        let error = sqlx::query(statement)
            .execute(database.pool())
            .await
            .expect_err(&format!("{column} should reject malformed timestamps"));
        assert!(
            error.to_string().contains("CHECK constraint failed"),
            "unexpected {column} error: {error}"
        );
    }

    for (key, invalid_timestamp) in [
        ("non-utc-offset", "2026-08-07T12:34:56+08:00"),
        ("missing-seconds", "2026-08-07T12:34Z"),
        ("nonexistent-date", "2026-02-31T12:34:56Z"),
    ] {
        let error = sqlx::query(
            "INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, '{}', ?)",
        )
        .bind(key)
        .bind(invalid_timestamp)
        .execute(database.pool())
        .await
        .expect_err("invalid UTC RFC3339 values should be rejected");
        assert!(
            error.to_string().contains("CHECK constraint failed"),
            "unexpected error for {invalid_timestamp}: {error}"
        );
    }
}

#[tokio::test]
async fn timestamp_constraints_accept_utc_rfc3339_variants() {
    let database = Database::open(":memory:")
        .await
        .expect("in-memory database should open");
    let variants = [
        "2026-08-07T12:34:56Z",
        "2026-08-07T12:34:56.123456789Z",
        "2026-08-07T12:34:56+00:00",
        "2026-08-07T12:34:56.123+00:00",
    ];

    for (index, timestamp) in variants.into_iter().enumerate() {
        sqlx::query("INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, '{}', ?)")
            .bind(format!("valid-timestamp-{index}"))
            .bind(timestamp)
            .execute(database.pool())
            .await
            .expect("valid UTC RFC3339 timestamp should be accepted");
    }
}

#[tokio::test]
async fn foreign_keys_block_deleting_a_referenced_parent() {
    let database = Database::open(":memory:")
        .await
        .expect("in-memory database should open");

    sqlx::query("CREATE TABLE deletion_parent (id INTEGER PRIMARY KEY)")
        .execute(database.pool())
        .await
        .expect("parent fixture table should be created");
    sqlx::query(
        "CREATE TABLE deletion_child (
            id INTEGER PRIMARY KEY,
            parent_id INTEGER NOT NULL REFERENCES deletion_parent(id)
        )",
    )
    .execute(database.pool())
    .await
    .expect("child fixture table should be created");
    sqlx::query("INSERT INTO deletion_parent (id) VALUES (1)")
        .execute(database.pool())
        .await
        .expect("parent fixture should be inserted");
    sqlx::query("INSERT INTO deletion_child (id, parent_id) VALUES (1, 1)")
        .execute(database.pool())
        .await
        .expect("child fixture should be inserted");

    let delete_error = sqlx::query("DELETE FROM deletion_parent WHERE id = 1")
        .execute(database.pool())
        .await
        .expect_err("foreign key policy should block deleting the referenced parent");
    assert!(
        delete_error
            .to_string()
            .contains("FOREIGN KEY constraint failed"),
        "unexpected delete error: {delete_error}"
    );

    let parent_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM deletion_parent")
        .fetch_one(database.pool())
        .await
        .expect("parent count should be readable");
    assert_eq!(parent_count, 1);
}

#[tokio::test]
async fn deleting_a_server_cascades_its_tag_links() {
    let database = Database::open(":memory:")
        .await
        .expect("in-memory database should open");
    let timestamp = "2026-08-07T00:00:00Z";

    sqlx::query(
        "INSERT INTO servers (
            id, name, host, port, username, auth_type, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind("server-1")
    .bind("Test server")
    .bind("192.0.2.10")
    .bind(22_i64)
    .bind("operator")
    .bind("ssh_agent")
    .bind(timestamp)
    .bind(timestamp)
    .execute(database.pool())
    .await
    .expect("server fixture should be inserted");
    sqlx::query("INSERT INTO tags (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
        .bind("tag-1")
        .bind("production")
        .bind(timestamp)
        .bind(timestamp)
        .execute(database.pool())
        .await
        .expect("tag fixture should be inserted");
    sqlx::query("INSERT INTO server_tags (server_id, tag_id, created_at) VALUES (?, ?, ?)")
        .bind("server-1")
        .bind("tag-1")
        .bind(timestamp)
        .execute(database.pool())
        .await
        .expect("server tag fixture should be inserted");

    sqlx::query("DELETE FROM servers WHERE id = ?")
        .bind("server-1")
        .execute(database.pool())
        .await
        .expect("server should be deletable");

    let link_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM server_tags")
        .fetch_one(database.pool())
        .await
        .expect("server tag count should be readable");
    let tag_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tags")
        .fetch_one(database.pool())
        .await
        .expect("tag count should be readable");
    assert_eq!(link_count, 0);
    assert_eq!(tag_count, 1, "deleting a server must not delete the tag");
}

#[tokio::test]
async fn audit_logs_are_append_only_even_through_direct_sql() {
    let database = Database::open(":memory:")
        .await
        .expect("in-memory database should open");

    sqlx::query(
        "INSERT INTO audit_logs (
            id, action, resource_type, resource_id, server_id, result,
            redacted_payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind("audit-1")
    .bind("server.connect")
    .bind("server")
    .bind("server-1")
    .bind("server-1")
    .bind("success")
    .bind(r#"{"host":"192.0.2.10"}"#)
    .bind("2026-08-07T00:00:00Z")
    .execute(database.pool())
    .await
    .expect("audit fixture should be inserted");

    let update_error = sqlx::query("UPDATE audit_logs SET result = 'failed' WHERE id = 'audit-1'")
        .execute(database.pool())
        .await
        .expect_err("direct audit updates should be blocked");
    let delete_error = sqlx::query("DELETE FROM audit_logs WHERE id = 'audit-1'")
        .execute(database.pool())
        .await
        .expect_err("direct audit deletes should be blocked");
    assert!(
        update_error
            .to_string()
            .contains("audit_logs is append-only"),
        "unexpected update error: {update_error}"
    );
    assert!(
        delete_error
            .to_string()
            .contains("audit_logs is append-only"),
        "unexpected delete error: {delete_error}"
    );

    let (result, payload): (String, String) =
        sqlx::query_as("SELECT result, redacted_payload FROM audit_logs WHERE id = 'audit-1'")
            .fetch_one(database.pool())
            .await
            .expect("original audit record should remain");
    assert_eq!(result, "success");
    assert_eq!(payload, r#"{"host":"192.0.2.10"}"#);
}
