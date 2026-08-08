use std::sync::Arc;

use async_trait::async_trait;
use opspilot_domain::{CoreError, CoreErrorCode, Id, RiskLevel, ToolCall};
use opspilot_persistence::Database;
use opspilot_persistence::TaskRepository;
use opspilot_task_engine::{
    ApprovalProof, ApprovedOperation, OperationActor, OperationGateway, OperationPlan,
    OperationState, PrepareResult, PreparedOperation, SqliteOperationGateway, ToolAction,
    ToolCatalog, ToolDefinition, ToolEffect, ToolExecutor, ToolResult,
};
use tokio::sync::Mutex;

#[tokio::test]
async fn write_requires_digest_bound_approval_and_executes_exactly_once() {
    let database = Database::open(":memory:").await.unwrap();
    let effects = Arc::new(Mutex::new(Vec::new()));
    let catalog = ToolCatalog::new()
        .register(RecordingExecutor::write("file.delete", effects.clone()))
        .unwrap();
    let gateway = SqliteOperationGateway::new(database.clone(), catalog);
    let call = tool_call("file.delete", serde_json::json!({ "path": "/srv/app.env" }));

    let prepared = gateway
        .prepare(
            call.clone(),
            OperationActor::Manual {
                manual_run_id: call.run_id,
                window_id: "main".to_owned(),
            },
        )
        .await
        .unwrap();
    let PreparedOperation {
        approval_id,
        args_digest,
        confirmation_target,
        ..
    } = match prepared {
        PrepareResult::AwaitingApproval(prepared) => prepared,
        other => panic!("write must await approval, got {other:?}"),
    };
    assert!(effects.lock().await.is_empty());
    assert_eq!(confirmation_target.as_deref(), Some("/srv/app.env"));

    let mismatch = gateway
        .approve_and_submit(ApprovalProof {
            approval_id,
            tool_call_id: call.tool_call_id,
            args_digest: "0".repeat(64),
            confirmed_resource: Some("/srv/app.env".to_owned()),
        })
        .await
        .expect_err("changed digest must reject approval");
    assert_eq!(mismatch.code(), CoreErrorCode::ApprovalMismatch);
    assert!(effects.lock().await.is_empty());

    let proof = ApprovalProof {
        approval_id,
        tool_call_id: call.tool_call_id,
        args_digest,
        confirmed_resource: Some("/srv/app.env".to_owned()),
    };
    let task = gateway.approve_and_submit(proof.clone()).await.unwrap();
    let duplicate = gateway.approve_and_submit(proof).await.unwrap();
    assert_eq!(duplicate, task);
    assert_eq!(
        effects.lock().await.as_slice(),
        &[serde_json::json!({ "path": "/srv/app.env" })]
    );

    let persisted: (String, String, String) =
        sqlx::query_as("SELECT tool_call_id, args_digest, status FROM tasks WHERE id = ?")
            .bind(task.task_id.to_string())
            .fetch_one(database.pool())
            .await
            .unwrap();
    assert_eq!(persisted.0, call.tool_call_id.to_string());
    assert_eq!(persisted.1, task.args_digest);
    assert_eq!(persisted.2, "succeeded");
    let events = TaskRepository::new(database)
        .events_since(task.task_id, 0, 100)
        .await
        .unwrap();
    assert_eq!(
        events
            .events
            .iter()
            .map(|event| event.status)
            .collect::<Vec<_>>(),
        [
            opspilot_domain::TaskStatus::Pending,
            opspilot_domain::TaskStatus::Running,
            opspilot_domain::TaskStatus::Succeeded,
        ]
    );
}

#[tokio::test]
async fn read_is_persisted_audited_and_reported_as_completed_without_approval() {
    let database = Database::open(":memory:").await.unwrap();
    let effects = Arc::new(Mutex::new(Vec::new()));
    let catalog = ToolCatalog::new()
        .register(RecordingExecutor::read("server.overview", effects.clone()))
        .unwrap();
    let gateway = SqliteOperationGateway::new(database.clone(), catalog);
    let call = tool_call(
        "server.overview",
        serde_json::json!({ "detail": "summary" }),
    );

    let result = gateway
        .prepare(
            call.clone(),
            OperationActor::Manual {
                manual_run_id: call.run_id,
                window_id: "main".to_owned(),
            },
        )
        .await
        .unwrap();

    assert!(matches!(result, PrepareResult::ReadCompleted { .. }));
    assert_eq!(
        gateway.status(call.tool_call_id).await.unwrap(),
        OperationState::ReadCompleted
    );
    let counts: (i64, i64) = (
        sqlx::query_scalar("SELECT COUNT(*) FROM approvals")
            .fetch_one(database.pool())
            .await
            .unwrap(),
        sqlx::query_scalar("SELECT COUNT(*) FROM tasks")
            .fetch_one(database.pool())
            .await
            .unwrap(),
    );
    assert_eq!(counts, (0, 0));
}

