use std::str::FromStr;

use opspilot_domain::{
    CoreError, CoreErrorCode, Id, RiskDecision, RiskLevel, TaskStatus, ToolCall,
};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

const CORE_ERROR_FIXTURE: &str = include_str!("../../../tests/contract-fixtures/core-error.json");
const RISK_DECISION_NO_CONFIRMATION_FIXTURE: &str =
    include_str!("../../../tests/contract-fixtures/risk-decision-no-confirmation.json");
const RISK_DECISION_FIXTURE: &str =
    include_str!("../../../tests/contract-fixtures/risk-decision.json");
const TASK_STATUS_FIXTURE: &str = include_str!("../../../tests/contract-fixtures/task-status.json");
const TOOL_CALL_FIXTURE: &str = include_str!("../../../tests/contract-fixtures/tool-call.json");
const TOOL_SCOPE_VIOLATION_FIXTURE: &str =
    include_str!("../../../tests/contract-fixtures/tool-scope-violation.json");

fn fixture_value(source: &str) -> Value {
    serde_json::from_str(source).expect("fixture must contain valid JSON")
}

fn fixture_as<T: DeserializeOwned>(source: &str) -> T {
    serde_json::from_str(source).expect("fixture must match the Rust contract")
}

#[test]
fn rust_types_read_typescript_fixtures() {
    let risk: RiskDecision = fixture_as(RISK_DECISION_FIXTURE);
    assert_eq!(risk.level, RiskLevel::L2);
    assert!(risk.approval_required);

    let tool_call: ToolCall = fixture_as(TOOL_CALL_FIXTURE);
    assert_eq!(tool_call.name, "server.overview");
    assert_eq!(tool_call.schema_version, 1);
}

#[test]
fn rust_values_serialize_to_the_shared_fixtures() {
    let core_error = CoreError::new(CoreErrorCode::SshHostKeyChanged, "blocked", false);
    assert_eq!(
        serde_json::to_value(core_error).unwrap(),
        fixture_value(CORE_ERROR_FIXTURE)
    );

    let risk = RiskDecision {
        level: RiskLevel::L2,
        approval_required: true,
        snapshot_required: false,
        confirmation_text: Some("Restart nginx".to_owned()),
        reason: "service restart changes remote state".to_owned(),
    };
    assert_eq!(
        serde_json::to_value(risk).unwrap(),
        fixture_value(RISK_DECISION_FIXTURE)
    );

    let tool_call = ToolCall {
        tool_call_id: Id::from_str("019c62b2-2970-7000-8000-000000000001").unwrap(),
        run_id: Id::from_str("019c62b2-2970-7000-8000-000000000002").unwrap(),
        server_id: Id::from_str("019c62b2-2970-7000-8000-000000000003").unwrap(),
        name: "server.overview".to_owned(),
        schema_version: 1,
        args: json!({ "includeMetrics": true }),
    };
    assert_eq!(
        serde_json::to_value(tool_call).unwrap(),
        fixture_value(TOOL_CALL_FIXTURE)
    );
}

#[test]
fn absent_confirmation_text_is_omitted_from_rust_json() {
    let risk = RiskDecision {
        level: RiskLevel::L0,
        approval_required: false,
        snapshot_required: false,
        confirmation_text: None,
        reason: "read-only operation".to_owned(),
    };

    assert_eq!(
        serde_json::to_value(risk).unwrap(),
        fixture_value(RISK_DECISION_NO_CONFIRMATION_FIXTURE)
    );

    let decoded: RiskDecision = fixture_as(RISK_DECISION_NO_CONFIRMATION_FIXTURE);
    assert_eq!(decoded.confirmation_text, None);
}

#[test]
fn rust_rejects_unsupported_tool_call_schema_versions_in_both_directions() {
    let mut incoming = fixture_value(TOOL_CALL_FIXTURE);
    incoming["schemaVersion"] = json!(2);
    assert!(serde_json::from_value::<ToolCall>(incoming).is_err());

    let mut outgoing: ToolCall = fixture_as(TOOL_CALL_FIXTURE);
    outgoing.schema_version = 2;
    assert!(serde_json::to_value(outgoing).is_err());
}

#[test]
fn rust_rejects_empty_core_error_messages_in_both_directions() {
    let mut incoming = fixture_value(CORE_ERROR_FIXTURE);
    incoming["message"] = json!("");
    assert!(serde_json::from_value::<CoreError>(incoming).is_err());

    let outgoing = CoreError::new(CoreErrorCode::SshHostKeyChanged, "", false);
    assert!(serde_json::to_value(outgoing).is_err());
}

