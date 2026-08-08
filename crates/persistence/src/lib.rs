#![forbid(unsafe_code)]

//! SQLite persistence primitives for OpsPilot.

mod agent_repository;
mod database;
mod model_profile_repository;
mod project_repository;
mod server_repository;
mod task_repository;

pub use agent_repository::{AgentRepository, AgentRunSummary, AgentThreadSummary};
pub use database::Database;
pub use model_profile_repository::{
    ModelProfileInput, ModelProfileRepository, ModelProfileSummary,
};
pub use project_repository::ProjectRepository;
pub use server_repository::ServerRepository;
pub use task_repository::{TaskEvent, TaskEventPage, TaskRepository};
