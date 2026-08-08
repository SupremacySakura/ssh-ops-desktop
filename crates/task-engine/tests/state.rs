use opspilot_domain::{CoreErrorCode, TaskStatus};
use opspilot_task_engine::TaskState;

#[test]
fn completed_or_cancelled_task_cannot_run_again() {
    let succeeded = TaskState::new().start().unwrap().succeed().unwrap();
    assert_eq!(succeeded.status(), TaskStatus::Succeeded);
    assert_eq!(
        succeeded.start().unwrap_err().code(),
        CoreErrorCode::Conflict
    );

    let cancelled = TaskState::new().cancel().unwrap();
    assert_eq!(cancelled.status(), TaskStatus::Cancelled);
    assert_eq!(
        cancelled.start().unwrap_err().code(),
        CoreErrorCode::Conflict
    );
}

#[test]
fn interrupted_tasks_require_explicit_retry_and_rollback_has_terminal_states() {
    let interrupted = TaskState::new().start().unwrap().interrupt().unwrap();
    assert_eq!(interrupted.status(), TaskStatus::Interrupted);
    assert!(interrupted.clone().start().is_err());
    let retry = interrupted.explicit_retry().unwrap();
    assert_eq!(retry.status(), TaskStatus::Pending);

    let rolled_back = TaskState::new()
        .start()
        .unwrap()
        .fail()
        .unwrap()
        .begin_rollback()
        .unwrap()
        .rollback_succeeded()
        .unwrap();
    assert_eq!(rolled_back.status(), TaskStatus::RolledBack);
}
