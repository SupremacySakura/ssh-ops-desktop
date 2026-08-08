use opspilot_audit::Redactor;
use opspilot_domain::{CoreError, CoreErrorCode};
use serde::Serialize;
use serde_json::Value;

const MAX_CONTEXT_BYTES: usize = 64 * 1024;
const MAX_LOG_LINES: usize = 200;
const PRIVATE_FIELDS: [&str; 8] = [
    "host",
    "hostname",
    "username",
    "authorization",
    "cookie",
    "privatekey",
    "private_key",
    "rawconfig",
];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentContext {
    pub value: Value,
    pub truncated: bool,
}

#[derive(Clone, Debug, Default)]
pub struct AgentContextBuilder {
    redactor: Redactor,
}

impl AgentContextBuilder {
    pub fn new(redactor: Redactor) -> Self {
        Self { redactor }
    }

    pub fn build(&self, value: Value) -> Result<AgentContext, CoreError> {
        let mut value = self.redactor.json(value);
        remove_private_fields(&mut value);
        truncate_logs(&mut value);
        let mut encoded = serde_json::to_vec(&value).map_err(|error| {
            CoreError::new(
                CoreErrorCode::Internal,
                format!("failed to encode Agent context: {error}"),
                false,
            )
        })?;
        let truncated = encoded.len() > MAX_CONTEXT_BYTES;
        if truncated {
            encoded.truncate(MAX_CONTEXT_BYTES.saturating_sub(64));
            value = serde_json::json!({
                "summary": String::from_utf8_lossy(&encoded),
                "truncated": true,
            });
        }
        Ok(AgentContext { value, truncated })
    }
}

fn remove_private_fields(value: &mut Value) {
    match value {
        Value::Object(fields) => {
            fields.retain(|field, _| {
                let normalized = field.to_ascii_lowercase().replace(['-', ' '], "");
                !PRIVATE_FIELDS.contains(&normalized.as_str())
            });
            for value in fields.values_mut() {
                remove_private_fields(value);
            }
        }
        Value::Array(values) => values.iter_mut().for_each(remove_private_fields),
        _ => {}
    }
}

fn truncate_logs(value: &mut Value) {
    match value {
        Value::Object(fields) => {
            for (field, value) in fields {
                if field.to_ascii_lowercase().contains("log") {
                    if let Value::String(text) = value {
                        *text = text
                            .lines()
                            .take(MAX_LOG_LINES)
                            .collect::<Vec<_>>()
                            .join("\n");
                    }
                } else {
                    truncate_logs(value);
                }
            }
        }
        Value::Array(values) => values.iter_mut().for_each(truncate_logs),
        _ => {}
    }
}
