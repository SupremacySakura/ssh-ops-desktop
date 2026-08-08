use std::str::FromStr;

use opspilot_domain::{
    AuthType, CoreError, CoreErrorCode, Id, ServerEnvironment, ServerGroup, ServerInput,
    ServerSummary, ServerTag,
};
use opspilot_secrets::SecretRef;
use sqlx::{Sqlite, Transaction};

use crate::Database;

#[derive(Clone, Debug)]
pub struct ServerRepository {
    database: Database,
}

impl ServerRepository {
    pub fn new(database: Database) -> Self {
        Self { database }
    }

    pub async fn create(&self, input: ServerInput) -> Result<ServerSummary, CoreError> {
        self.create_many(vec![input])
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| repository_error("create server", "empty create result"))
    }

    pub async fn create_many(
        &self,
        inputs: Vec<ServerInput>,
    ) -> Result<Vec<ServerSummary>, CoreError> {
        let mut transaction = self
            .database
            .pool()
            .begin()
            .await
            .map_err(|error| repository_error("begin server create transaction", error))?;
        let mut created = Vec::with_capacity(inputs.len());
        for input in inputs {
            created.push(insert_server(&mut transaction, input).await?);
        }

        transaction
            .commit()
            .await
            .map_err(|error| repository_error("commit server create transaction", error))?;
        Ok(created)
    }

    pub async fn list(&self) -> Result<Vec<ServerSummary>, CoreError> {
        let rows = sqlx::query_as::<_, ServerRow>(
            "SELECT id, name, host, port, username, environment, auth_type, group_id,
                    last_connected_at
             FROM servers
             ORDER BY lower(name), id",
        )
        .fetch_all(self.database.pool())
        .await
        .map_err(|error| repository_error("list servers", error))?;
        let mut servers = Vec::with_capacity(rows.len());
        for row in rows {
            servers.push(self.summary_from_row(row).await?);
        }
        Ok(servers)
    }

    pub async fn get(&self, id: Id) -> Result<ServerSummary, CoreError> {
        let row = sqlx::query_as::<_, ServerRow>(
            "SELECT id, name, host, port, username, environment, auth_type, group_id,
                    last_connected_at
             FROM servers WHERE id = ?",
        )
        .bind(id.to_string())
        .fetch_optional(self.database.pool())
        .await
        .map_err(|error| repository_error("get server", error))?
        .ok_or_else(|| not_found("server"))?;

        self.summary_from_row(row).await
    }

    pub async fn update(&self, id: Id, input: ServerInput) -> Result<ServerSummary, CoreError> {
        let mut transaction = self
            .database
            .pool()
            .begin()
            .await
            .map_err(|error| repository_error("begin server update transaction", error))?;
        let result = sqlx::query(
            "UPDATE servers
             SET name = ?, host = ?, port = ?, username = ?, environment = ?, auth_type = ?,
                 group_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?",
        )
        .bind(input.name())
        .bind(input.host().as_str())
        .bind(i64::from(input.port().get()))
        .bind(input.username())
        .bind(input.environment().as_str())
        .bind(input.auth_type().as_str())
        .bind(input.group_id().map(|group_id| group_id.to_string()))
        .bind(id.to_string())
        .execute(&mut *transaction)
        .await
        .map_err(map_server_write_error)?;
        if result.rows_affected() == 0 {
            return Err(not_found("server"));
        }

        sqlx::query("DELETE FROM server_tags WHERE server_id = ?")
            .bind(id.to_string())
            .execute(&mut *transaction)
            .await
            .map_err(|error| repository_error("clear server tag links", error))?;
        for tag_id in input.tag_ids() {
            sqlx::query(
                "INSERT INTO server_tags (server_id, tag_id, created_at)
                 VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
            )
            .bind(id.to_string())
            .bind(tag_id.to_string())
            .execute(&mut *transaction)
            .await
            .map_err(map_server_tag_link_error)?;
        }

        transaction
            .commit()
            .await
            .map_err(|error| repository_error("commit server update transaction", error))?;
        self.get(id).await
    }

    pub async fn deletion_secret_ref(&self, id: Id) -> Result<Option<SecretRef>, CoreError> {
        let (secret_ref,): (Option<String>,) =
            sqlx::query_as("SELECT secret_ref FROM servers WHERE id = ?")
                .bind(id.to_string())
                .fetch_optional(self.database.pool())
                .await
                .map_err(|error| repository_error("read server secret reference", error))?
                .ok_or_else(|| not_found("server"))?;
        let Some(secret_ref) = secret_ref else {
            return Ok(None);
        };
        let secret_ref = SecretRef::from_persisted(secret_ref)?;
        let metadata: Option<(String, String, i64)> = sqlx::query_as(
            "SELECT owner_type, owner_id,
                    (SELECT COUNT(*) FROM servers WHERE secret_ref = ?)
             FROM secret_refs
             WHERE ref = ?",
        )
        .bind(secret_ref.as_str())
        .bind(secret_ref.as_str())
        .fetch_optional(self.database.pool())
        .await
        .map_err(|error| repository_error("validate server credential metadata", error))?;
        let Some((owner_type, owner_id, reference_count)) = metadata else {
            return Err(credential_metadata_invariant());
        };
        if owner_type != "server" || owner_id != id.to_string() || reference_count != 1 {
            return Err(credential_metadata_invariant());
        }

        Ok(Some(secret_ref))
    }

    pub async fn delete(
        &self,
        id: Id,
        expected_secret_ref: Option<&SecretRef>,
    ) -> Result<(), CoreError> {
        let mut transaction = self
            .database
            .pool()
            .begin()
            .await
            .map_err(|error| repository_error("begin server delete transaction", error))?;
        let result = sqlx::query("DELETE FROM servers WHERE id = ? AND secret_ref IS ?")
            .bind(id.to_string())
            .bind(expected_secret_ref.map(SecretRef::as_str))
            .execute(&mut *transaction)
            .await
            .map_err(|error| repository_error("delete server", error))?;
        if result.rows_affected() == 0 {
            let server_exists: i64 =
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM servers WHERE id = ?)")
                    .bind(id.to_string())
                    .fetch_one(&mut *transaction)
                    .await
                    .map_err(|error| repository_error("inspect server delete conflict", error))?;
            return if server_exists == 0 {
                Err(not_found("server"))
            } else {
                Err(CoreError::new(
                    CoreErrorCode::Conflict,
                    "server credential reference changed while preparing deletion; retry deletion",
                    true,
                ))
            };
        }
        if let Some(secret_ref) = expected_secret_ref {
            let metadata_result = sqlx::query(
                "DELETE FROM secret_refs
                 WHERE ref = ? AND owner_type = 'server' AND owner_id = ?",
            )
            .bind(secret_ref.as_str())
            .bind(id.to_string())
            .execute(&mut *transaction)
            .await
            .map_err(map_secret_metadata_delete_error)?;
            if metadata_result.rows_affected() != 1 {
                return Err(credential_metadata_invariant());
            }
        }

        transaction
            .commit()
            .await
            .map_err(|error| repository_error("commit server delete transaction", error))?;
        Ok(())
    }

    pub async fn list_groups(&self) -> Result<Vec<ServerGroup>, CoreError> {
        let rows = sqlx::query_as::<_, (String, String, i64)>(
            "SELECT id, name, sort_order FROM server_groups ORDER BY sort_order, lower(name), id",
        )
        .fetch_all(self.database.pool())
        .await
        .map_err(|error| repository_error("list server groups", error))?;
        rows.into_iter()
            .map(|(id, name, sort_order)| {
                Ok(ServerGroup {
                    id: parse_id(&id)?,
                    name,
                    sort_order,
                })
            })
            .collect()
    }

    pub async fn create_group(
        &self,
        name: &str,
        sort_order: i64,
    ) -> Result<ServerGroup, CoreError> {
        let group = ServerGroup {
            id: Id::new(),
            name: normalize_label(name, "server group name")?,
            sort_order,
        };
        sqlx::query(
            "INSERT INTO server_groups (id, name, sort_order, created_at, updated_at)
             VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        )
        .bind(group.id.to_string())
        .bind(&group.name)
        .bind(group.sort_order)
        .execute(self.database.pool())
        .await
        .map_err(|error| repository_error("create server group", error))?;
        Ok(group)
    }

    pub async fn update_group(
        &self,
        id: Id,
        name: &str,
        sort_order: i64,
    ) -> Result<ServerGroup, CoreError> {
        let name = normalize_label(name, "server group name")?;
        let result = sqlx::query(
            "UPDATE server_groups SET name = ?, sort_order = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
        )
        .bind(&name)
        .bind(sort_order)
        .bind(id.to_string())
        .execute(self.database.pool())
        .await
        .map_err(|error| repository_error("update server group", error))?;
        if result.rows_affected() == 0 {
            return Err(not_found("server group"));
        }
        Ok(ServerGroup {
            id,
            name,
            sort_order,
        })
    }

    pub async fn delete_group(&self, id: Id) -> Result<(), CoreError> {
        delete_catalog_row(
            &self.database,
            "DELETE FROM server_groups WHERE id = ?",
            id,
            "server group",
        )
        .await
    }

    pub async fn list_tags(&self) -> Result<Vec<ServerTag>, CoreError> {
        let rows = sqlx::query_as::<_, (String, String)>(
            "SELECT id, name FROM tags ORDER BY lower(name), id",
        )
        .fetch_all(self.database.pool())
        .await
        .map_err(|error| repository_error("list server tags", error))?;
        rows.into_iter()
            .map(|(id, name)| {
                Ok(ServerTag {
                    id: parse_id(&id)?,
                    name,
                })
            })
            .collect()
    }

    pub async fn create_tag(&self, name: &str) -> Result<ServerTag, CoreError> {
        let tag = ServerTag {
            id: Id::new(),
            name: normalize_label(name, "server tag name")?,
        };
        sqlx::query(
            "INSERT INTO tags (id, name, created_at, updated_at)
             VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                           strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        )
        .bind(tag.id.to_string())
        .bind(&tag.name)
        .execute(self.database.pool())
        .await
        .map_err(map_tag_write_error)?;
        Ok(tag)
    }

    pub async fn update_tag(&self, id: Id, name: &str) -> Result<ServerTag, CoreError> {
        let name = normalize_label(name, "server tag name")?;
        let result = sqlx::query(
            "UPDATE tags SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?",
        )
        .bind(&name)
        .bind(id.to_string())
        .execute(self.database.pool())
        .await
        .map_err(map_tag_write_error)?;
        if result.rows_affected() == 0 {
            return Err(not_found("server tag"));
        }
        Ok(ServerTag { id, name })
    }

    pub async fn delete_tag(&self, id: Id) -> Result<(), CoreError> {
        delete_catalog_row(
            &self.database,
            "DELETE FROM tags WHERE id = ?",
            id,
            "server tag",
        )
        .await
    }

    async fn summary_from_row(&self, row: ServerRow) -> Result<ServerSummary, CoreError> {
        let id = parse_id(&row.id)?;
        let tag_ids = sqlx::query_scalar::<_, String>(
            "SELECT tag_id FROM server_tags WHERE server_id = ? ORDER BY rowid",
        )
        .bind(&row.id)
        .fetch_all(self.database.pool())
        .await
        .map_err(|error| repository_error("list server tags", error))?
        .into_iter()
        .map(|tag_id| parse_id(&tag_id))
        .collect::<Result<Vec<_>, _>>()?;

        Ok(ServerSummary {
            id,
            name: row.name,
            host: row.host,
            port: u16::try_from(row.port)
                .map_err(|error| repository_error("decode server port", error))?,
            username: row.username,
            environment: ServerEnvironment::from_persisted(&row.environment)?,
            auth_type: AuthType::from_persisted(&row.auth_type)?,
            group_id: row.group_id.as_deref().map(parse_id).transpose()?,
            tag_ids,
            last_connected_at: row.last_connected_at,
        })
    }
}

