use opspilot_domain::CoreErrorCode;
use opspilot_persistence::Database;
use sqlx::{
    SqlitePool,
    migrate::Migrator,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use tempfile::tempdir;

static MIGRATOR: Migrator = sqlx::migrate!("./migrations");

#[tokio::test]
async fn migration_reports_normalized_legacy_server_identity_conflicts() {
    let directory = tempdir().expect("temporary directory should be created");
    let database_path = directory.path().join("duplicate-server-upgrade.sqlite3");
    let pool = open_v2_database(&database_path).await;
    insert_v2_server(
        &pool,
        "legacy-a",
        " EXAMPLE.com ",
        " deploy ",
        "2026-08-07T12:34:56Z",
    )
    .await;
    insert_v2_server(
        &pool,
        "legacy-b",
        "example.COM",
        "deploy",
        "2026-08-07T12:34:56Z",
    )
    .await;
    pool.close().await;

    let error = Database::open(&database_path)
        .await
        .expect_err("normalized duplicates must stop with an actionable diagnostic");

    assert_eq!(error.code(), CoreErrorCode::Validation);
    for expected in [
        "legacy-a",
        "legacy-b",
        "example.com",
        "22",
        "deploy",
        "modify or delete",
    ] {
        assert!(
            error.message().contains(expected),
            "diagnostic must contain {expected:?}: {error}"
        );
    }

    let repair_options = SqliteConnectOptions::new()
        .filename(&database_path)
        .foreign_keys(true);
    let repair_pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(repair_options)
        .await
        .expect("legacy database should reopen for repair");
    sqlx::query("UPDATE servers SET host = 'other.example.com' WHERE id = 'legacy-b'")
        .execute(&repair_pool)
        .await
        .expect("operator repair should resolve the conflicting identity");
    repair_pool.close().await;

    let upgraded = Database::open(&database_path)
        .await
        .expect("repaired legacy database should upgrade");
    let servers: Vec<(String, String)> =
        sqlx::query_as("SELECT id, environment FROM servers ORDER BY id")
            .fetch_all(upgraded.pool())
            .await
            .expect("upgraded servers should be readable");
    assert_eq!(
        servers,
        vec![
            ("legacy-a".to_owned(), "other".to_owned()),
            ("legacy-b".to_owned(), "other".to_owned()),
        ]
    );
    let identity_index_exists: i64 = sqlx::query_scalar(
        "SELECT EXISTS(
            SELECT 1 FROM sqlite_master
            WHERE type = 'index' AND name = 'idx_servers_normalized_identity'
        )",
    )
    .fetch_one(upgraded.pool())
    .await
    .expect("identity index state should be readable");
    assert_eq!(identity_index_exists, 1);
    let migration_version: i64 = sqlx::query_scalar("SELECT MAX(version) FROM _sqlx_migrations")
        .fetch_one(upgraded.pool())
        .await
        .expect("migration version should be readable");
    assert!(migration_version >= 4);
}

#[tokio::test]
async fn migration_reports_shared_v3_server_secret_references() {
    let directory = tempdir().expect("temporary directory should be created");
    let database_path = directory.path().join("shared-secret-upgrade.sqlite3");
    let pool = open_v3_database(&database_path).await;
    insert_v2_server(
        &pool,
        "legacy-a",
        "first.example.com",
        "deploy",
        "2026-08-07T12:34:56Z",
    )
    .await;
    insert_v2_server(
        &pool,
        "legacy-b",
        "second.example.com",
        "deploy",
        "2026-08-07T12:34:56Z",
    )
    .await;
    let secret_ref = "must-not-appear-in-migration-errors";
    sqlx::query(
        "INSERT INTO secret_refs (ref, kind, owner_type, owner_id, created_at, updated_at)
         VALUES (?, 'password', 'server', 'legacy-a', ?, ?)",
    )
    .bind(secret_ref)
    .bind("2026-08-07T12:34:56Z")
    .bind("2026-08-07T12:34:56Z")
    .execute(&pool)
    .await
    .expect("v3 credential metadata fixture should be inserted");
    sqlx::query("UPDATE servers SET secret_ref = ? WHERE id IN ('legacy-a', 'legacy-b')")
        .bind(secret_ref)
        .execute(&pool)
        .await
        .expect("v3 permits the shared credential reference fixture");
    pool.close().await;

    let error = Database::open(&database_path)
        .await
        .expect_err("shared credential references must stop before the unique-index migration");

    assert_eq!(error.code(), CoreErrorCode::Validation);
    for expected in ["legacy-a", "legacy-b", "credential reference", "modify"] {
        assert!(
            error.message().contains(expected),
            "diagnostic must contain {expected:?}: {error}"
        );
    }
    assert!(!error.message().contains(secret_ref));

    let repair_options = SqliteConnectOptions::new()
        .filename(&database_path)
        .foreign_keys(true);
    let repair_pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(repair_options)
        .await
        .expect("v3 database should reopen for repair");
    sqlx::query("UPDATE servers SET secret_ref = NULL WHERE id = 'legacy-b'")
        .execute(&repair_pool)
        .await
        .expect("operator repair should remove the shared reference");
    repair_pool.close().await;

    let upgraded = Database::open(&database_path)
        .await
        .expect("repaired v3 database should upgrade");
    let secret_ref_index: (i64, i64) = sqlx::query_as(
        "SELECT [unique], partial
         FROM pragma_index_list('servers')
         WHERE name = 'idx_servers_unique_secret_ref'",
    )
    .fetch_one(upgraded.pool())
    .await
    .expect("server secret reference unique index should exist");
    assert_eq!(secret_ref_index, (1, 1));
    let migration_version: i64 = sqlx::query_scalar("SELECT MAX(version) FROM _sqlx_migrations")
        .fetch_one(upgraded.pool())
        .await
        .expect("migration version should be readable");
    assert!(migration_version >= 4);
}

async fn open_v2_database(path: &std::path::Path) -> SqlitePool {
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
        .run_to(2, &pool)
        .await
        .expect("v2 migrations should apply");
    pool
}

async fn open_v3_database(path: &std::path::Path) -> SqlitePool {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .expect("v3 database should open");
    MIGRATOR
        .run_to(3, &pool)
        .await
        .expect("v3 migrations should apply");
    pool
}

async fn insert_v2_server(
    pool: &SqlitePool,
    id: &str,
    host: &str,
    username: &str,
    timestamp: &str,
) {
    sqlx::query(
        "INSERT INTO servers (
            id, name, host, port, username, auth_type, created_at, updated_at
         ) VALUES (?, ?, ?, 22, ?, 'ssh_agent', ?, ?)",
    )
    .bind(id)
    .bind(format!("Server {id}"))
    .bind(host)
    .bind(username)
    .bind(timestamp)
    .bind(timestamp)
    .execute(pool)
    .await
    .expect("legacy server should be inserted");
}
