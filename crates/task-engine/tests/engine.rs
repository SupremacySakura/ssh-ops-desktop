use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use async_trait::async_trait;
use opspilot_domain::{CoreError, CoreErrorCode, RiskDecision, RiskLevel, TaskStatus};
use opspilot_task_engine::{
    CancelCapability, PlannedStep, RetryPolicy, SnapshotRef, Snapshotter, StepContext, StepRunner,
    TaskEngine, TaskPlan,
};

#[tokio::test]
async fn failed_snapshotted_task_can_roll_back_once() {
    let snapshotter = Arc::new(RecordingSnapshotter::default());
    let engine = TaskEngine::new();
    let task_id = engine
        .submit(TaskPlan::new(
            risk(RiskLevel::L3, true),
            vec![
                PlannedStep::new(
                    "apply",
                    RetryPolicy::Never,
                    CancelCapability::StopAfterCurrentStep,
                    Arc::new(FailingStep),
                )
                .unwrap(),
            ],
            Some(snapshotter.clone()),
        ))
        .await
        .unwrap();

    assert_eq!(
        engine.wait(task_id).await.unwrap().status,
        TaskStatus::Failed
    );
    engine.rollback(task_id).await.unwrap();
    assert_eq!(
        engine.get(task_id).await.unwrap().status,
        TaskStatus::RolledBack
    );
    assert_eq!(snapshotter.restores.load(Ordering::SeqCst), 1);
    assert!(engine.rollback(task_id).await.is_err());
}

#[tokio::test]
async fn cooperative_running_task_can_be_cancelled_and_l3_without_snapshot_is_rejected() {
    let engine = TaskEngine::new();
    let task_id = engine
        .submit(TaskPlan::new(
            risk(RiskLevel::L1, false),
            vec![
                PlannedStep::new(
                    "wait",
                    RetryPolicy::Safe {
                        max_attempts: 1,
                        backoff_ms: 1,
                    },
                    CancelCapability::Cooperative,
                    Arc::new(CooperativeStep),
                )
                .unwrap(),
            ],
            None,
        ))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(10)).await;
    engine.cancel(task_id).await.unwrap();
    assert_eq!(
        engine.wait(task_id).await.unwrap().status,
        TaskStatus::Cancelled
    );

    let rejected = engine
        .submit(TaskPlan::new(risk(RiskLevel::L3, true), vec![], None))
        .await
        .expect_err("L3 must have a snapshotter");
    assert_eq!(rejected.code(), CoreErrorCode::ApprovalMismatch);
}

#[derive(Default)]
struct RecordingSnapshotter {
    restores: AtomicUsize,
}

#[async_trait]
impl Snapshotter for RecordingSnapshotter {
    async fn create(&self) -> Result<SnapshotRef, CoreError> {
        Ok(SnapshotRef::try_new("snapshot-1", "a".repeat(64)).unwrap())
    }

    async fn restore(&self, _snapshot: &SnapshotRef) -> Result<(), CoreError> {
        self.restores.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

struct FailingStep;

#[async_trait]
impl StepRunner for FailingStep {
    async fn run(&self, _context: StepContext) -> Result<(), CoreError> {
        Err(CoreError::new(
            CoreErrorCode::RemoteCommand,
            "fixture failure",
            false,
        ))
    }
}

struct CooperativeStep;

#[async_trait]
impl StepRunner for CooperativeStep {
    async fn run(&self, context: StepContext) -> Result<(), CoreError> {
        loop {
            if context.is_cancelled() {
                return Err(CoreError::new(CoreErrorCode::Cancelled, "cancelled", false));
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    }
}

fn risk(level: RiskLevel, snapshot_required: bool) -> RiskDecision {
    RiskDecision {
        level,
        approval_required: level != RiskLevel::L0,
        snapshot_required,
        confirmation_text: None,
        reason: "test".to_owned(),
    }
}
