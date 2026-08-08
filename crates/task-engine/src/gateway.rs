use std::{collections::HashMap, sync::Arc};

use async_trait::async_trait;
use chrono::{Duration, SecondsFormat, Utc};
use opspilot_audit::{AuditEvent, AuditWriter, Redactor};
use opspilot_domain::{
    CoreError, CoreErrorCode, Id, RiskDecision, RiskLevel, TaskStatus, ToolCall,
};
use opspilot_persistence::{Database, TaskRepository};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OperationActor {
    Manual {
        manual_run_id: Id,
        window_id: String,
    },
    Agent {
        agent_run_id: Id,
    },
}

impl OperationActor {
    fn run_id(&self) -> Id {
        match self {
            Self::Manual { manual_run_id, .. } => *manual_run_id,
            Self::Agent { agent_run_id } => *agent_run_id,
        }
    }

    fn persisted(&self) -> (&'static str, String) {
        match self {
            Self::Manual {
                manual_run_id,
                window_id,
            } => ("manual", format!("{manual_run_id}:{window_id}")),
            Self::Agent { agent_run_id } => ("agent", agent_run_id.to_string()),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovalProof {
    pub approval_id: Id,
    pub tool_call_id: Id,
    pub args_digest: String,
    pub confirmed_resource: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum PrepareResult {
    ReadCompleted {
        tool_call_id: Id,
        result: ToolResult,
    },
    AwaitingApproval(PreparedOperation),
    Blocked {
        tool_call_id: Id,
        risk: RiskDecision,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedOperation {
    pub approval_id: Id,
    pub tool_call_id: Id,
    pub run_id: Id,
    pub server_id: Id,
    pub tool_name: String,
    pub args_digest: String,
    pub risk: RiskDecision,
    pub target_label: String,
    pub confirmation_target: Option<String>,
    pub impact_summary: String,
    pub expires_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRef {
    pub task_id: Id,
    pub tool_call_id: Id,
    pub args_digest: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", content = "status", rename_all = "snake_case")]
pub enum OperationState {
    ReadCompleted,
    AwaitingApproval,
    Task(TaskStatus),
    Blocked,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(transparent)]
pub struct ToolResult {
    value: Value,
}

impl ToolResult {
    pub fn new(value: Value) -> Self {
        Self { value }
    }

    pub fn value(&self) -> &Value {
        &self.value
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ToolEffect {
    Read,
    Write {
        minimum_risk: RiskLevel,
        snapshot_required: bool,
        confirmation_arg: Option<String>,
    },
    Blocked,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolDefinition {
    name: String,
    schema_version: u8,
    effect: ToolEffect,
}

impl ToolDefinition {
    pub fn new(name: &str, schema_version: u8, effect: ToolEffect) -> Result<Self, CoreError> {
        if name.is_empty()
            || name.len() > 128
            || !name.chars().all(|character| {
                character.is_ascii_lowercase()
                    || character.is_ascii_digit()
                    || matches!(character, '.' | '_' | '-')
            })
        {
            return Err(validation("tool name is invalid"));
        }
        if schema_version != 1 {
            return Err(validation("unsupported tool schema version"));
        }
        if let ToolEffect::Write {
            minimum_risk,
            snapshot_required,
            ref confirmation_arg,
        } = effect
        {
            match minimum_risk {
                RiskLevel::L1 | RiskLevel::L2
                    if !snapshot_required && confirmation_arg.is_none() => {}
                RiskLevel::L3 if snapshot_required && confirmation_arg.is_some() => {}
                _ => {
                    return Err(validation(
                        "write tool risk, snapshot, and confirmation policy is unsafe",
                    ));
                }
            }
        }
        Ok(Self {
            name: name.to_owned(),
            schema_version,
            effect,
        })
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn effect(&self) -> &ToolEffect {
        &self.effect
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct OperationPlan {
    args: Value,
    impact_summary: String,
    target_label: Option<String>,
}

impl OperationPlan {
    pub fn new(args: Value, impact_summary: impl Into<String>) -> Self {
        Self {
            args,
            impact_summary: impact_summary.into(),
            target_label: None,
        }
    }

    pub fn with_target_label(mut self, target_label: impl Into<String>) -> Self {
        self.target_label = Some(target_label.into());
        self
    }
}

#[derive(Clone, Debug)]
pub enum ToolAction {
    Read(ToolResult),
    Write(OperationPlan),
}

#[derive(Clone, Debug)]
pub struct ApprovedOperation {
    tool_call_id: Id,
    run_id: Id,
    server_id: Id,
    args_digest: String,
    args: Value,
}

impl ApprovedOperation {
    pub fn tool_call_id(&self) -> Id {
        self.tool_call_id
    }

    pub fn run_id(&self) -> Id {
        self.run_id
    }

    pub fn server_id(&self) -> Id {
        self.server_id
    }

    pub fn args_digest(&self) -> &str {
        &self.args_digest
    }

    pub fn args(&self) -> &Value {
        &self.args
    }
}

#[async_trait]
pub trait ToolExecutor: Send + Sync {
    fn definition(&self) -> ToolDefinition;
    async fn prepare(&self, call: &ToolCall) -> Result<ToolAction, CoreError>;
    async fn execute(&self, operation: ApprovedOperation) -> Result<ToolResult, CoreError>;
}

#[derive(Clone, Default)]
pub struct ToolCatalog {
    executors: HashMap<String, Arc<dyn ToolExecutor>>,
}

impl ToolCatalog {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register<E>(mut self, executor: E) -> Result<Self, CoreError>
    where
        E: ToolExecutor + 'static,
    {
        let definition = executor.definition();
        if self
            .executors
            .insert(definition.name.clone(), Arc::new(executor))
            .is_some()
        {
            return Err(CoreError::new(
                CoreErrorCode::Conflict,
                "tool name is already registered",
                false,
            ));
        }
        Ok(self)
    }

    fn get(&self, name: &str) -> Result<Arc<dyn ToolExecutor>, CoreError> {
        self.executors
            .get(name)
            .cloned()
            .ok_or_else(|| CoreError::new(CoreErrorCode::NotFound, "tool is not registered", false))
    }
}

#[async_trait]
pub trait OperationGateway: Send + Sync {
    async fn prepare(
        &self,
        call: ToolCall,
        actor: OperationActor,
    ) -> Result<PrepareResult, CoreError>;
    async fn approve_and_submit(&self, proof: ApprovalProof) -> Result<TaskRef, CoreError>;
    async fn reject(&self, approval_id: Id) -> Result<(), CoreError>;
    async fn status(&self, tool_call_id: Id) -> Result<OperationState, CoreError>;
}

#[derive(Clone)]
pub struct SqliteOperationGateway {
    database: Database,
    catalog: ToolCatalog,
    audit: AuditWriter,
}

impl SqliteOperationGateway {
    pub fn new(database: Database, catalog: ToolCatalog) -> Self {
        Self {
            audit: AuditWriter::new(database.clone(), Redactor::default()),
            database,
            catalog,
        }
    }
}

#[async_trait]
impl OperationGateway for SqliteOperationGateway {
    async fn prepare(
        &self,
        call: ToolCall,
        actor: OperationActor,
    ) -> Result<PrepareResult, CoreError> {
        if actor.run_id() != call.run_id {
            return Err(CoreError::new(
                CoreErrorCode::ToolScopeViolation,
                "operation actor does not own the tool-call run",
                false,
            ));
        }
        let executor = self.catalog.get(&call.name)?;
        let definition = executor.definition();
        if definition.schema_version != call.schema_version {
            return Err(validation(
                "tool-call schema version does not match the catalog",
            ));
        }
        let canonical_args = canonical_json(&call.args)?;
        let args_digest = sha256_hex(canonical_args.as_bytes());
        let (actor_type, actor_id) = actor.persisted();
        sqlx::query(
            "INSERT INTO tool_calls (
                id, run_id, server_id, name, schema_version, args_json, args_digest,
                actor_type, actor_id, state, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared',
                       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        )
        .bind(call.tool_call_id.to_string())
        .bind(call.run_id.to_string())
        .bind(call.server_id.to_string())
        .bind(&call.name)
        .bind(i64::from(call.schema_version))
        .bind(&canonical_args)
        .bind(&args_digest)
        .bind(actor_type)
        .bind(actor_id)
        .execute(self.database.pool())
        .await
        .map_err(|error| persistence_error("persist immutable tool call", error))?;

        let action = executor.prepare(&call).await?;
        match definition.effect {
            ToolEffect::Read => match action {
                ToolAction::Read(result) => {
                    self.set_tool_call_state(call.tool_call_id, "read_completed")
                        .await?;
                    self.audit("operation.read", &call, "success", &args_digest)
                        .await?;
                    Ok(PrepareResult::ReadCompleted {
                        tool_call_id: call.tool_call_id,
                        result,
                    })
                }
                ToolAction::Write(_) => Err(invariant("read tool produced a write plan")),
            },
            ToolEffect::Blocked => {
                let risk = blocked_risk("tool policy blocks execution");
                self.set_tool_call_state(call.tool_call_id, "blocked")
                    .await?;
                self.audit("operation.prepare", &call, "blocked", &args_digest)
                    .await?;
                Ok(PrepareResult::Blocked {
                    tool_call_id: call.tool_call_id,
                    risk,
                })
            }
            ToolEffect::Write {
                minimum_risk,
                snapshot_required,
                confirmation_arg,
            } => {
                let ToolAction::Write(plan) = action else {
                    return Err(invariant("write tool produced a read result"));
                };
                if canonical_json(&plan.args)? != canonical_args {
                    self.set_tool_call_state(call.tool_call_id, "blocked")
                        .await?;
                    self.audit("operation.prepare", &call, "blocked", &args_digest)
                        .await?;
                    return Ok(PrepareResult::Blocked {
                        tool_call_id: call.tool_call_id,
                        risk: blocked_risk(
                            "prepared arguments differ from the immutable tool call",
                        ),
                    });
                }
                let confirmation_target = match confirmation_arg {
                    Some(argument) => match plan.args.get(&argument).and_then(Value::as_str) {
                        Some(value) if !value.trim().is_empty() => Some(value.trim().to_owned()),
                        _ => {
                            let risk = blocked_risk("tool target cannot be determined safely");
                            self.set_tool_call_state(call.tool_call_id, "blocked")
                                .await?;
                            self.audit("operation.prepare", &call, "blocked", &args_digest)
                                .await?;
                            return Ok(PrepareResult::Blocked {
                                tool_call_id: call.tool_call_id,
                                risk,
                            });
                        }
                    },
                    None => None,
                };
                let risk = risk_decision(minimum_risk, snapshot_required, &confirmation_target);
                let approval_id = Id::new();
                let expires_at = (Utc::now() + Duration::minutes(10))
                    .to_rfc3339_opts(SecondsFormat::Millis, true);
                let target_label = confirmation_target
                    .clone()
                    .or(plan.target_label)
                    .filter(|target| !target.trim().is_empty() && target.len() <= 512)
                    .unwrap_or_else(|| definition.name.clone());
                sqlx::query(
                    "INSERT INTO approvals (
                        id, tool_call_id, args_digest, risk_level, snapshot_required,
                        target_label, confirmation_target, confirmation_text, policy_version,
                        expires_at, state, created_at, updated_at
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'pending',
                               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
                )
                .bind(approval_id.to_string())
                .bind(call.tool_call_id.to_string())
                .bind(&args_digest)
                .bind(risk_level_string(risk.level))
                .bind(risk.snapshot_required)
                .bind(&target_label)
                .bind(&confirmation_target)
                .bind(&risk.confirmation_text)
                .bind(&expires_at)
                .execute(self.database.pool())
                .await
                .map_err(|error| persistence_error("persist operation approval", error))?;
                self.audit(
                    "operation.prepare",
                    &call,
                    "awaiting_approval",
                    &args_digest,
                )
                .await?;
                Ok(PrepareResult::AwaitingApproval(PreparedOperation {
                    approval_id,
                    tool_call_id: call.tool_call_id,
                    run_id: call.run_id,
                    server_id: call.server_id,
                    tool_name: definition.name,
                    args_digest,
                    risk,
                    target_label,
                    confirmation_target,
                    impact_summary: plan.impact_summary,
                    expires_at,
                }))
            }
        }
    }

    async fn approve_and_submit(&self, proof: ApprovalProof) -> Result<TaskRef, CoreError> {
        let row: ApprovalRow = sqlx::query_as(
            "SELECT approvals.tool_call_id, approvals.args_digest,
                    approvals.confirmation_target, approvals.expires_at, approvals.state,
                    approvals.task_id, tool_calls.run_id, tool_calls.server_id,
                    tool_calls.name, tool_calls.args_json
             FROM approvals
             JOIN tool_calls ON tool_calls.id = approvals.tool_call_id
             WHERE approvals.id = ?",
        )
        .bind(proof.approval_id.to_string())
        .fetch_optional(self.database.pool())
        .await
        .map_err(|error| persistence_error("read operation approval", error))?
        .ok_or_else(|| CoreError::new(CoreErrorCode::NotFound, "approval was not found", false))?;
        let tool_call_id = parse_id(&row.tool_call_id)?;
        if tool_call_id != proof.tool_call_id || row.args_digest != proof.args_digest {
            return Err(approval_mismatch(
                "approval does not match the immutable tool call",
            ));
        }
        let expected_confirmation = row.confirmation_target.as_deref().map(str::trim);
        let actual_confirmation = proof.confirmed_resource.as_deref().map(str::trim);
        if expected_confirmation != actual_confirmation {
            return Err(approval_mismatch(
                "confirmed resource does not match the prepared target",
            ));
        }
        if row.state == "rejected" {
            return Err(CoreError::new(
                CoreErrorCode::Conflict,
                "approval was rejected",
                false,
            ));
        }
        if Utc::now()
            > chrono::DateTime::parse_from_rfc3339(&row.expires_at)
                .map_err(|_| invariant("persisted approval expiry is invalid"))?
                .with_timezone(&Utc)
        {
            sqlx::query(
                "UPDATE approvals SET state = 'expired',
                        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                 WHERE id = ? AND state = 'pending'",
            )
            .bind(proof.approval_id.to_string())
            .execute(self.database.pool())
            .await
            .map_err(|error| persistence_error("expire operation approval", error))?;
            return Err(CoreError::new(
                CoreErrorCode::NotFound,
                "approval expired",
                false,
            ));
        }
        if let Some(task_id) = row.task_id {
            return Ok(TaskRef {
                task_id: parse_id(&task_id)?,
                tool_call_id,
                args_digest: row.args_digest,
            });
        }

        let task_id = Id::new();
        let mut transaction = self
            .database
            .pool()
            .begin()
            .await
            .map_err(|error| persistence_error("begin operation submission", error))?;
        sqlx::query(
            "INSERT INTO tasks (
                id, tool_call_id, args_digest, status, sequence, created_at, updated_at
             ) VALUES (?, ?, ?, 'pending', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        )
        .bind(task_id.to_string())
        .bind(&row.tool_call_id)
        .bind(&row.args_digest)
        .execute(&mut *transaction)
        .await
        .map_err(|error| persistence_error("create approved task", error))?;
        sqlx::query(
            "INSERT INTO task_events (
                task_id, sequence, status, progress, created_at
             ) VALUES (?, 1, 'pending', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        )
        .bind(task_id.to_string())
        .execute(&mut *transaction)
        .await
        .map_err(|error| persistence_error("append pending task event", error))?;
        let claimed = sqlx::query(
            "UPDATE approvals SET state = 'approved', task_id = ?,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ? AND state = 'pending' AND task_id IS NULL",
        )
        .bind(task_id.to_string())
        .bind(proof.approval_id.to_string())
        .execute(&mut *transaction)
        .await
        .map_err(|error| persistence_error("claim approved operation", error))?;
        if claimed.rows_affected() != 1 {
            return Err(CoreError::new(
                CoreErrorCode::Conflict,
                "approval changed while being submitted; query operation status",
                true,
            ));
        }
        transaction
            .commit()
            .await
            .map_err(|error| persistence_error("commit operation submission", error))?;

        let tasks = TaskRepository::new(self.database.clone());
        tasks
            .transition(task_id, TaskStatus::Running, 0, Some("execute"), None)
            .await?;

        let executor = self.catalog.get(&row.name)?;
        let args: Value = serde_json::from_str(&row.args_json)
            .map_err(|_| invariant("persisted tool arguments are invalid"))?;
        let operation = ApprovedOperation {
            tool_call_id,
            run_id: parse_id(&row.run_id)?,
            server_id: parse_id(&row.server_id)?,
            args_digest: row.args_digest.clone(),
            args,
        };
        let execution = executor.execute(operation).await;
        let call = ToolCall {
            tool_call_id,
            run_id: parse_id(&row.run_id)?,
            server_id: parse_id(&row.server_id)?,
            name: row.name,
            schema_version: 1,
            args: Value::Null,
        };
        match execution {
            Ok(_) => {
                tasks
                    .transition(task_id, TaskStatus::Succeeded, 100, None, None)
                    .await?;
                self.audit("operation.execute", &call, "success", &row.args_digest)
                    .await?;
            }
            Err(error) => {
                let error_code = error.code().to_string();
                tasks
                    .transition(task_id, TaskStatus::Failed, 100, None, Some(&error_code))
                    .await?;
                self.audit("operation.execute", &call, "failed", &row.args_digest)
                    .await?;
                return Err(error);
            }
        }
        Ok(TaskRef {
            task_id,
            tool_call_id,
            args_digest: row.args_digest,
        })
    }

    async fn reject(&self, approval_id: Id) -> Result<(), CoreError> {
        let result = sqlx::query(
            "UPDATE approvals SET state = 'rejected',
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ? AND state IN ('pending', 'rejected') AND task_id IS NULL",
        )
        .bind(approval_id.to_string())
        .execute(self.database.pool())
        .await
        .map_err(|error| persistence_error("reject operation approval", error))?;
        if result.rows_affected() == 0 {
            return Err(CoreError::new(
                CoreErrorCode::Conflict,
                "approval cannot be rejected after submission",
                false,
            ));
        }
        Ok(())
    }

    async fn status(&self, tool_call_id: Id) -> Result<OperationState, CoreError> {
        let row: Option<(String, Option<String>)> = sqlx::query_as(
            "SELECT tool_calls.state, tasks.status
             FROM tool_calls
             LEFT JOIN tasks ON tasks.tool_call_id = tool_calls.id
             WHERE tool_calls.id = ?",
        )
        .bind(tool_call_id.to_string())
        .fetch_optional(self.database.pool())
        .await
        .map_err(|error| persistence_error("read operation status", error))?;
        let Some((state, task_status)) = row else {
            return Err(CoreError::new(
                CoreErrorCode::NotFound,
                "tool call was not found",
                false,
            ));
        };
        if let Some(status) = task_status {
            return Ok(OperationState::Task(parse_task_status(&status)?));
        }
        Ok(match state.as_str() {
            "read_completed" => OperationState::ReadCompleted,
            "blocked" => OperationState::Blocked,
            _ => OperationState::AwaitingApproval,
        })
    }
}

impl SqliteOperationGateway {
    async fn set_tool_call_state(&self, tool_call_id: Id, state: &str) -> Result<(), CoreError> {
        sqlx::query("UPDATE tool_calls SET state = ? WHERE id = ?")
            .bind(state)
            .bind(tool_call_id.to_string())
            .execute(self.database.pool())
            .await
            .map_err(|error| persistence_error("update operation state", error))?;
        Ok(())
    }

    async fn audit(
        &self,
        action: &str,
        call: &ToolCall,
        result: &str,
        args_digest: &str,
    ) -> Result<(), CoreError> {
        self.audit
            .append(
                AuditEvent::new(
                    action,
                    "tool_call",
                    result,
                    serde_json::json!({
                        "tool": call.name,
                        "argsDigest": args_digest,
                        "runId": call.run_id,
                    }),
                )
                .with_resource_id(call.tool_call_id.to_string())
                .with_server_id(call.server_id.to_string()),
            )
            .await
    }
}

#[derive(sqlx::FromRow)]
struct ApprovalRow {
    tool_call_id: String,
    args_digest: String,
    confirmation_target: Option<String>,
    expires_at: String,
    state: String,
    task_id: Option<String>,
    run_id: String,
    server_id: String,
    name: String,
    args_json: String,
}

fn canonical_json(value: &Value) -> Result<String, CoreError> {
    fn sorted(value: &Value) -> Value {
        match value {
            Value::Object(fields) => {
                let mut keys = fields.keys().collect::<Vec<_>>();
                keys.sort_unstable();
                let mut result = serde_json::Map::new();
                for key in keys {
                    result.insert(key.clone(), sorted(&fields[key]));
                }
                Value::Object(result)
            }
            Value::Array(values) => Value::Array(values.iter().map(sorted).collect()),
            other => other.clone(),
        }
    }
    serde_json::to_string(&sorted(value)).map_err(|error| {
        CoreError::new(
            CoreErrorCode::Validation,
            format!("tool arguments cannot be canonicalized: {error}"),
            false,
        )
    })
}

fn sha256_hex(value: &[u8]) -> String {
    Sha256::digest(value)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn risk_decision(
    level: RiskLevel,
    snapshot_required: bool,
    confirmation_target: &Option<String>,
) -> RiskDecision {
    RiskDecision {
        level,
        approval_required: level != RiskLevel::L0,
        snapshot_required,
        confirmation_text: confirmation_target
            .as_ref()
            .map(|target| format!("Confirm operation for {target}")),
        reason: "deterministic tool policy".to_owned(),
    }
}

fn blocked_risk(reason: &str) -> RiskDecision {
    RiskDecision {
        level: RiskLevel::L4,
        approval_required: false,
        snapshot_required: false,
        confirmation_text: None,
        reason: reason.to_owned(),
    }
}

fn risk_level_string(level: RiskLevel) -> &'static str {
    match level {
        RiskLevel::L0 => "L0",
        RiskLevel::L1 => "L1",
        RiskLevel::L2 => "L2",
        RiskLevel::L3 => "L3",
        RiskLevel::L4 => "L4",
    }
}

fn parse_task_status(value: &str) -> Result<TaskStatus, CoreError> {
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
    value
        .parse()
        .map_err(|_| invariant("persisted identifier is invalid"))
}

fn validation(message: &str) -> CoreError {
    CoreError::new(CoreErrorCode::Validation, message, false)
}

fn approval_mismatch(message: &str) -> CoreError {
    CoreError::new(CoreErrorCode::ApprovalMismatch, message, false)
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
