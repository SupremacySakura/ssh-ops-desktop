use std::{path::Path, time::Duration};

use opspilot_domain::{CoreError, CoreErrorCode};
use sqlx::{
    SqlitePool,
    migrate::Migrator,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
};

static MIGRATOR: Migrator = sqlx::migrate!("./migrations");

const BUSY_TIMEOUT: Duration = Duration::from_millis(5_000);

/// Owns the shared SQLite connection pool used by persistence repositories.
#[derive(Clone, Debug)]
pub struct Database {
    pool: SqlitePool,
}

impl Database {
    /// Opens a file database, or the single-connection in-memory database when
    /// `path` is `:memory:`, and applies all embedded migrations.
    pub async fn open(path: impl AsRef<Path>) -> Result<Self, CoreError> {
        let path = path.as_ref();
        if path == Path::new(":memory:") {
            return Self::open_in_memory().await;
        }

        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(BUSY_TIMEOUT);

        Self::connect(options, 5).await
    }

    /// Opens a single-connection in-memory database.
    pub async fn open_in_memory() -> Result<Self, CoreError> {
        let options = SqliteConnectOptions::new()
            .in_memory(true)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Memory)
            .busy_timeout(BUSY_TIMEOUT);

        Self::connect(options, 1).await
    }

    /// Returns the pool shared by all repositories.
    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    async fn connect(
        options: SqliteConnectOptions,
        max_connections: u32,
    ) -> Result<Self, CoreError> {
        let pool = SqlitePoolOptions::new()
            .max_connections(max_connections)
            .connect_with(options)
            .await
            .map_err(|error| database_error("open SQLite database", error))?;

        validate_legacy_secret_references(&pool).await?;
        validate_legacy_server_identities(&pool).await?;
        validate_server_secret_reference_uniqueness(&pool).await?;

        MIGRATOR
            .run(&pool)
            .await
            .map_err(|error| database_error("apply SQLite migrations", error))?;
        validate_server_secret_reference_index(&pool).await?;

        Ok(Self { pool })
    }
}

async fn validate_server_secret_reference_uniqueness(pool: &SqlitePool) -> Result<(), CoreError> {
    let requires_uniqueness_migration: i64 = sqlx::query_scalar(
        "SELECT
            EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'servers')
            AND EXISTS(
                SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'secret_refs'
            )
            AND NOT EXISTS(
                SELECT 1 FROM sqlite_master
                WHERE type = 'index' AND name = 'idx_servers_unique_secret_ref'
            )",
    )
    .fetch_one(pool)
    .await
    .map_err(|error| database_error("inspect server credential migration state", error))?;

    if requires_uniqueness_migration == 0 {
        return Ok(());
    }

    let shared_server_ids: Option<String> = sqlx::query_scalar(
        "SELECT group_concat(id, ', ')
         FROM (
             SELECT secret_ref, id
             FROM servers
             WHERE secret_ref IS NOT NULL
             ORDER BY secret_ref, id
         )
         GROUP BY secret_ref
         HAVING COUNT(*) > 1
         ORDER BY secret_ref
         LIMIT 1",
    )
    .fetch_optional(pool)
    .await
    .map_err(|error| database_error("validate server credential references", error))?;

    if let Some(server_ids) = shared_server_ids {
        return Err(CoreError::new(
            CoreErrorCode::Validation,
            format!(
                "cannot migrate server credential references: servers [{server_ids}] share one \
                 credential reference; modify the duplicate references before retrying"
            ),
            false,
        ));
    }

    Ok(())
}

async fn validate_server_secret_reference_index(pool: &SqlitePool) -> Result<(), CoreError> {
    let index: Option<(i64, i64, Option<String>)> = sqlx::query_as(
        "SELECT indexes.[unique], indexes.partial, schema.sql
         FROM pragma_index_list('servers') AS indexes
         JOIN sqlite_master AS schema ON schema.type = 'index' AND schema.name = indexes.name
         WHERE indexes.name = 'idx_servers_unique_secret_ref'",
    )
    .fetch_optional(pool)
    .await
    .map_err(|error| database_error("verify server credential uniqueness constraint", error))?;
    let valid = index.is_some_and(|(unique, partial, sql)| {
        unique == 1
            && partial == 1
            && sql.is_some_and(|sql| {
                let normalized = sql
                    .split_whitespace()
                    .collect::<String>()
                    .to_ascii_lowercase();
                normalized.trim_end_matches(';')
                    == "createuniqueindexidx_servers_unique_secret_refonservers(secret_ref)\
                        wheresecret_refisnotnull"
            })
    });
    if !valid {
        return Err(CoreError::new(
            CoreErrorCode::Internal,
            "required server credential reference uniqueness constraint is missing or invalid",
            false,
        ));
    }

    Ok(())
}

