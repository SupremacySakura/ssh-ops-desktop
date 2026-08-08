use std::str::FromStr;

use opspilot_domain::{CoreError, CoreErrorCode, Id, TaskStatus};
use serde::{Deserialize, Serialize};

use crate::Database;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskEvent {
    pub task_id: Id,
    pub sequence: u64,
    pub status: TaskStatus,
    pub progress: u8,
    pub current_step: Option<String>,
    pub error_code: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskEventPage {
    pub events: Vec<TaskEvent>,
    pub has_more: bool,
    pub oldest_available_sequence: Option<u64>,
}

#[derive(Clone, Debug)]
pub struct TaskRepository {
    database: Database,
}

impl TaskRepository {
    pub fn new(database: Database) -> Self {
        Self { database }
    }

    pub async fn transition(
        &self,
        task_id: Id,
        status: TaskStatus,
        progress: u8,
        current_step: Option<&str>,
        error_code: Option<&str>,
    ) -> Result<TaskEvent, CoreError> {
        if progress > 100 {
            return Err(validation("task progress must be between 0 and 100"));
        }
        for value in [current_step, error_code].into_iter().flatten() {
            if value.trim().is_empty() || value.chars().any(char::is_control) {
                return Err(validation("task event text is invalid"));
            }
        }
        let mut transaction = self
            .database
            .pool()
            .begin()
            .await
            .map_err(|error| persistence_error("begin task transition", error))?;
        let sequence: i64 = sqlx::query_scalar("SELECT sequence FROM tasks WHERE id = ?")
            .bind(task_id.to_string())
            .fetch_optional(&mut *transaction)
            .await
            .map_err(|error| persistence_error("read task sequence", error))?
            .ok_or_else(|| CoreError::new(CoreErrorCode::NotFound, "task was not found", false))?;
        let next = sequence
            .checked_add(1)
            .ok_or_else(|| invariant("task sequence overflow"))?;
        let status_value = status_string(status);
        let updated = sqlx::query(
            "UPDATE tasks SET status = ?, sequence = ?, progress = ?, current_step = ?,
                    error_code = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ? AND sequence = ?",
        )
        .bind(status_value)
        .bind(next)
        .bind(i64::from(progress))
        .bind(current_step)
        .bind(error_code)
        .bind(task_id.to_string())
        .bind(sequence)
        .execute(&mut *transaction)
        .await
        .map_err(|error| persistence_error("update task state", error))?;
        if updated.rows_affected() != 1 {
            return Err(CoreError::new(
                CoreErrorCode::Conflict,
                "task state changed concurrently",
                true,
            ));
        }
        sqlx::query(
            "INSERT INTO task_events (
                task_id, sequence, status, progress, current_step, error_code, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        )
        .bind(task_id.to_string())
        .bind(next)
        .bind(status_value)
        .bind(i64::from(progress))
        .bind(current_step)
        .bind(error_code)
        .execute(&mut *transaction)
        .await
        .map_err(|error| persistence_error("append task event", error))?;
        transaction
            .commit()
            .await
            .map_err(|error| persistence_error("commit task transition", error))?;
        self.event(task_id, next as u64).await
    }

    pub async fn events_since(
        &self,
        task_id: Id,
        after_sequence: u64,
        limit: u32,
    ) -> Result<TaskEventPage, CoreError> {
        let limit = limit.clamp(1, 1000);
        let rows = sqlx::query_as::<_, TaskEventRow>(
            "SELECT task_id, sequence, status, progress, current_step, error_code, created_at
             FROM task_events WHERE task_id = ? AND sequence > ?
             ORDER BY sequence LIMIT ?",
        )
        .bind(task_id.to_string())
        .bind(i64::try_from(after_sequence).unwrap_or(i64::MAX))
        .bind(i64::from(limit) + 1)
        .fetch_all(self.database.pool())
        .await
        .map_err(|error| persistence_error("read task events", error))?;
        let has_more = rows.len() > limit as usize;
        let events = rows
            .into_iter()
            .take(limit as usize)
            .map(TaskEventRow::into_event)
            .collect::<Result<Vec<_>, _>>()?;
        let oldest: Option<i64> =
            sqlx::query_scalar("SELECT MIN(sequence) FROM task_events WHERE task_id = ?")
                .bind(task_id.to_string())
                .fetch_one(self.database.pool())
                .await
                .map_err(|error| persistence_error("read oldest task event", error))?;
        Ok(TaskEventPage {
            events,
            has_more,
            oldest_available_sequence: oldest.and_then(|value| u64::try_from(value).ok()),
        })
    }

    pub async fn list_latest(&self, limit: u32) -> Result<Vec<TaskEvent>, CoreError> {
        let rows = sqlx::query_as::<_, TaskEventRow>(
            "SELECT task_events.task_id, task_events.sequence, task_events.status,
                    task_events.progress, task_events.current_step, task_events.error_code,
                    task_events.created_at
             FROM task_events
             JOIN tasks ON tasks.id = task_events.task_id AND tasks.sequence = task_events.sequence
             ORDER BY task_events.created_at DESC, task_events.task_id
             LIMIT ?",
        )
        .bind(i64::from(limit.clamp(1, 1000)))
        .fetch_all(self.database.pool())
        .await
        .map_err(|error| persistence_error("list latest tasks", error))?;
        rows.into_iter().map(TaskEventRow::into_event).collect()
    }

    pub async fn recover_interrupted(&self) -> Result<u64, CoreError> {
        let ids: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM tasks WHERE status IN ('running', 'rolling_back') ORDER BY id",
        )
        .fetch_all(self.database.pool())
        .await
        .map_err(|error| persistence_error("find interrupted tasks", error))?;
        for id in &ids {
            self.transition(
                parse_id(id)?,
                TaskStatus::Interrupted,
                0,
                None,
                Some("PROCESS_RESTARTED"),
            )
            .await?;
        }
        Ok(ids.len() as u64)
    }

    pub async fn get_status(&self, task_id: Id) -> Result<TaskStatus, CoreError> {
        let status: String = sqlx::query_scalar("SELECT status FROM tasks WHERE id = ?")
            .bind(task_id.to_string())
            .fetch_optional(self.database.pool())
            .await
            .map_err(|error| persistence_error("read task status", error))?
            .ok_or_else(|| CoreError::new(CoreErrorCode::NotFound, "task was not found", false))?;
        parse_status(&status)
    }

    async fn event(&self, task_id: Id, sequence: u64) -> Result<TaskEvent, CoreError> {
        let row = sqlx::query_as::<_, TaskEventRow>(
            "SELECT task_id, sequence, status, progress, current_step, error_code, created_at
             FROM task_events WHERE task_id = ? AND sequence = ?",
        )
        .bind(task_id.to_string())
        .bind(i64::try_from(sequence).unwrap_or(i64::MAX))
        .fetch_one(self.database.pool())
        .await
        .map_err(|error| persistence_error("read task event", error))?;
        row.into_event()
    }
}

