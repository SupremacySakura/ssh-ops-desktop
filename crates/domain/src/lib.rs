#![forbid(unsafe_code)]

//! Shared OpsPilot domain contracts.

mod error;
mod id;
mod risk;
mod task;
mod tool;
mod validation;

pub use error::{CoreError, CoreErrorCode};
pub use id::Id;
pub use risk::{RiskDecision, RiskLevel};
pub use task::TaskStatus;
pub use tool::ToolCall;
