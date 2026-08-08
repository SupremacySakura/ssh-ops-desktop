use opspilot_domain::{CoreError, CoreErrorCode, RiskDecision, RiskLevel, ServerEnvironment};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationKind {
    Read,
    ReversibleWrite,
    ServiceRestart,
    ProjectUpdate,
    ContainerDelete,
    DestructiveCleanup,
    SecurityConfigurationOverwrite,
    RecursiveSystemDelete,
    FormatDisk,
    DisableSsh,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceScope {
    kind: String,
    id: String,
    label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    parent_id: Option<String>,
}

impl ResourceScope {
    pub fn try_new(
        kind: &str,
        id: &str,
        label: &str,
        parent_id: Option<String>,
    ) -> Result<Self, CoreError> {
        Ok(Self {
            kind: normalized(kind, "resource kind")?,
            id: normalized(id, "resource identifier")?,
            label: normalized(label, "resource label")?,
            parent_id: parent_id
                .map(|value| normalized(&value, "parent resource identifier"))
                .transpose()?,
        })
    }

    pub fn kind(&self) -> &str {
        &self.kind
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn label(&self) -> &str {
        &self.label
    }

    pub fn parent_id(&self) -> Option<&str> {
        self.parent_id.as_deref()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RiskContext {
    environment: ServerEnvironment,
    resource_scope: ResourceScope,
}

impl RiskContext {
    pub fn new(environment: ServerEnvironment, resource_scope: ResourceScope) -> Self {
        Self {
            environment,
            resource_scope,
        }
    }

    pub fn environment(&self) -> ServerEnvironment {
        self.environment
    }

    pub fn resource_scope(&self) -> &ResourceScope {
        &self.resource_scope
    }
}

#[derive(Clone, Debug, Default)]
pub struct RiskEvaluator;

impl RiskEvaluator {
    pub fn evaluate(
        &self,
        operation: OperationKind,
        context: Option<&RiskContext>,
    ) -> RiskDecision {
        if operation == OperationKind::Read {
            return decision(RiskLevel::L0, false, None, "read-only operation");
        }
        let Some(context) = context else {
            return blocked("operation context is incomplete; execution is blocked");
        };
        let is_production = context.environment == ServerEnvironment::Production;
        match operation {
            OperationKind::Read => unreachable!("read operations return before context validation"),
            OperationKind::ReversibleWrite => decision(
                if is_production {
                    RiskLevel::L2
                } else {
                    RiskLevel::L1
                },
                false,
                None,
                "reversible remote write",
            ),
            OperationKind::ServiceRestart | OperationKind::ProjectUpdate => decision(
                if is_production {
                    RiskLevel::L2
                } else {
                    RiskLevel::L1
                },
                false,
                None,
                if is_production {
                    "production workload may be temporarily unavailable"
                } else {
                    "workload state will change"
                },
            ),
            OperationKind::ContainerDelete => decision(
                RiskLevel::L2,
                false,
                None,
                "container state will be removed",
            ),
            OperationKind::DestructiveCleanup | OperationKind::SecurityConfigurationOverwrite => {
                decision(
                    RiskLevel::L3,
                    true,
                    Some(context.resource_scope.label()),
                    "high-impact operation requires a recoverable snapshot",
                )
            }
            OperationKind::RecursiveSystemDelete
            | OperationKind::FormatDisk
            | OperationKind::DisableSsh => {
                blocked("this destructive operation is not available through structured execution")
            }
        }
    }
}

fn decision(
    level: RiskLevel,
    snapshot_required: bool,
    confirmation_target: Option<&str>,
    reason: &str,
) -> RiskDecision {
    let confirmation_text = match level {
        RiskLevel::L0 => None,
        RiskLevel::L1 | RiskLevel::L2 => Some("Review the impact and confirm execution".to_owned()),
        RiskLevel::L3 => confirmation_target
            .map(|target| format!("Enter the exact resource name to confirm: {target}")),
        RiskLevel::L4 => None,
    };
    RiskDecision {
        level,
        approval_required: matches!(level, RiskLevel::L1 | RiskLevel::L2 | RiskLevel::L3),
        snapshot_required,
        confirmation_text,
        reason: reason.to_owned(),
    }
}

fn blocked(reason: &str) -> RiskDecision {
    decision(RiskLevel::L4, false, None, reason)
}

fn normalized(value: &str, field: &str) -> Result<String, CoreError> {
    let value = value.trim();
    if value.is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        return Err(CoreError::new(
            CoreErrorCode::Validation,
            format!("{field} must be non-empty and contain no control characters"),
            false,
        ));
    }
    Ok(value.to_owned())
}
