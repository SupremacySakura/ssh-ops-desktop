use serde::{Deserialize, Deserializer, Serializer};

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
