use std::sync::Arc;

use opspilot_domain::{CoreError, CoreErrorCode, Id, ToolCall};
use opspilot_task_engine::{OperationActor, OperationGateway, PrepareResult};
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentRunScope {
    pub run_id: Id,
    pub server_id: Id,
    pub project_id: Option<Id>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolDescriptor {
    pub name: String,
    pub schema_version: u8,
    pub description: String,
    pub input_schema: Value,
}

impl ToolDescriptor {
    pub fn try_new(name: &str, description: &str, input_schema: Value) -> Result<Self, CoreError> {
        if name.is_empty()
            || name.len() > 128
            || !name.chars().all(|character| {
                character.is_ascii_lowercase()
                    || character.is_ascii_digit()
                    || matches!(character, '.' | '_' | '-')
            })
            || description.trim().is_empty()
            || !input_schema.is_object()
        {
            return Err(validation("Agent tool descriptor is invalid"));
        }
        Ok(Self {
            name: name.to_owned(),
            schema_version: 1,
            description: description.trim().to_owned(),
            input_schema,
        })
    }
}

#[derive(Clone)]
pub struct ToolRegistry {
    gateway: Arc<dyn OperationGateway>,
    descriptors: Arc<Vec<ToolDescriptor>>,
}

impl ToolRegistry {
    pub fn new(
        gateway: Arc<dyn OperationGateway>,
        descriptors: Vec<ToolDescriptor>,
    ) -> Result<Self, CoreError> {
        let mut names = descriptors
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>();
        names.sort_unstable();
        if names.windows(2).any(|pair| pair[0] == pair[1]) {
            return Err(CoreError::new(
                CoreErrorCode::Conflict,
                "Agent tool names must be unique",
                false,
            ));
        }
        Ok(Self {
            gateway,
            descriptors: Arc::new(descriptors),
        })
    }

    pub fn catalog(&self) -> &[ToolDescriptor] {
        &self.descriptors
    }

    pub async fn request(
        &self,
        scope: &AgentRunScope,
        call: ToolCall,
    ) -> Result<PrepareResult, CoreError> {
        if call.run_id != scope.run_id || call.server_id != scope.server_id {
            return Err(CoreError::new(
                CoreErrorCode::ToolScopeViolation,
                "Agent tool request is outside the run scope",
                false,
            ));
        }
        let descriptor = self
            .descriptors
            .iter()
            .find(|descriptor| descriptor.name == call.name)
            .ok_or_else(|| {
                CoreError::new(
                    CoreErrorCode::NotFound,
                    "Agent tool is not in the Rust catalog",
                    false,
                )
            })?;
        if descriptor.schema_version != call.schema_version {
            return Err(validation(
                "Agent tool schema version does not match the Rust catalog",
            ));
        }
        self.gateway
            .prepare(
                call,
                OperationActor::Agent {
                    agent_run_id: scope.run_id,
                },
            )
            .await
    }
}

fn validation(message: &str) -> CoreError {
    CoreError::new(CoreErrorCode::Validation, message, false)
}
