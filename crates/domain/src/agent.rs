use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRunStatus {
    Planning,
    AwaitingTool,
    AwaitingApproval,
    Executing,
    Summarizing,
    Succeeded,
    Failed,
    Cancelled,
    RecoveryRequired,
}
