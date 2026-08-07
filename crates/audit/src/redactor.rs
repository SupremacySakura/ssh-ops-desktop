use std::error::Error;

use serde_json::Value;

const REDACTED: &str = "[REDACTED]";
const SENSITIVE_FIELDS: [&str; 8] = [
    "api_key",
    "authorization",
    "cookie",
    "passphrase",
    "password",
    "private_key",
    "secret",
    "token",
];
const ENVIRONMENT_MAP_FIELDS: [&str; 3] = ["env", "environment_variables", "environmentvariables"];

/// Applies field-aware and registered-value redaction to diagnostic data.
#[derive(Clone, Debug, Default)]
pub struct Redactor {
    secrets: Vec<String>,
}

impl Redactor {
    /// Registers exact secret values for fail-closed replacement.
    ///
    /// Values are redacted regardless of length because short credentials are
    /// still credentials. Callers must register actual secret values rather
    /// than generic words to avoid unnecessarily reducing diagnostic detail.
    pub fn new<I, S>(secrets: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let mut registered = Vec::new();
        for secret in secrets.into_iter().map(Into::into) {
            if !secret.is_empty() && !registered.contains(&secret) {
                registered.push(secret);
            }
        }
        registered.sort_by_key(|secret| std::cmp::Reverse(secret.len()));

        Self {
            secrets: registered,
        }
    }

    pub fn text(&self, value: &str) -> String {
        self.secrets
            .iter()
            .fold(value.to_owned(), |redacted, secret| {
                redacted.replace(secret, REDACTED)
            })
    }

    pub fn json(&self, mut value: Value) -> Value {
        self.redact_value(&mut value);
        value
    }

    pub fn error(&self, error: &(dyn Error + 'static)) -> String {
        let mut messages = Vec::new();
        let mut current = Some(error);

        while let Some(error) = current {
            messages.push(self.text(&error.to_string()));
            current = error.source();
        }

        messages.join(": ")
    }

    fn redact_value(&self, value: &mut Value) {
        match value {
            Value::Object(fields) => {
                for (field, value) in fields {
                    let normalized = field.to_ascii_lowercase();
                    if ENVIRONMENT_MAP_FIELDS.contains(&normalized.as_str()) {
                        redact_environment_map(value);
                    } else if SENSITIVE_FIELDS.contains(&normalized.as_str()) {
                        *value = Value::String(REDACTED.to_owned());
                    } else {
                        self.redact_value(value);
                    }
                }
            }
            Value::Array(values) => {
                for value in values {
                    self.redact_value(value);
                }
            }
            Value::String(text) => *text = self.text(text),
            Value::Null | Value::Bool(_) | Value::Number(_) => {}
        }
    }
}

fn redact_environment_map(value: &mut Value) {
    if let Value::Object(variables) = value {
        for value in variables.values_mut() {
            *value = Value::String(REDACTED.to_owned());
        }
    } else {
        *value = Value::String(REDACTED.to_owned());
    }
}