async fn validate_legacy_server_identities(pool: &SqlitePool) -> Result<(), CoreError> {
    let requires_identity_migration: i64 = sqlx::query_scalar(
        "SELECT
            EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'servers')
            AND NOT EXISTS(
                SELECT 1 FROM sqlite_master
                WHERE type = 'index' AND name = 'idx_servers_normalized_identity'
            )",
    )
    .fetch_one(pool)
    .await
    .map_err(|error| database_error("inspect server catalog migration state", error))?;

    if requires_identity_migration == 0 {
        return Ok(());
    }

    let duplicate: Option<(String, i64, String, String)> = sqlx::query_as(
        "SELECT normalized_host, port, normalized_username, group_concat(id, ', ')
         FROM (
             SELECT id, lower(trim(host)) AS normalized_host, port,
                    trim(username) AS normalized_username
             FROM servers
             ORDER BY id
         )
         GROUP BY normalized_host, port, normalized_username
         HAVING COUNT(*) > 1
         ORDER BY normalized_host, port, normalized_username
         LIMIT 1",
    )
    .fetch_optional(pool)
    .await
    .map_err(|error| database_error("validate legacy server identities", error))?;

    if let Some((host, port, username, server_ids)) = duplicate {
        return Err(CoreError::new(
            CoreErrorCode::Validation,
            format!(
                "cannot migrate server catalog: servers [{server_ids}] share normalized identity \
                 host '{host}', port {port}, username '{username}'; modify or delete the duplicate \
                 records before retrying"
            ),
            false,
        ));
    }

    Ok(())
}

async fn validate_legacy_secret_references(pool: &SqlitePool) -> Result<(), CoreError> {
    let requires_secret_ref_migration: i64 = sqlx::query_scalar(
        "SELECT
            EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'servers')
            AND NOT EXISTS(
                SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'secret_refs'
            )",
    )
    .fetch_one(pool)
    .await
    .map_err(|error| database_error("inspect SQLite migration state", error))?;

    if requires_secret_ref_migration == 0 {
        return Ok(());
    }

    let unsupported_owner: Option<(String, String)> = sqlx::query_as(
        "SELECT id, auth_type
         FROM servers
         WHERE secret_ref IS NOT NULL
           AND auth_type NOT IN ('password', 'private_key', 'certificate')
         ORDER BY id
         LIMIT 1",
    )
    .fetch_optional(pool)
    .await
    .map_err(|error| database_error("validate legacy secret references", error))?;

    if let Some((server_id, auth_type)) = unsupported_owner {
        return Err(CoreError::new(
            CoreErrorCode::Validation,
            format!(
                "cannot migrate legacy secret references: server '{server_id}' uses auth_type \
                 '{auth_type}' with a stale secret_ref; clear that reference before retrying"
            ),
            false,
        ));
    }

    let shared_reference: Option<(String, String)> = sqlx::query_as(
        "SELECT secret_ref, group_concat(id, ', ')
         FROM (
             SELECT secret_ref, id
             FROM servers
             WHERE secret_ref IS NOT NULL
             ORDER BY secret_ref, id
         )
         GROUP BY secret_ref
         HAVING COUNT(*) > 1
         ORDER BY secret_ref
         LIMIT 1",
    )
    .fetch_optional(pool)
    .await
    .map_err(|error| database_error("validate legacy secret references", error))?;

    if let Some((secret_ref, server_ids)) = shared_reference {
        return Err(CoreError::new(
            CoreErrorCode::Validation,
            format!(
                "cannot migrate legacy secret references: secret_ref '{secret_ref}' is shared by \
                 servers [{server_ids}]; assign each server a unique secret_ref before retrying"
            ),
            false,
        ));
    }

    Ok(())
}

fn database_error(context: &str, error: impl std::fmt::Display) -> CoreError {
    CoreError::new(
        CoreErrorCode::Internal,
        format!("failed to {context}: {error}"),
        false,
    )
}
