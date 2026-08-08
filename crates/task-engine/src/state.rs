use opspilot_domain::{CoreError, CoreErrorCode, TaskStatus};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskState {
    status: TaskStatus,
}

impl TaskState {
    pub fn new() -> Self {
        Self {
            status: TaskStatus::Pending,
        }
    }

    pub fn status(&self) -> TaskStatus {
        self.status
    }

    pub fn start(self) -> Result<Self, CoreError> {
        self.transition(&[TaskStatus::Pending], TaskStatus::Running)
    }

    pub fn succeed(self) -> Result<Self, CoreError> {
        self.transition(&[TaskStatus::Running], TaskStatus::Succeeded)
    }

    pub fn fail(self) -> Result<Self, CoreError> {
        self.transition(&[TaskStatus::Running], TaskStatus::Failed)
    }

    pub fn cancel(self) -> Result<Self, CoreError> {
        self.transition(
            &[TaskStatus::Pending, TaskStatus::Running],
            TaskStatus::Cancelled,
        )
    }

    pub fn interrupt(self) -> Result<Self, CoreError> {
        self.transition(&[TaskStatus::Running], TaskStatus::Interrupted)
    }

    pub fn explicit_retry(self) -> Result<Self, CoreError> {
        self.transition(
            &[TaskStatus::Failed, TaskStatus::Interrupted],
            TaskStatus::Pending,
        )
    }

    pub fn begin_rollback(self) -> Result<Self, CoreError> {
        self.transition(&[TaskStatus::Failed], TaskStatus::RollingBack)
    }

    pub fn rollback_succeeded(self) -> Result<Self, CoreError> {
        self.transition(&[TaskStatus::RollingBack], TaskStatus::RolledBack)
    }

    pub fn rollback_failed(self) -> Result<Self, CoreError> {
        self.transition(&[TaskStatus::RollingBack], TaskStatus::RollbackFailed)
    }

    fn transition(self, allowed: &[TaskStatus], next: TaskStatus) -> Result<Self, CoreError> {
        if !allowed.contains(&self.status) {
            return Err(CoreError::new(
                CoreErrorCode::Conflict,
                format!(
                    "task cannot transition from {:?} to {:?}",
                    self.status, next
                ),
                false,
            ));
        }
        Ok(Self { status: next })
    }
}

impl Default for TaskState {
    fn default() -> Self {
        Self::new()
    }
}