async fn insert_server(
    transaction: &mut Transaction<'_, Sqlite>,
    input: ServerInput,
) -> Result<ServerSummary, CoreError> {
    let id = Id::new();
    sqlx::query(
        "INSERT INTO servers (
            id, name, host, port, username, environment, auth_type, group_id,
            created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?,
                   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
    )
    .bind(id.to_string())
    .bind(input.name())
    .bind(input.host().as_str())
    .bind(i64::from(input.port().get()))
    .bind(input.username())
    .bind(input.environment().as_str())
    .bind(input.auth_type().as_str())
    .bind(input.group_id().map(|group_id| group_id.to_string()))
    .execute(&mut **transaction)
    .await
    .map_err(map_server_write_error)?;

    for tag_id in input.tag_ids() {
        sqlx::query(
            "INSERT INTO server_tags (server_id, tag_id, created_at)
             VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        )
        .bind(id.to_string())
        .bind(tag_id.to_string())
        .execute(&mut **transaction)
        .await
        .map_err(map_server_tag_link_error)?;
    }

    Ok(ServerSummary {
        id,
        name: input.name().to_owned(),
        host: input.host().as_str().to_owned(),
        port: input.port().get(),
        username: input.username().to_owned(),
        environment: input.environment(),
        auth_type: input.auth_type(),
        group_id: input.group_id(),
        tag_ids: input.tag_ids().to_vec(),
        last_connected_at: None,
    })
}

