use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use opspilot_domain::{CoreError, CoreErrorCode, Id, RiskDecision, RiskLevel, TaskStatus};
use serde::Serialize;
use tokio::sync::{Mutex, Notify};

use crate::{CancelCapability, PlannedStep, RetryPolicy, SnapshotRef, Snapshotter, StepContext};

pub struct TaskPlan {
    risk: RiskDecision,
    steps: Vec<PlannedStep>,
    snapshotter: Option<Arc<dyn Snapshotter>>,
}

impl TaskPlan {
    pub fn new(
        risk: RiskDecision,
        steps: Vec<PlannedStep>,
        snapshotter: Option<Arc<dyn Snapshotter>>,
    ) -> Self {
        Self {
            risk,
            steps,
            snapshotter,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSnapshot {
    pub task_id: Id,
    pub status: TaskStatus,
    pub sequence: u64,
    pub current_step: Option<String>,
    pub error: Option<CoreError>,
}

struct RuntimeTask {
    snapshot: TaskSnapshot,
    cancelled: Arc<AtomicBool>,
    cancel_capability: CancelCapability,
    snapshot_ref: Option<SnapshotRef>,
    snapshotter: Option<Arc<dyn Snapshotter>>,
    notify: Arc<Notify>,
}

#[derive(Clone, Default)]
pub struct TaskEngine {
    tasks: Arc<Mutex<HashMap<Id, RuntimeTask>>>,
}

impl TaskEngine {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn submit(&self, plan: TaskPlan) -> Result<Id, CoreError> {
        if plan.risk.level == RiskLevel::L4 {
            return Err(CoreError::new(
                CoreErrorCode::ApprovalMismatch,
                "L4 operations cannot be submitted",
                false,
            ));
        }
        if plan.risk.level == RiskLevel::L3
            && (!plan.risk.snapshot_required || plan.snapshotter.is_none())
        {
            return Err(CoreError::new(
                CoreErrorCode::ApprovalMismatch,
                "L3 operation requires a snapshot plan",
                false,
            ));
        }
        let snapshot_ref = match &plan.snapshotter {
            Some(snapshotter) if plan.risk.snapshot_required => Some(snapshotter.create().await?),
            _ => None,
        };
        let task_id = Id::new();
        let cancelled = Arc::new(AtomicBool::new(false));
        let notify = Arc::new(Notify::new());
        self.tasks.lock().await.insert(
            task_id,
            RuntimeTask {
                snapshot: TaskSnapshot {
                    task_id,
                    status: TaskStatus::Pending,
                    sequence: 1,
                    current_step: None,
                    error: None,
                },
                cancelled: cancelled.clone(),
                cancel_capability: CancelCapability::Cooperative,
                snapshot_ref,
                snapshotter: plan.snapshotter,
                notify: notify.clone(),
            },
        );
        let engine = self.clone();
        tokio::spawn(async move {
            engine.run(task_id, plan.steps, cancelled).await;
        });
        Ok(task_id)
    }

    pub async fn get(&self, task_id: Id) -> Result<TaskSnapshot, CoreError> {
        self.tasks
            .lock()
            .await
            .get(&task_id)
            .map(|task| task.snapshot.clone())
            .ok_or_else(|| not_found("task"))
    }

    pub async fn wait(&self, task_id: Id) -> Result<TaskSnapshot, CoreError> {
        loop {
            let (snapshot, notify) = {
                let tasks = self.tasks.lock().await;
                let task = tasks.get(&task_id).ok_or_else(|| not_found("task"))?;
                (task.snapshot.clone(), task.notify.clone())
            };
            if is_terminal(snapshot.status) {
                return Ok(snapshot);
            }
            notify.notified().await;
        }
    }

    pub async fn cancel(&self, task_id: Id) -> Result<(), CoreError> {
        let mut tasks = self.tasks.lock().await;
        let task = tasks.get_mut(&task_id).ok_or_else(|| not_found("task"))?;
        if !matches!(
            task.snapshot.status,
            TaskStatus::Pending | TaskStatus::Running
        ) {
            return Err(CoreError::new(
                CoreErrorCode::Conflict,
                "task cannot be cancelled from its current state",
                false,
            ));
        }
        if let CancelCapability::NotCancelable { reason } = &task.cancel_capability {
            return Err(CoreError::new(
                CoreErrorCode::Conflict,
                reason.clone(),
                false,
            ));
        }
        task.cancelled.store(true, Ordering::SeqCst);
        if task.snapshot.status == TaskStatus::Pending {
            transition(task, TaskStatus::Cancelled, None, None);
        }
        Ok(())
    }

    pub async fn rollback(&self, task_id: Id) -> Result<(), CoreError> {
        let (snapshotter, snapshot) = {
            let mut tasks = self.tasks.lock().await;
            let task = tasks.get_mut(&task_id).ok_or_else(|| not_found("task"))?;
            if !matches!(
                task.snapshot.status,
                TaskStatus::Failed | TaskStatus::Interrupted
            ) {
                return Err(CoreError::new(
                    CoreErrorCode::Conflict,
                    "task cannot be rolled back from its current state",
                    false,
                ));
            }
            let snapshotter = task.snapshotter.clone().ok_or_else(|| {
                CoreError::new(CoreErrorCode::Conflict, "task has no snapshotter", false)
            })?;
            let snapshot = task.snapshot_ref.clone().ok_or_else(|| {
                CoreError::new(CoreErrorCode::Conflict, "task has no snapshot", false)
            })?;
            transition(task, TaskStatus::RollingBack, None, None);
            (snapshotter, snapshot)
        };
        let restored = snapshotter.restore(&snapshot).await;
        let mut tasks = self.tasks.lock().await;
        let task = tasks.get_mut(&task_id).ok_or_else(|| not_found("task"))?;
        match restored {
            Ok(()) => transition(task, TaskStatus::RolledBack, None, None),
            Err(error) => transition(task, TaskStatus::RollbackFailed, None, Some(error)),
        }
        Ok(())
    }

    async fn run(&self, task_id: Id, steps: Vec<PlannedStep>, cancelled: Arc<AtomicBool>) {
        if self.set_running(task_id).await.is_err() {
            return;
        }
        for step in steps {
            {
                let mut tasks = self.tasks.lock().await;
                let Some(task) = tasks.get_mut(&task_id) else {
                    return;
                };
                if task.snapshot.status == TaskStatus::Cancelled {
                    return;
                }
                task.cancel_capability = step.cancel.clone();
                task.snapshot.current_step = Some(step.name.clone());
                task.snapshot.sequence = task.snapshot.sequence.saturating_add(1);
                task.notify.notify_waiters();
            }
            let (max_attempts, backoff_ms) = match step.retry {
                RetryPolicy::Never => (1, 0),
                RetryPolicy::Safe {
                    max_attempts,
                    backoff_ms,
                } => (max_attempts, backoff_ms),
            };
            let mut failure = None;
            for attempt in 1..=max_attempts {
                match step.runner.run(StepContext::new(cancelled.clone())).await {
                    Ok(()) => {
                        failure = None;
                        break;
                    }
                    Err(error) => {
                        failure = Some(error);
                        if attempt < max_attempts && !cancelled.load(Ordering::SeqCst) {
                            tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
                        }
                    }
                }
            }
            if cancelled.load(Ordering::SeqCst) {
                self.finish(task_id, TaskStatus::Cancelled, None).await;
                return;
            }
            if let Some(error) = failure {
                self.finish(task_id, TaskStatus::Failed, Some(error)).await;
                return;
            }
        }
        self.finish(task_id, TaskStatus::Succeeded, None).await;
    }

    async fn set_running(&self, task_id: Id) -> Result<(), CoreError> {
        let mut tasks = self.tasks.lock().await;
        let task = tasks.get_mut(&task_id).ok_or_else(|| not_found("task"))?;
        if task.snapshot.status == TaskStatus::Cancelled {
            return Err(CoreError::new(
                CoreErrorCode::Cancelled,
                "task was cancelled",
                false,
            ));
        }
        transition(task, TaskStatus::Running, None, None);
        Ok(())
    }

    async fn finish(&self, task_id: Id, status: TaskStatus, error: Option<CoreError>) {
        let mut tasks = self.tasks.lock().await;
        if let Some(task) = tasks.get_mut(&task_id) {
            transition(task, status, None, error);
        }
    }
}

fn transition(
    task: &mut RuntimeTask,
    status: TaskStatus,
    current_step: Option<String>,
    error: Option<CoreError>,
) {
    task.snapshot.status = status;
    task.snapshot.sequence = task.snapshot.sequence.saturating_add(1);
    task.snapshot.current_step = current_step;
    task.snapshot.error = error;
    task.notify.notify_waiters();
}

fn is_terminal(status: TaskStatus) -> bool {
    matches!(
        status,
        TaskStatus::Succeeded
            | TaskStatus::Failed
            | TaskStatus::Cancelled
            | TaskStatus::Interrupted
            | TaskStatus::RolledBack
            | TaskStatus::RollbackFailed
    )
}

fn not_found(resource: &str) -> CoreError {
    CoreError::new(
        CoreErrorCode::NotFound,
        format!("{resource} was not found"),
        false,
    )
}
