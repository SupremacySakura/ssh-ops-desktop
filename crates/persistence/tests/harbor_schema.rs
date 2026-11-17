use std::collections::HashSet;

use opspilot_persistence::Database;
use sqlx::Row;

const LEGACY_TABLES: [&str; 10] = [
    "agent_runs",
    "agent_threads",
    "approvals",
    "audit_logs",
    "model_profiles",
    "projects",
    "server_tags",
    "tags",
    "tasks",
    "tool_calls",
];

#[tokio::test]
async fn harbor_schema_has_only_the_v2_catalog_model() {
    let database = Database::open(":memory:")
        .await
        .expect("in-memory database should open");

    let tables = table_names(&database).await;
    assert!(tables.contains("groups"));
    assert!(tables.contains("servers"));
    assert!(tables.contains("known_host_keys"));
    for legacy_table in LEGACY_TABLES {
        assert!(
            !tables.contains(legacy_table),
            "legacy table {legacy_table} must not be created"
        );
    }

    assert_eq!(
        column_names(&database, "groups").await,
        set(["id", "name", "sort_order"])
    );
    assert_eq!(
        column_names(&database, "servers").await,
        set([
            "auth_type",
            "created_at",
            "favorite",
            "group_id",
            "host",
            "id",
            "last_connected_at",
            "name",
            "port",
            "secret_ref",
            "user",
        ])
    );
}

#[tokio::test]
async fn harbor_schema_enforces_catalog_invariants() {
    let database = Database::open(":memory:")
        .await
        .expect("in-memory database should open");

    sqlx::query("INSERT INTO groups (id, name, sort_order) VALUES ('group-1', '生产', 1)")
        .execute(database.pool())
        .await
        .expect("group fixture should be inserted");

    sqlx::query(
        "INSERT INTO servers (
            id, name, host, port, user, auth_type, secret_ref, group_id,
            favorite, last_connected_at, created_at
         ) VALUES (
            'server-1', 'prod-web-01', 'prod.example.com', 22, 'deploy',
            'key', 'secret-ref-1', 'group-1', 1, 1_700_000_000, 1_700_000_000
         )",
    )
    .execute(database.pool())
    .await
    .expect("server fixture should be inserted");

    let duplicate = sqlx::query(
        "INSERT INTO servers (
            id, name, host, port, user, auth_type, secret_ref, created_at
         ) VALUES (
            'server-2', 'duplicate', 'prod.example.com', 22, 'deploy',
            'password', 'secret-ref-2', 1_700_000_001
         )",
    )
    .execute(database.pool())
    .await
    .expect_err("host, port, and user must identify a server uniquely");
    assert!(duplicate.to_string().contains("UNIQUE constraint failed"));

    let invalid_auth = sqlx::query(
        "INSERT INTO servers (
            id, name, host, port, user, auth_type, secret_ref, created_at
         ) VALUES (
            'server-3', 'invalid', 'invalid.example.com', 22, 'deploy',
            'agent', 'secret-ref-3', 1_700_000_002
         )",
    )
    .execute(database.pool())
    .await
    .expect_err("only password and key authentication are supported");
    assert!(invalid_auth.to_string().contains("CHECK constraint failed"));

    sqlx::query("DELETE FROM groups WHERE id = 'group-1'")
        .execute(database.pool())
        .await
        .expect("unused group should be deletable");
    let group_id: Option<String> =
        sqlx::query_scalar("SELECT group_id FROM servers WHERE id = 'server-1'")
            .fetch_one(database.pool())
            .await
            .expect("server group reference should be readable");
    assert_eq!(group_id, None);
}

async fn table_names(database: &Database) -> HashSet<String> {
    sqlx::query(
        "SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_sqlx_%'",
    )
    .fetch_all(database.pool())
    .await
    .expect("table names should be readable")
    .into_iter()
    .map(|row| row.get("name"))
    .collect()
}

async fn column_names(database: &Database, table: &str) -> HashSet<String> {
    let query = match table {
        "groups" => "PRAGMA table_info('groups')",
        "servers" => "PRAGMA table_info('servers')",
        _ => panic!("unexpected table {table}"),
    };
    sqlx::query(query)
        .fetch_all(database.pool())
        .await
        .expect("column names should be readable")
        .into_iter()
        .map(|row| row.get("name"))
        .collect()
}

fn set<const N: usize>(values: [&str; N]) -> HashSet<String> {
    values.into_iter().map(str::to_owned).collect()
}