#[derive(sqlx::FromRow)]
struct ServerRow {
    id: String,
    name: String,
    host: String,
    port: i64,
    username: String,
    environment: String,
    auth_type: String,
    group_id: Option<String>,
    last_connected_at: Option<String>,
}

async fn delete_catalog_row(
    database: &Database,
    statement: &'static str,
    id: Id,
    resource: &str,
) -> Result<(), CoreError> {
    let result = sqlx::query(statement)
        .bind(id.to_string())
        .execute(database.pool())
        .await
        .map_err(|error| repository_error(&format!("delete {resource}"), error))?;
    if result.rows_affected() == 0 {
        return Err(not_found(resource));
    }
    Ok(())
}

fn normalize_label(value: &str, field: &str) -> Result<String, CoreError> {
    let value = value.trim();
    if value.is_empty() || value.chars().any(char::is_control) {
        return Err(CoreError::new(
            CoreErrorCode::Validation,
            format!("{field} must be non-empty and contain no control characters"),
            false,
        ));
    }
    Ok(value.to_owned())
}

fn parse_id(value: &str) -> Result<Id, CoreError> {
    Id::from_str(value).map_err(|error| repository_error("decode persisted identifier", error))
}

fn not_found(resource: &str) -> CoreError {
    CoreError::new(
        CoreErrorCode::NotFound,
        format!("{resource} was not found"),
        false,
    )
}