#[test]
fn rust_rejects_invalid_risk_text_in_both_directions() {
    let mut empty_reason = fixture_value(RISK_DECISION_FIXTURE);
    empty_reason["reason"] = json!("");
    assert!(serde_json::from_value::<RiskDecision>(empty_reason).is_err());

    let mut empty_confirmation = fixture_value(RISK_DECISION_FIXTURE);
    empty_confirmation["confirmationText"] = json!("");
    assert!(serde_json::from_value::<RiskDecision>(empty_confirmation).is_err());

    let mut null_confirmation = fixture_value(RISK_DECISION_FIXTURE);
    null_confirmation["confirmationText"] = Value::Null;
    assert!(serde_json::from_value::<RiskDecision>(null_confirmation).is_err());

    let empty_reason = RiskDecision {
        level: RiskLevel::L2,
        approval_required: true,
        snapshot_required: false,
        confirmation_text: Some("Restart nginx".to_owned()),
        reason: String::new(),
    };
    assert!(serde_json::to_value(empty_reason).is_err());

    let empty_confirmation = RiskDecision {
        level: RiskLevel::L2,
        approval_required: true,
        snapshot_required: false,
        confirmation_text: Some(String::new()),
        reason: "service restart changes remote state".to_owned(),
    };
    assert!(serde_json::to_value(empty_confirmation).is_err());
}

#[test]
fn rust_rejects_invalid_tool_names_in_both_directions() {
    let mut incoming = fixture_value(TOOL_CALL_FIXTURE);
    incoming["name"] = json!("Server Overview");
    assert!(serde_json::from_value::<ToolCall>(incoming).is_err());

    let mut outgoing: ToolCall = fixture_as(TOOL_CALL_FIXTURE);
    outgoing.name = "Server Overview".to_owned();
    assert!(serde_json::to_value(outgoing).is_err());
}

#[test]
fn all_nine_task_status_values_round_trip() {
    let statuses = vec![
        TaskStatus::Pending,
        TaskStatus::Running,
        TaskStatus::Succeeded,
        TaskStatus::Failed,
        TaskStatus::Cancelled,
        TaskStatus::Interrupted,
        TaskStatus::RollingBack,
        TaskStatus::RolledBack,
        TaskStatus::RollbackFailed,
    ];
    assert_eq!(
        serde_json::to_value(&statuses).unwrap(),
        fixture_value(TASK_STATUS_FIXTURE)
    );

    let decoded: Vec<TaskStatus> = fixture_as(TASK_STATUS_FIXTURE);
    assert_eq!(decoded, statuses);
}

#[test]
fn scope_violation_stays_distinct_from_approval_mismatch() {
    let error: CoreError = fixture_as(TOOL_SCOPE_VIOLATION_FIXTURE);
    assert_eq!(error.code(), CoreErrorCode::ToolScopeViolation);
    assert_ne!(error.code(), CoreErrorCode::ApprovalMismatch);

    let expected = CoreError::new(
        CoreErrorCode::ToolScopeViolation,
        "tool target is outside the run scope",
        false,
    );
    assert_eq!(
        serde_json::to_value(expected).unwrap(),
        fixture_value(TOOL_SCOPE_VIOLATION_FIXTURE)
    );
}

#[test]
fn core_error_display_uses_the_wire_error_code() {
    let error = CoreError::new(CoreErrorCode::SshHostKeyChanged, "blocked", false);

    assert_eq!(error.to_string(), "SSH_HOST_KEY_CHANGED: blocked");
}

#[test]
fn rust_rejects_unknown_fields_in_strict_contracts() {
    let mut core_error = fixture_value(CORE_ERROR_FIXTURE);
    core_error["details"] = json!({ "host": "example.com" });
    assert!(serde_json::from_value::<CoreError>(core_error).is_err());

    let mut risk = fixture_value(RISK_DECISION_FIXTURE);
    risk["policyVersion"] = json!(1);
    assert!(serde_json::from_value::<RiskDecision>(risk).is_err());

    let mut tool_call = fixture_value(TOOL_CALL_FIXTURE);
    tool_call["risk"] = json!("L0");
    assert!(serde_json::from_value::<ToolCall>(tool_call).is_err());
}

#[test]
fn rust_rejects_unknown_task_status_values() {
    assert!(serde_json::from_value::<TaskStatus>(json!("paused")).is_err());
}

#[test]
fn rust_rejects_unknown_core_error_codes() {
    let mut core_error = fixture_value(CORE_ERROR_FIXTURE);
    core_error["code"] = json!("SSH_PROTOCOL");

    assert!(serde_json::from_value::<CoreError>(core_error).is_err());
}
