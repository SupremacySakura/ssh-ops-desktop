use std::str::FromStr;

use opspilot_domain::{CoreError, CoreErrorCode, Id, Server, ServerInput};
use sqlx::{Row, sqlite::SqliteRow};

use crate::Database;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BatchCreateResult {
    pub created: Vec<Server>,
    pub skipped: usize,
}

/// SQLite-backed catalog repository for servers.
#[derive(Clone, Debug)]
pub struct ServerRepository {
    database: Database,
}

impl ServerRepository {
    pub fn new(database: Database) -> Self {
        Self { database }
    }

    pub async fn list(&self) -> Result<Vec<Server>, CoreError> {
        let rows = sqlx::query(
            "SELECT id, name, host, port, user, auth_type, secret_ref, group_id,
                    favorite, last_connected_at, created_at
             FROM servers
             ORDER BY favorite DESC,
                      CASE WHEN last_connected_at IS NULL THEN 1 ELSE 0 END,
                      last_connected_at DESC,
                      name COLLATE NOCASE ASC,
                      created_at DESC",
        )
        .fetch_all(self.database.pool())
        .await
        .map_err(|error| repository_error("list servers", error))?;

        rows.iter().map(server_from_row).collect()
    }

    pub async fn get(&self, id: Id) -> Result<Server, CoreError> {
        let row = sqlx::query(
            "SELECT id, name, host, port, user, auth_type, secret_ref, group_id,
                    favorite, last_connected_at, created_at
             FROM servers
             WHERE id = ?",
        )
        .bind(id.to_string())
        .fetch_optional(self.database.pool())
        .await
        .map_err(|error| repository_error("read server", error))?
        .ok_or_else(|| not_found("服务器不存在"))?;

        server_from_row(&row)
    }

    pub async fn create(&self, input: &ServerInput, created_at: i64) -> Result<Server, CoreError> {
        let id = Id::new();
        sqlx::query(
            "INSERT INTO servers (
                id, name, host, port, user, auth_type, secret_ref, group_id,
                favorite, last_connected_at, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)",
        )
        .bind(id.to_string())
        .bind(input.name())
        .bind(input.host().as_str())
        .bind(i64::from(input.port().get()))
        .bind(input.user())
        .bind(input.auth_type().as_str())
        .bind(input.secret_ref())
        .bind(input.group_id().map(|group_id| group_id.to_string()))
        .bind(i64::from(input.favorite()))
        .bind(created_at)
        .execute(self.database.pool())
        .await
        .map_err(map_server_write_error)?;

        self.get(id).await
    }

    pub async fn update(&self, id: Id, input: &ServerInput) -> Result<Server, CoreError> {
        let result = sqlx::query(
            "UPDATE servers
             SET name = ?, host = ?, port = ?, user = ?, auth_type = ?, secret_ref = ?,
                 group_id = ?, favorite = ?
             WHERE id = ?",
        )
        .bind(input.name())
        .bind(input.host().as_str())
        .bind(i64::from(input.port().get()))
        .bind(input.user())
        .bind(input.auth_type().as_str())
        .bind(input.secret_ref())
        .bind(input.group_id().map(|group_id| group_id.to_string()))
        .bind(i64::from(input.favorite()))
        .bind(id.to_string())
        .execute(self.database.pool())
        .await
        .map_err(map_server_write_error)?;
        if result.rows_affected() == 0 {
            return Err(not_found("服务器不存在"));
        }

        self.get(id).await
    }

    pub async fn create_many_skip_duplicates(
        &self,
        inputs: &[ServerInput],
        created_at: i64,
    ) -> Result<BatchCreateResult, CoreError> {
        let mut transaction = self
            .database
            .pool()
            .begin()
            .await
            .map_err(|error| repository_error("begin server batch import", error))?;
        let mut created = Vec::new();
        for input in inputs {
            let id = Id::new();
            let row = sqlx::query(
                "INSERT INTO servers (
                    id, name, host, port, user, auth_type, secret_ref, group_id,
                    favorite, last_connected_at, created_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
                 ON CONFLICT(host, port, user) DO NOTHING
                 RETURNING id, name, host, port, user, auth_type, secret_ref, group_id,
                           favorite, last_connected_at, created_at",
            )
            .bind(id.to_string())
            .bind(input.name())
            .bind(input.host().as_str())
            .bind(i64::from(input.port().get()))
            .bind(input.user())
            .bind(input.auth_type().as_str())
            .bind(input.secret_ref())
            .bind(input.group_id().map(|group_id| group_id.to_string()))
            .bind(i64::from(input.favorite()))
            .bind(created_at)
            .fetch_optional(&mut *transaction)
            .await
            .map_err(map_server_write_error)?;
            if let Some(row) = row {
                created.push(server_from_row(&row)?);
            }
        }
        transaction
            .commit()
            .await
            .map_err(|error| repository_error("commit server batch import", error))?;

        Ok(BatchCreateResult {
            skipped: inputs.len().saturating_sub(created.len()),
            created,
        })
    }

    pub async fn set_favorite(&self, id: Id, favorite: bool) -> Result<Server, CoreError> {
        let result = sqlx::query("UPDATE servers SET favorite = ? WHERE id = ?")
            .bind(i64::from(favorite))
            .bind(id.to_string())
            .execute(self.database.pool())
            .await
            .map_err(map_server_write_error)?;
        if result.rows_affected() == 0 {
            return Err(not_found("服务器不存在"));
        }

        self.get(id).await
    }

    pub async fn mark_connected(&self, id: Id, connected_at: i64) -> Result<Server, CoreError> {
        let result = sqlx::query("UPDATE servers SET last_connected_at = ? WHERE id = ?")
            .bind(connected_at)
            .bind(id.to_string())
            .execute(self.database.pool())
            .await
            .map_err(map_server_write_error)?;
        if result.rows_affected() == 0 {
            return Err(not_found("服务器不存在"));
        }

        self.get(id).await
    }

    pub async fn delete(&self, id: Id) -> Result<(), CoreError> {
        let result = sqlx::query("DELETE FROM servers WHERE id = ?")
            .bind(id.to_string())
            .execute(self.database.pool())
            .await
            .map_err(map_server_write_error)?;
        if result.rows_affected() == 0 {
            return Err(not_found("服务器不存在"));
        }

        Ok(())
    }
}

