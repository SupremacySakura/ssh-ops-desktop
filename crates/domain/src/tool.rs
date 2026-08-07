use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::Id;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolCall {
    pub tool_call_id: Id,
    pub run_id: Id,
    pub server_id: Id,
    #[serde(
        deserialize_with = "crate::validation::deserialize_tool_name",
        serialize_with = "crate::validation::serialize_tool_name"
    )]
    pub name: String,
    #[serde(
        deserialize_with = "deserialize_schema_version",
        serialize_with = "serialize_schema_version"
    )]
    pub schema_version: u8,
    pub args: serde_json::Value,
}

fn deserialize_schema_version<'de, D>(deserializer: D) -> Result<u8, D::Error>
where
    D: Deserializer<'de>,
{
    let version = u8::deserialize(deserializer)?;
    if version == 1 {
        Ok(version)
    } else {
        Err(<D::Error as serde::de::Error>::custom(
            "unsupported tool call schema version",
        ))
    }
}

fn serialize_schema_version<S>(version: &u8, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    if *version == 1 {
        serializer.serialize_u8(*version)
    } else {
        Err(<S::Error as serde::ser::Error>::custom(
            "unsupported tool call schema version",
        ))
    }
}
