use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum RiskLevel {
    L0,
    L1,
    L2,
    L3,
    L4,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RiskDecision {
    pub level: RiskLevel,
    pub approval_required: bool,
    pub snapshot_required: bool,
    #[serde(
        default,
        deserialize_with = "crate::validation::deserialize_optional_non_empty_string",
        serialize_with = "crate::validation::serialize_optional_non_empty_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub confirmation_text: Option<String>,
    #[serde(
        deserialize_with = "crate::validation::deserialize_non_empty_string",
        serialize_with = "crate::validation::serialize_non_empty_string"
    )]
    pub reason: String,
}
