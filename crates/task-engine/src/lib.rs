#![forbid(unsafe_code)]

//! Persistent task state, risk evaluation, and the sole remote-write gateway.

mod engine;
mod gateway;
mod risk;
mod snapshot;
mod state;
mod step;

pub use engine::{TaskEngine, TaskPlan, TaskSnapshot};
pub use gateway::{
    ApprovalProof, ApprovedOperation, OperationActor, OperationGateway, OperationPlan,
    OperationState, PrepareResult, PreparedOperation, SqliteOperationGateway, TaskRef, ToolAction,
    ToolCatalog, ToolDefinition, ToolEffect, ToolExecutor, ToolResult,
};
pub use risk::{OperationKind, ResourceScope, RiskContext, RiskEvaluator};
pub use snapshot::{SnapshotRef, Snapshotter};
pub use state::TaskState;
pub use step::{CancelCapability, PlannedStep, RetryPolicy, StepContext, StepRunner};
