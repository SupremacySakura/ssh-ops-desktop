use opspilot_domain::{Id, RiskLevel, ServerEnvironment};
use opspilot_task_engine::{OperationKind, ResourceScope, RiskContext, RiskEvaluator};

#[test]
fn policy_combines_operation_environment_and_resource_scope() {
    let evaluator = RiskEvaluator;
    let production_service = RiskContext::new(
        ServerEnvironment::Production,
        ResourceScope::try_new("service", "nginx.service", "nginx.service", None).unwrap(),
    );
    let development_service = RiskContext::new(
        ServerEnvironment::Development,
        ResourceScope::try_new("service", "nginx.service", "nginx.service", None).unwrap(),
    );

    assert_eq!(
        evaluator
            .evaluate(OperationKind::Read, Some(&production_service))
            .level,
        RiskLevel::L0
    );
    assert_eq!(
        evaluator
            .evaluate(OperationKind::ServiceRestart, Some(&development_service))
            .level,
        RiskLevel::L1
    );
    assert_eq!(
        evaluator
            .evaluate(OperationKind::ServiceRestart, Some(&production_service))
            .level,
        RiskLevel::L2
    );
}

#[test]
fn l3_requires_snapshot_and_confirmation_target_while_l4_is_never_approvable() {
    let evaluator = RiskEvaluator;
    let scope = RiskContext::new(
        ServerEnvironment::Production,
        ResourceScope::try_new(
            "file",
            "/etc/ssh/sshd_config",
            "/etc/ssh/sshd_config",
            Some(Id::new().to_string()),
        )
        .unwrap(),
    );

    let l3 = evaluator.evaluate(OperationKind::SecurityConfigurationOverwrite, Some(&scope));
    assert_eq!(l3.level, RiskLevel::L3);
    assert!(l3.approval_required);
    assert!(l3.snapshot_required);
    assert!(
        l3.confirmation_text
            .as_deref()
            .unwrap()
            .contains("/etc/ssh/sshd_config")
    );

    let l4 = evaluator.evaluate(OperationKind::DisableSsh, Some(&scope));
    assert_eq!(l4.level, RiskLevel::L4);
    assert!(!l4.approval_required);
    assert!(!l4.snapshot_required);
}

#[test]
fn missing_context_fails_closed_and_scope_rejects_control_characters() {
    let evaluator = RiskEvaluator;
    assert_eq!(
        evaluator
            .evaluate(OperationKind::ServiceRestart, None)
            .level,
        RiskLevel::L4
    );
    assert!(ResourceScope::try_new("file", "/srv/a\nb", "unsafe", None).is_err());
}
