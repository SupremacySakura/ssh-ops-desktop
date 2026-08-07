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

        MIGRATOR
            .run(&pool)
            .await
            .map_err(|error| database_error("apply SQLite migrations", error))?;

        Ok(Self { pool })
    }
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