fn map_server_write_error(error: sqlx::Error) -> CoreError {
    if is_unique_violation(&error) {
        CoreError::new(
            CoreErrorCode::Conflict,
            "a server with the same host, port, and username already exists",
            false,
        )
    } else if is_foreign_key_violation(&error) {
        CoreError::new(
            CoreErrorCode::Validation,
            "server references an unknown group or tag",
            false,
        )
    } else {
        repository_error("write server catalog", error)
    }
}

fn map_server_tag_link_error(error: sqlx::Error) -> CoreError {
    if is_unique_violation(&error) {
        CoreError::new(
            CoreErrorCode::Validation,
            "server tag references must not contain duplicates",
            false,
        )
    } else if is_foreign_key_violation(&error) {
        CoreError::new(
            CoreErrorCode::Validation,
            "server references an unknown group or tag",
            false,
        )
    } else {
        repository_error("write server tag link", error)
    }
}

fn map_tag_write_error(error: sqlx::Error) -> CoreError {
    if is_unique_violation(&error) {
        CoreError::new(
            CoreErrorCode::Conflict,
            "a server tag with the same name already exists",
            false,
        )
    } else {
        repository_error("write server tag", error)
    }
}

fn map_secret_metadata_delete_error(error: sqlx::Error) -> CoreError {
    if is_foreign_key_violation(&error) {
        CoreError::new(
            CoreErrorCode::Internal,
            "persisted credential metadata is still referenced by another server",
            false,
        )
    } else {
        repository_error("delete server credential metadata", error)
    }
}

fn credential_metadata_invariant() -> CoreError {
    CoreError::new(
        CoreErrorCode::Internal,
        "persisted server credential metadata has inconsistent ownership or references",
        false,
    )
}

fn is_unique_violation(error: &sqlx::Error) -> bool {
    error
        .as_database_error()
        .is_some_and(|database_error| database_error.is_unique_violation())
}

fn is_foreign_key_violation(error: &sqlx::Error) -> bool {
    error
        .as_database_error()
        .is_some_and(|database_error| database_error.is_foreign_key_violation())
}

fn repository_error(context: &str, error: impl std::fmt::Display) -> CoreError {
    CoreError::new(
        CoreErrorCode::Internal,
        format!("failed to {context}: {error}"),
        false,
    )
}
