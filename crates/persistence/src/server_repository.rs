use std::str::FromStr;

use opspilot_domain::{CoreError, CoreErrorCode, Id, Server, ServerInput};
use sqlx::{Row, sqlite::SqliteRow};

use crate::Database;

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
    let id = Id::from_str(&id).map_err(|error| {
        CoreError::new(
            CoreErrorCode::Internal,
            format!("failed to decode persisted server id: {error}"),
            false,
        )
    })?;
    let auth_type: String = row
        .try_get("auth_type")
        .map_err(|error| repository_error("decode server auth type", error))?;
    let group_id: Option<String> = row
        .try_get("group_id")
        .map_err(|error| repository_error("decode server group", error))?;
    let group_id = group_id
        .map(|value| {
            Id::from_str(&value).map_err(|error| {
                CoreError::new(
                    CoreErrorCode::Internal,
                    format!("failed to decode persisted group id: {error}"),
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
    let port = u16::try_from(port).map_err(|error| {
        CoreError::new(
            CoreErrorCode::Internal,
            format!("persisted server port is invalid: {error}"),
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
    CoreError::new(
        CoreErrorCode::Internal,
        format!("failed to {context}: {error}"),
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
