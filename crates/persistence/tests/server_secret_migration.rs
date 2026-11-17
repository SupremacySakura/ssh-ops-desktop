use sqlx::{
    Row,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};

#[tokio::test]
async fn nullable_secret_migration_preserves_servers_and_known_host_keys() {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .in_memory(true)
                .foreign_keys(true),
        )
        .await
        .expect("in-memory database should open");

    sqlx::raw_sql(include_str!("../migrations/0001_harbor.sql"))
        .execute(&pool)
        .await
        .expect("baseline schema should apply");
    sqlx::query(
        "INSERT INTO servers (
            id, name, host, port, user, auth_type, secret_ref, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind("server-1")
    .bind("prod-web-01")
    .bind("prod.example.com")
    .bind(22_i64)
    .bind("deploy")
    .bind("key")
    .bind("existing-secret-ref")
    .bind(1_700_000_000_i64)
    .execute(&pool)
    .await
    .expect("existing server fixture should be inserted");
    sqlx::query(
        "INSERT INTO known_host_keys (
            server_id, host, port, algorithm, public_key_base64, sha256, trusted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind("server-1")
    .bind("prod.example.com")
    .bind(22_i64)
    .bind("fixture-algorithm")
    .bind("fixture-public-key")
    .bind("SHA256:fixture")
    .bind("2026-11-17T00:00:00Z")
    .execute(&pool)
    .await
    .expect("known host fixture should be inserted");

    let mut transaction = pool
        .begin()
        .await
        .expect("migration transaction should start");
    sqlx::raw_sql(include_str!(
        "../migrations/0002_nullable_server_secret_ref.sql"
    ))
    .execute(&mut *transaction)
    .await
    .expect("nullable secret migration should apply");
    transaction
        .commit()
        .await
        .expect("nullable secret migration should commit");

    let existing: Option<String> =
        sqlx::query_scalar("SELECT secret_ref FROM servers WHERE id = 'server-1'")
            .fetch_one(&pool)
            .await
            .expect("existing server should survive");
    assert_eq!(existing.as_deref(), Some("existing-secret-ref"));

    sqlx::query(
        "INSERT INTO servers (
            id, name, host, port, user, auth_type, secret_ref, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)",
    )
    .bind("server-2")
    .bind("imported")
    .bind("imported.example.com")
    .bind(22_i64)
    .bind("deploy")
    .bind("key")
    .bind(1_700_000_001_i64)
    .execute(&pool)
    .await
    .expect("pending credential server should be accepted");

    let known_hosts: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM known_host_keys WHERE server_id = 'server-1'")
            .fetch_one(&pool)
            .await
            .expect("known host count should be readable");
    assert_eq!(known_hosts, 1);
    let violations = sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&pool)
        .await
        .expect("foreign key check should run");
    assert!(violations.is_empty());
    let pending = sqlx::query("SELECT secret_ref FROM servers WHERE id = 'server-2'")
        .fetch_one(&pool)
        .await
        .expect("pending server should be readable");
    assert_eq!(pending.get::<Option<String>, _>("secret_ref"), None);
}
