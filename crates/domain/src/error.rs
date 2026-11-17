use std::fmt;

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CoreErrorCode {
    Validation,
    NotFound,
    Conflict,
    Cancelled,
    Timeout,
    CapabilityUnavailable,
    SecretUnavailable,
    SshConnection,
    SshAuthentication,
    SshHostKeyUnknown,
    SshHostKeyChanged,
    RemotePermission,
    RemoteCommand,
    RemoteParse,
    Internal,
}

impl fmt::Display for CoreErrorCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let code = match self {
            Self::Validation => "VALIDATION",
            Self::NotFound => "NOT_FOUND",
            Self::Conflict => "CONFLICT",
            Self::Cancelled => "CANCELLED",
            Self::Timeout => "TIMEOUT",
            Self::CapabilityUnavailable => "CAPABILITY_UNAVAILABLE",
            Self::SecretUnavailable => "SECRET_UNAVAILABLE",
            Self::SshConnection => "SSH_CONNECTION",
            Self::SshAuthentication => "SSH_AUTHENTICATION",
            Self::SshHostKeyUnknown => "SSH_HOST_KEY_UNKNOWN",
            Self::SshHostKeyChanged => "SSH_HOST_KEY_CHANGED",
            Self::RemotePermission => "REMOTE_PERMISSION",
            Self::RemoteCommand => "REMOTE_COMMAND",
            Self::RemoteParse => "REMOTE_PARSE",
            Self::Internal => "INTERNAL",
        };

        formatter.write_str(code)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, Error, PartialEq, Serialize)]
#[error("{code}: {message}")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoreError {
    code: CoreErrorCode,
    #[serde(
        deserialize_with = "crate::validation::deserialize_non_empty_string",
        serialize_with = "crate::validation::serialize_non_empty_string"
    )]
    message: String,
    retryable: bool,
}

impl CoreError {
    pub fn new(code: CoreErrorCode, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code,
            message: message.into(),
            retryable,
        }
    }

    pub fn code(&self) -> CoreErrorCode {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub fn is_retryable(&self) -> bool {
        self.retryable
    }
}