#[derive(sqlx::FromRow)]
struct TaskEventRow {
    task_id: String,
    sequence: i64,
    status: String,
    progress: i64,
    current_step: Option<String>,
    error_code: Option<String>,
    created_at: String,
}

impl TaskEventRow {
    fn into_event(self) -> Result<TaskEvent, CoreError> {
        Ok(TaskEvent {
            task_id: parse_id(&self.task_id)?,
            sequence: u64::try_from(self.sequence)
                .map_err(|_| invariant("task event sequence is invalid"))?,
            status: parse_status(&self.status)?,
            progress: u8::try_from(self.progress)
                .map_err(|_| invariant("task event progress is invalid"))?,
            current_step: self.current_step,
            error_code: self.error_code,
            created_at: self.created_at,
        })
    }
}

fn status_string(status: TaskStatus) -> &'static str {
    match status {
        TaskStatus::Pending => "pending",
        TaskStatus::Running => "running",
        TaskStatus::Succeeded => "succeeded",
        TaskStatus::Failed => "failed",
        TaskStatus::Cancelled => "cancelled",
        TaskStatus::Interrupted => "interrupted",
        TaskStatus::RollingBack => "rolling_back",
        TaskStatus::RolledBack => "rolled_back",
        TaskStatus::RollbackFailed => "rollback_failed",
    }
}

fn parse_status(value: &str) -> Result<TaskStatus, CoreError> {
    match value {
        "pending" => Ok(TaskStatus::Pending),
        "running" => Ok(TaskStatus::Running),
        "succeeded" => Ok(TaskStatus::Succeeded),
        "failed" => Ok(TaskStatus::Failed),
        "cancelled" => Ok(TaskStatus::Cancelled),
        "interrupted" => Ok(TaskStatus::Interrupted),
        "rolling_back" => Ok(TaskStatus::RollingBack),
        "rolled_back" => Ok(TaskStatus::RolledBack),
        "rollback_failed" => Ok(TaskStatus::RollbackFailed),
        _ => Err(invariant("persisted task status is invalid")),
    }
}

fn parse_id(value: &str) -> Result<Id, CoreError> {
    Id::from_str(value).map_err(|_| invariant("persisted task identifier is invalid"))
}

fn validation(message: &str) -> CoreError {
    CoreError::new(CoreErrorCode::Validation, message, false)
}
fn invariant(message: &str) -> CoreError {
    CoreError::new(CoreErrorCode::Internal, message, false)
}
fn persistence_error(context: &str, error: impl std::fmt::Display) -> CoreError {
    CoreError::new(
        CoreErrorCode::Internal,
        format!("failed to {context}: {error}"),
        false,
    )
}
