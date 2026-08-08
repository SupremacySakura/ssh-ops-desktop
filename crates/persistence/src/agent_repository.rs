use std::str::FromStr;

use opspilot_domain::{AgentRunStatus, CoreError, CoreErrorCode, Id};
use serde::{Deserialize, Serialize};

use crate::Database;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentThreadSummary {
    pub id: Id,
    pub title: String,
    pub context_summary: String,
    pub summary_version: u64,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRunSummary {
    pub id: Id,
    pub thread_id: Id,
    pub server_id: Id,
    pub model_profile_id: Option<Id>,
    pub status: AgentRunStatus,
    pub sequence: u64,
    pub input_summary: String,
    pub output_summary: Option<String>,
    pub updated_at: String,
}

#[derive(Clone, Debug)]
pub struct AgentRepository {
    database: Database,
}

impl AgentRepository {
    pub fn new(database: Database) -> Self {
        Self { database }
    }

    pub async fn create_thread(&self, title: &str) -> Result<AgentThreadSummary, CoreError> {
        let title = bounded(title, "Agent thread title", 256)?;
        let id = Id::new();
        sqlx::query(
            "INSERT INTO agent_threads (id, title, created_at, updated_at)
             VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        )
        .bind(id.to_string())
        .bind(title)
        .execute(self.database.pool())
        .await
        .map_err(|error| persistence_error("create Agent thread", error))?;
        self.get_thread(id).await
    }

    pub async fn list_threads(&self) -> Result<Vec<AgentThreadSummary>, CoreError> {
        let rows = sqlx::query_as::<_, ThreadRow>(
            "SELECT id, title, context_summary, summary_version, updated_at
             FROM agent_threads ORDER BY updated_at DESC, id",
        )
        .fetch_all(self.database.pool())
        .await
        .map_err(|error| persistence_error("list Agent threads", error))?;
        rows.into_iter().map(ThreadRow::into_summary).collect()
    }

    pub async fn create_run(
        &self,
        thread_id: Id,
        server_id: Id,
        model_profile_id: Option<Id>,
        input_summary: &str,
    ) -> Result<AgentRunSummary, CoreError> {
        let input_summary = bounded(input_summary, "Agent input summary", 4096)?;
        let id = Id::new();
        sqlx::query(
            "INSERT INTO agent_runs (
                id, thread_id, server_id, model_profile_id, status, sequence,
                input_summary, created_at, updated_at
             ) VALUES (?, ?, ?, ?, 'planning', 1, ?,
                       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        )
        .bind(id.to_string())
        .bind(thread_id.to_string())
        .bind(server_id.to_string())
        .bind(model_profile_id.map(|id| id.to_string()))
        .bind(input_summary)
        .execute(self.database.pool())
        .await
        .map_err(|error| persistence_error("create Agent run", error))?;
        sqlx::query(
            "INSERT INTO agent_run_events (run_id, sequence, status, summary, created_at)
             VALUES (?, 1, 'planning', 'run created', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        )
        .bind(id.to_string())
        .execute(self.database.pool())
        .await
        .map_err(|error| persistence_error("append Agent run event", error))?;
        self.get_run(id).await
    }

    pub async fn transition(
        &self,
        run_id: Id,
        status: AgentRunStatus,
        summary: &str,
        output_summary: Option<&str>,
    ) -> Result<AgentRunSummary, CoreError> {
        let summary = bounded(summary, "Agent event summary", 4096)?;
        let output_summary = output_summary
            .map(|value| bounded(value, "Agent output summary", 8192))
            .transpose()?;
        let mut transaction = self
            .database
            .pool()
            .begin()
            .await
            .map_err(|error| persistence_error("begin Agent run transition", error))?;
        let sequence: i64 = sqlx::query_scalar("SELECT sequence FROM agent_runs WHERE id = ?")
            .bind(run_id.to_string())
            .fetch_optional(&mut *transaction)
            .await
            .map_err(|error| persistence_error("read Agent run sequence", error))?
            .ok_or_else(|| {
                CoreError::new(CoreErrorCode::NotFound, "Agent run was not found", false)
            })?;
        let next = sequence
            .checked_add(1)
            .ok_or_else(|| invariant("Agent run sequence overflow"))?;
        let persisted = status_string(status);
        sqlx::query(
            "UPDATE agent_runs SET status = ?, sequence = ?, output_summary = COALESCE(?, output_summary),
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND sequence = ?",
        ).bind(persisted).bind(next).bind(output_summary).bind(run_id.to_string()).bind(sequence)
        .execute(&mut *transaction).await
        .map_err(|error| persistence_error("update Agent run", error))?;
        sqlx::query(
            "INSERT INTO agent_run_events (run_id, sequence, status, summary, created_at)
             VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        )
        .bind(run_id.to_string())
        .bind(next)
        .bind(persisted)
        .bind(summary)
        .execute(&mut *transaction)
        .await
        .map_err(|error| persistence_error("append Agent run event", error))?;
        transaction
            .commit()
            .await
            .map_err(|error| persistence_error("commit Agent run transition", error))?;
        self.get_run(run_id).await
    }

    pub async fn recover_incomplete(&self) -> Result<u64, CoreError> {
        let ids: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM agent_runs WHERE status IN (
                'planning', 'awaiting_tool', 'executing', 'summarizing'
             ) ORDER BY id",
        )
        .fetch_all(self.database.pool())
        .await
        .map_err(|error| persistence_error("find incomplete Agent runs", error))?;
        for id in &ids {
            self.transition(
                parse_id(id)?,
                AgentRunStatus::RecoveryRequired,
                "process restarted; write operations were not replayed",
                None,
            )
            .await?;
        }
        Ok(ids.len() as u64)
    }

    pub async fn get_run(&self, id: Id) -> Result<AgentRunSummary, CoreError> {
        let row = sqlx::query_as::<_, RunRow>(
            "SELECT id, thread_id, server_id, model_profile_id, status, sequence,
                    input_summary, output_summary, updated_at FROM agent_runs WHERE id = ?",
        )
        .bind(id.to_string())
        .fetch_optional(self.database.pool())
        .await
        .map_err(|error| persistence_error("get Agent run", error))?
        .ok_or_else(|| CoreError::new(CoreErrorCode::NotFound, "Agent run was not found", false))?;
        row.into_summary()
    }

    async fn get_thread(&self, id: Id) -> Result<AgentThreadSummary, CoreError> {
        sqlx::query_as::<_, ThreadRow>(
            "SELECT id, title, context_summary, summary_version, updated_at
             FROM agent_threads WHERE id = ?",
        )
        .bind(id.to_string())
        .fetch_one(self.database.pool())
        .await
        .map_err(|error| persistence_error("get Agent thread", error))?
        .into_summary()
    }
}

#[derive(sqlx::FromRow)]
struct ThreadRow {
    id: String,
    title: String,
    context_summary: String,
    summary_version: i64,
    updated_at: String,
}
impl ThreadRow {
    fn into_summary(self) -> Result<AgentThreadSummary, CoreError> {
        Ok(AgentThreadSummary {
            id: parse_id(&self.id)?,
            title: self.title,
            context_summary: self.context_summary,
            summary_version: u64::try_from(self.summary_version)
                .map_err(|_| invariant("Agent summary version is invalid"))?,
            updated_at: self.updated_at,
        })
    }
}

#[derive(sqlx::FromRow)]
struct RunRow {
    id: String,
    thread_id: String,
    server_id: String,
    model_profile_id: Option<String>,
    status: String,
    sequence: i64,
    input_summary: String,
    output_summary: Option<String>,
    updated_at: String,
}
impl RunRow {
    fn into_summary(self) -> Result<AgentRunSummary, CoreError> {
        Ok(AgentRunSummary {
            id: parse_id(&self.id)?,
            thread_id: parse_id(&self.thread_id)?,
            server_id: parse_id(&self.server_id)?,
            model_profile_id: self.model_profile_id.map(|id| parse_id(&id)).transpose()?,
            status: parse_status(&self.status)?,
            sequence: u64::try_from(self.sequence)
                .map_err(|_| invariant("Agent sequence is invalid"))?,
            input_summary: self.input_summary,
            output_summary: self.output_summary,
            updated_at: self.updated_at,
        })
    }
}

fn status_string(status: AgentRunStatus) -> &'static str {
    match status {
        AgentRunStatus::Planning => "planning",
        AgentRunStatus::AwaitingTool => "awaiting_tool",
        AgentRunStatus::AwaitingApproval => "awaiting_approval",
        AgentRunStatus::Executing => "executing",
        AgentRunStatus::Summarizing => "summarizing",
        AgentRunStatus::Succeeded => "succeeded",
        AgentRunStatus::Failed => "failed",
        AgentRunStatus::Cancelled => "cancelled",
        AgentRunStatus::RecoveryRequired => "recovery_required",
    }
}
fn parse_status(value: &str) -> Result<AgentRunStatus, CoreError> {
    match value {
        "planning" => Ok(AgentRunStatus::Planning),
        "awaiting_tool" => Ok(AgentRunStatus::AwaitingTool),
        "awaiting_approval" => Ok(AgentRunStatus::AwaitingApproval),
        "executing" => Ok(AgentRunStatus::Executing),
        "summarizing" => Ok(AgentRunStatus::Summarizing),
        "succeeded" => Ok(AgentRunStatus::Succeeded),
        "failed" => Ok(AgentRunStatus::Failed),
        "cancelled" => Ok(AgentRunStatus::Cancelled),
        "recovery_required" => Ok(AgentRunStatus::RecoveryRequired),
        _ => Err(invariant("Agent status is invalid")),
    }
}
fn bounded(value: &str, field: &str, max: usize) -> Result<String, CoreError> {
    let value = value.trim();
    if value.is_empty() || value.len() > max || value.chars().any(char::is_control) {
        Err(CoreError::new(
            CoreErrorCode::Validation,
            format!("{field} is invalid"),
            false,
        ))
    } else {
        Ok(value.to_owned())
    }
}
fn parse_id(value: &str) -> Result<Id, CoreError> {
    Id::from_str(value).map_err(|_| invariant("Agent identifier is invalid"))
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
