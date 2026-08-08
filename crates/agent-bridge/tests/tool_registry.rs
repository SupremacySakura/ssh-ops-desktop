use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use async_trait::async_trait;
use opspilot_agent_bridge::{AgentContextBuilder, AgentRunScope, ToolDescriptor, ToolRegistry};
use opspilot_audit::Redactor;
use opspilot_domain::{CoreError, CoreErrorCode, Id, ToolCall};
use opspilot_task_engine::{
    ApprovalProof, OperationActor, OperationGateway, OperationState, PrepareResult, TaskRef,
};

#[tokio::test]
async fn rejects_tool_target_outside_the_run_scope_before_gateway_execution() {
    let calls = Arc::new(AtomicUsize::new(0));
    let registry = ToolRegistry::new(
        Arc::new(CountingGateway(calls.clone())),
        vec![
            ToolDescriptor::try_new(
                "server.overview",
                "Read server overview",
                serde_json::json!({ "type": "object" }),
            )
            .unwrap(),
        ],
    )
    .unwrap();
    let scope = AgentRunScope {
        run_id: Id::new(),
        server_id: Id::new(),
        project_id: None,
    };
    let error = registry
        .request(
            &scope,
            ToolCall {
                tool_call_id: Id::new(),
                run_id: scope.run_id,
                server_id: Id::new(),
                name: "server.overview".to_owned(),
                schema_version: 1,
                args: serde_json::json!({}),
            },
        )
        .await
        .unwrap_err();
    assert_eq!(error.code(), CoreErrorCode::ToolScopeViolation);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn context_removes_credentials_identity_and_bounds_logs() {
    let context = AgentContextBuilder::new(Redactor::new(["fixture-secret"]))
        .build(serde_json::json!({
            "host": "prod.example.com", "username": "root",
            "authorization": "Bearer fixture-secret", "cpu": 0.5,
            "disk": { "used": 42 }, "logs": (0..300).map(|line| format!("line {line}" )).collect::<Vec<_>>().join("\n"),
        })).unwrap();
    let encoded = serde_json::to_string(&context.value).unwrap();
    assert!(!encoded.contains("prod.example.com"));
    assert!(!encoded.contains("fixture-secret"));
    assert!(encoded.contains("\"cpu\":0.5"));
    assert!(encoded.contains("\"used\":42"));
    assert_eq!(context.value["logs"].as_str().unwrap().lines().count(), 200);
}

struct CountingGateway(Arc<AtomicUsize>);

#[async_trait]
impl OperationGateway for CountingGateway {
    async fn prepare(
        &self,
        _call: ToolCall,
        _actor: OperationActor,
    ) -> Result<PrepareResult, CoreError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Err(CoreError::new(
            CoreErrorCode::Internal,
            "not expected",
            false,
        ))
    }
    async fn approve_and_submit(&self, _proof: ApprovalProof) -> Result<TaskRef, CoreError> {
        unreachable!()
    }
    async fn reject(&self, _approval_id: Id) -> Result<(), CoreError> {
        unreachable!()
    }
    async fn status(&self, _tool_call_id: Id) -> Result<OperationState, CoreError> {
        unreachable!()
    }
}
