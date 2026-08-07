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

        MIGRATOR
            .run(&pool)
            .await
            .map_err(|error| database_error("apply SQLite migrations", error))?;

        Ok(Self { pool })
    }
}

fn database_error(context: &str, error: impl std::fmt::Display) -> CoreError {
    CoreError::new(
        CoreErrorCode::Internal,
        format!("failed to {context}: {error}"),
        false,
    )
}
