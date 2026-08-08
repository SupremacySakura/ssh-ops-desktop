#![forbid(unsafe_code)]

//! Redacted, append-only audit primitives for OpsPilot.

use opspilot_domain::{CoreError, CoreErrorCode};
use opspilot_persistence::Database;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

mod redactor;

pub use redactor::Redactor;

#[derive(Clone, Debug)]
pub struct AuditEvent {
    action: String,
    resource_type: String,
    resource_id: Option<String>,
    server_id: Option<String>,
    result: String,
    payload: Value,
}

impl AuditEvent {
    pub fn new(
        action: impl Into<String>,
        resource_type: impl Into<String>,
        result: impl Into<String>,
        payload: Value,
    ) -> Self {
        Self {
            action: action.into(),
            resource_type: resource_type.into(),
            resource_id: None,
            server_id: None,
            result: result.into(),
            payload,
        }
    }

    pub fn with_resource_id(mut self, resource_id: impl Into<String>) -> Self {
        self.resource_id = Some(resource_id.into());
        self
    }

    pub fn with_server_id(mut self, server_id: impl Into<String>) -> Self {
        self.server_id = Some(server_id.into());
        self
    }
}

#[derive(Clone, Debug)]
pub struct AuditWriter {
    database: Database,
    redactor: Redactor,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuditRecord {
    pub id: String,
    pub action: String,
    pub resource_type: String,
    pub resource_id: Option<String>,
    pub server_id: Option<String>,
    pub result: String,
    pub redacted_payload: Value,
    pub created_at: String,
}

#[derive(Clone, Debug)]
pub struct AuditReader {
    database: Database,
}

impl AuditReader {
    pub fn new(database: Database) -> Self {
        Self { database }
    }

    pub async fn list(&self, limit: u32) -> Result<Vec<AuditRecord>, CoreError> {
        let rows = sqlx::query_as::<_, AuditRow>(
            "SELECT id, action, resource_type, resource_id, server_id, result,
                    redacted_payload, created_at
             FROM audit_logs ORDER BY created_at DESC, id LIMIT ?",
        )
        .bind(i64::from(limit.clamp(1, 1000)))
        .fetch_all(self.database.pool())
        .await
        .map_err(audit_error)?;
        rows.into_iter()
            .map(|row| {
                Ok(AuditRecord {
                    id: row.id,
                    action: row.action,
                    resource_type: row.resource_type,
                    resource_id: row.resource_id,
                    server_id: row.server_id,
                    result: row.result,
                    redacted_payload: serde_json::from_str(&row.redacted_payload)
                        .map_err(audit_error)?,
                    created_at: row.created_at,
                })
            })
            .collect()
    }
}

#[derive(sqlx::FromRow)]
struct AuditRow {
    id: String,
    action: String,
    resource_type: String,
    resource_id: Option<String>,
    server_id: Option<String>,
    result: String,
    redacted_payload: String,
    created_at: String,
}

impl AuditWriter {
    pub fn new(database: Database, redactor: Redactor) -> Self {
        Self { database, redactor }
    }

    pub async fn append(&self, event: AuditEvent) -> Result<(), CoreError> {
        let action = self.redactor.text(&event.action);
        let resource_type = self.redactor.text(&event.resource_type);
        let resource_id = event
            .resource_id
            .as_deref()
            .map(|value| self.redactor.text(value));
        let server_id = event
            .server_id
            .as_deref()
            .map(|value| self.redactor.text(value));
        let result = self.redactor.text(&event.result);
        let redacted_payload = self.redactor.json(event.payload);
        let redacted_payload = serde_json::to_string(&redacted_payload).map_err(audit_error)?;

        sqlx::query(
            "INSERT INTO audit_logs (
                id, action, resource_type, resource_id, server_id, result,
                redacted_payload, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(action)
        .bind(resource_type)
        .bind(resource_id)
        .bind(server_id)
        .bind(result)
        .bind(redacted_payload)
        .execute(self.database.pool())
        .await
        .map_err(audit_error)?;

        Ok(())
    }
}

fn audit_error(error: impl std::fmt::Display) -> CoreError {
    CoreError::new(
        CoreErrorCode::Internal,
        format!("failed to append audit event: {error}"),
        false,
    )
}