#[test]
fn unsafe_write_definitions_fail_closed_at_registration() {
    assert!(
        ToolDefinition::new(
            "unsafe.write",
            1,
            ToolEffect::Write {
                minimum_risk: RiskLevel::L0,
                snapshot_required: false,
                confirmation_arg: None,
            },
        )
        .is_err()
    );
    assert!(
        ToolDefinition::new(
            "unsafe.l3",
            1,
            ToolEffect::Write {
                minimum_risk: RiskLevel::L3,
                snapshot_required: false,
                confirmation_arg: Some("path".to_owned()),
            },
        )
        .is_err()
    );
}

#[tokio::test]
async fn l4_is_blocked_without_approval_task_or_side_effect() {
    let database = Database::open(":memory:").await.unwrap();
    let effects = Arc::new(Mutex::new(Vec::new()));
    let catalog = ToolCatalog::new()
        .register(RecordingExecutor::blocked("system.shell", effects.clone()))
        .unwrap();
    let gateway = SqliteOperationGateway::new(database.clone(), catalog);
    let call = tool_call("system.shell", serde_json::json!({ "command": "rm -rf /" }));

    let result = gateway
        .prepare(
            call.clone(),
            OperationActor::Agent {
                agent_run_id: call.run_id,
            },
        )
        .await
        .unwrap();

    assert!(matches!(result, PrepareResult::Blocked { .. }));
    assert!(effects.lock().await.is_empty());
    let approvals: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM approvals")
        .fetch_one(database.pool())
        .await
        .unwrap();
    let tasks: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tasks")
        .fetch_one(database.pool())
        .await
        .unwrap();
    assert_eq!((approvals, tasks), (0, 0));
}

#[derive(Clone)]
struct RecordingExecutor {
    definition: ToolDefinition,
    effects: Arc<Mutex<Vec<serde_json::Value>>>,
}

impl RecordingExecutor {
    fn read(name: &str, effects: Arc<Mutex<Vec<serde_json::Value>>>) -> Self {
        Self {
            definition: ToolDefinition::new(name, 1, ToolEffect::Read).unwrap(),
            effects,
        }
    }

    fn write(name: &str, effects: Arc<Mutex<Vec<serde_json::Value>>>) -> Self {
        Self {
            definition: ToolDefinition::new(
                name,
                1,
                ToolEffect::Write {
                    minimum_risk: RiskLevel::L3,
                    snapshot_required: true,
                    confirmation_arg: Some("path".to_owned()),
                },
            )
            .unwrap(),
            effects,
        }
    }

    fn blocked(name: &str, effects: Arc<Mutex<Vec<serde_json::Value>>>) -> Self {
        Self {
            definition: ToolDefinition::new(name, 1, ToolEffect::Blocked).unwrap(),
            effects,
        }
    }
}

#[async_trait]
impl ToolExecutor for RecordingExecutor {
    fn definition(&self) -> ToolDefinition {
        self.definition.clone()
    }

    async fn prepare(&self, call: &ToolCall) -> Result<ToolAction, CoreError> {
        Ok(match self.definition.effect() {
            ToolEffect::Blocked => {
                ToolAction::Write(OperationPlan::new(call.args.clone(), "blocked"))
            }
            ToolEffect::Write { .. } => {
                ToolAction::Write(OperationPlan::new(call.args.clone(), "delete remote file"))
            }
            ToolEffect::Read => ToolAction::Read(ToolResult::new(serde_json::json!({}))),
        })
    }

    async fn execute(&self, operation: ApprovedOperation) -> Result<ToolResult, CoreError> {
        self.effects.lock().await.push(operation.args().clone());
        Ok(ToolResult::new(serde_json::json!({ "ok": true })))
    }
}

fn tool_call(name: &str, args: serde_json::Value) -> ToolCall {
    ToolCall {
        tool_call_id: Id::new(),
        run_id: Id::new(),
        server_id: Id::new(),
        name: name.to_owned(),
        schema_version: 1,
        args,
    }
}
