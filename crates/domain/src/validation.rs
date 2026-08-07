use serde::{Deserialize, Deserializer, Serialize, Serializer};

pub(crate) fn deserialize_non_empty_string<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if value.is_empty() {
        Err(<D::Error as serde::de::Error>::custom(
            "expected a non-empty string",
        ))
    } else {
        Ok(value)
    }
}

pub(crate) fn serialize_non_empty_string<S>(value: &str, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    if value.is_empty() {
        Err(<S::Error as serde::ser::Error>::custom(
            "expected a non-empty string",
        ))
    } else {
        serializer.serialize_str(value)
    }
}

pub(crate) fn deserialize_optional_non_empty_string<'de, D>(
    deserializer: D,
) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    deserialize_non_empty_string(deserializer).map(Some)
}

pub(crate) fn serialize_optional_non_empty_string<S>(
    value: &Option<String>,
    serializer: S,
) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    match value {
        Some(value) => serialize_non_empty_string(value, serializer),
        None => Option::<String>::None.serialize(serializer),
    }
}

pub(crate) fn deserialize_tool_name<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if is_valid_tool_name(&value) {
        Ok(value)
    } else {
        Err(<D::Error as serde::de::Error>::custom("invalid tool name"))
    }
}

pub(crate) fn serialize_tool_name<S>(value: &str, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    if is_valid_tool_name(value) {
        serializer.serialize_str(value)
    } else {
        Err(<S::Error as serde::ser::Error>::custom("invalid tool name"))
    }
}

fn is_valid_tool_name(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 2
        && bytes[0].is_ascii_lowercase()
        && bytes[1..].iter().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(*byte, b'_' | b'.' | b'-')
        })
}
