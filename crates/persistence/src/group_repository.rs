use std::str::FromStr;

use opspilot_domain::{CoreError, CoreErrorCode, Id, ServerGroup};
use sqlx::{Row, sqlite::SqliteRow};

use crate::Database;

/// SQLite-backed catalog repository for single-level server groups.
#[derive(Clone, Debug)]
pub struct GroupRepository {
    database: Database,
}

impl GroupRepository {
    pub fn new(database: Database) -> Self {
        Self { database }
    }

    pub async fn list(&self) -> Result<Vec<ServerGroup>, CoreError> {
        let rows = sqlx::query(
            "SELECT id, name, sort_order
             FROM groups
             ORDER BY sort_order ASC, name COLLATE NOCASE ASC",
        )
        .fetch_all(self.database.pool())
        .await
        .map_err(|error| repository_error("list groups", error))?;

        rows.iter().map(group_from_row).collect()
    }

    pub async fn get(&self, id: Id) -> Result<ServerGroup, CoreError> {
        let row = sqlx::query("SELECT id, name, sort_order FROM groups WHERE id = ?")
            .bind(id.to_string())
            .fetch_optional(self.database.pool())
            .await
            .map_err(|error| repository_error("read group", error))?
            .ok_or_else(|| CoreError::new(CoreErrorCode::NotFound, "分组不存在", false))?;

        group_from_row(&row)
    }

    pub async fn create(&self, name: &str, sort_order: i64) -> Result<ServerGroup, CoreError> {
        let group = ServerGroup::try_new(name, sort_order)?;
        sqlx::query("INSERT INTO groups (id, name, sort_order) VALUES (?, ?, ?)")
            .bind(group.id.to_string())
            .bind(&group.name)
            .bind(group.sort_order)
            .execute(self.database.pool())
            .await
            .map_err(map_group_write_error)?;

        Ok(group)
    }

    pub async fn update(
        &self,
        id: Id,
        name: &str,
        sort_order: i64,
    ) -> Result<ServerGroup, CoreError> {
        let normalized = ServerGroup::try_new(name, sort_order)?;
        let result = sqlx::query("UPDATE groups SET name = ?, sort_order = ? WHERE id = ?")
            .bind(normalized.name)
            .bind(normalized.sort_order)
            .bind(id.to_string())
            .execute(self.database.pool())
            .await
            .map_err(map_group_write_error)?;
        if result.rows_affected() == 0 {
            return Err(CoreError::new(CoreErrorCode::NotFound, "分组不存在", false));
        }

        self.get(id).await
    }

    pub async fn delete(&self, id: Id) -> Result<(), CoreError> {
        let result = sqlx::query("DELETE FROM groups WHERE id = ?")
            .bind(id.to_string())
            .execute(self.database.pool())
            .await
            .map_err(map_group_write_error)?;
        if result.rows_affected() == 0 {
            return Err(CoreError::new(CoreErrorCode::NotFound, "分组不存在", false));
        }

        Ok(())
    }
}

fn group_from_row(row: &SqliteRow) -> Result<ServerGroup, CoreError> {
    let id: String = row
        .try_get("id")
        .map_err(|error| repository_error("decode group id", error))?;
    let id = Id::from_str(&id).map_err(|error| {
        CoreError::new(
            CoreErrorCode::Internal,
            format!("failed to decode persisted group id: {error}"),
            false,
        )
    })?;

    Ok(ServerGroup {
        id,
        name: row
            .try_get("name")
            .map_err(|error| repository_error("decode group name", error))?,
        sort_order: row
            .try_get("sort_order")
            .map_err(|error| repository_error("decode group sort order", error))?,
    })
}

fn repository_error(context: &str, error: impl std::fmt::Display) -> CoreError {
    CoreError::new(
        CoreErrorCode::Internal,
        format!("failed to {context}: {error}"),
        false,
    )
}

fn map_group_write_error(error: sqlx::Error) -> CoreError {
    if error
        .as_database_error()
        .is_some_and(sqlx::error::DatabaseError::is_unique_violation)
    {
        return CoreError::new(CoreErrorCode::Conflict, "分组名称已存在", false);
    }

    repository_error("write group", error)
}
