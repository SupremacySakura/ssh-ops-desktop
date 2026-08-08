#![forbid(unsafe_code)]

//! Shared OpsPilot domain contracts.

mod agent;
mod error;
mod id;
mod project;
mod risk;
mod server;
mod task;
mod tool;
mod validation;

pub use agent::AgentRunStatus;
pub use error::{CoreError, CoreErrorCode};
pub use id::Id;
pub use project::{DeployStrategy, ProjectInput, ProjectRoot, ProjectSummary, RuntimeType};
pub use risk::{RiskDecision, RiskLevel};
pub use server::{
    AuthType, Host, ServerEnvironment, ServerGroup, ServerInput, ServerPort, ServerSummary,
    ServerTag,
};
pub use task::TaskStatus;
pub use tool::ToolCall;