fn server_from_row(row: &SqliteRow) -> Result<Server, CoreError> {
    let id: String = row
        .try_get("id")
        .map_err(|error| repository_error("decode server id", error))?;
    let id = Id::from_str(&id).map_err(|_error| {
        CoreError::new(CoreErrorCode::Internal, "服务器记录损坏，无法读取", false)
    })?;
    let auth_type: String = row
        .try_get("auth_type")
        .map_err(|error| repository_error("decode server auth type", error))?;
    let group_id: Option<String> = row
        .try_get("group_id")
        .map_err(|error| repository_error("decode server group", error))?;
    let group_id = group_id
        .map(|value| {
            Id::from_str(&value).map_err(|_error| {
                CoreError::new(
                    CoreErrorCode::Internal,
                    "服务器分组记录损坏，无法读取",
                    false,
                )
            })
        })
        .transpose()?;
    let favorite: i64 = row
        .try_get("favorite")
        .map_err(|error| repository_error("decode server favorite", error))?;
    let port: i64 = row
        .try_get("port")
        .map_err(|error| repository_error("decode server port", error))?;
    let port = u16::try_from(port).map_err(|_error| {
        CoreError::new(
            CoreErrorCode::Internal,
            "服务器端口记录无效，无法读取",
            false,
        )
    })?;

    Ok(Server {
        id,
        name: row
            .try_get("name")
            .map_err(|error| repository_error("decode server name", error))?,
        host: row
            .try_get("host")
            .map_err(|error| repository_error("decode server host", error))?,
        port,
        user: row
            .try_get("user")
            .map_err(|error| repository_error("decode server user", error))?,
        auth_type: opspilot_domain::AuthType::from_persisted(&auth_type)?,
        secret_ref: row
            .try_get("secret_ref")
            .map_err(|error| repository_error("decode server secret reference", error))?,
        group_id,
        favorite: favorite != 0,
        last_connected_at: row
            .try_get("last_connected_at")
            .map_err(|error| repository_error("decode server connection time", error))?,
        created_at: row
            .try_get("created_at")
            .map_err(|error| repository_error("decode server creation time", error))?,
    })
}

fn not_found(message: impl Into<String>) -> CoreError {
    CoreError::new(CoreErrorCode::NotFound, message, false)
}

fn repository_error(context: &str, error: impl std::fmt::Display) -> CoreError {
    let _ = (context, error);
    CoreError::new(
        CoreErrorCode::Internal,
        "本地数据库操作失败，请稍后重试",
        false,
    )
}

fn map_server_write_error(error: sqlx::Error) -> CoreError {
    if error
        .as_database_error()
        .is_some_and(sqlx::error::DatabaseError::is_unique_violation)
    {
        return CoreError::new(
            CoreErrorCode::Conflict,
            "主机、端口和用户名相同的服务器已存在",
            false,
        );
    }

    repository_error("write server", error)
}
