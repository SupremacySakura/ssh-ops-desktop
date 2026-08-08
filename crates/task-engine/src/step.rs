use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use async_trait::async_trait;
use opspilot_domain::{CoreError, CoreErrorCode};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RetryPolicy {
    Never,
    Safe { max_attempts: u8, backoff_ms: u64 },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CancelCapability {
    Cooperative,
    StopAfterCurrentStep,
    NotCancelable { reason: String },
}

#[derive(Clone)]
pub struct StepContext {
    cancelled: Arc<AtomicBool>,
}

impl StepContext {
    pub(crate) fn new(cancelled: Arc<AtomicBool>) -> Self {
        Self { cancelled }
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

#[async_trait]
pub trait StepRunner: Send + Sync {
    async fn run(&self, context: StepContext) -> Result<(), CoreError>;
}

#[derive(Clone)]
pub struct PlannedStep {
    pub(crate) name: String,
    pub(crate) retry: RetryPolicy,
    pub(crate) cancel: CancelCapability,
    pub(crate) runner: Arc<dyn StepRunner>,
}

impl PlannedStep {
    pub fn new(
        name: &str,
        retry: RetryPolicy,
        cancel: CancelCapability,
        runner: Arc<dyn StepRunner>,
    ) -> Result<Self, CoreError> {
        let name = name.trim();
        if name.is_empty() || name.len() > 128 || name.chars().any(char::is_control) {
            return Err(CoreError::new(
                CoreErrorCode::Validation,
                "task step name is invalid",
                false,
            ));
        }
        if let RetryPolicy::Safe {
            max_attempts,
            backoff_ms,
        } = retry
            && (!(1..=10).contains(&max_attempts) || backoff_ms > 60_000)
        {
            return Err(CoreError::new(
                CoreErrorCode::Validation,
                "task step retry policy is invalid",
                false,
            ));
        }
        if let CancelCapability::NotCancelable { ref reason } = cancel
            && (reason.trim().is_empty() || reason.chars().any(char::is_control))
        {
            return Err(CoreError::new(
                CoreErrorCode::Validation,
                "non-cancelable task step requires a safe reason",
                false,
            ));
        }
        Ok(Self {
            name: name.to_owned(),
            retry,
            cancel,
            runner,
        })
    }
}
