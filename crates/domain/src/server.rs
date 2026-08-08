use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::{CoreError, CoreErrorCode, Id};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthType {
    Password,
    PrivateKey,
    SshAgent,
    Certificate,
}

impl AuthType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Password => "password",
            Self::PrivateKey => "private_key",
            Self::SshAgent => "ssh_agent",
            Self::Certificate => "certificate",
        }
    }

    pub fn from_persisted(value: &str) -> Result<Self, CoreError> {
        match value {
            "password" => Ok(Self::Password),
            "private_key" => Ok(Self::PrivateKey),
            "ssh_agent" => Ok(Self::SshAgent),
            "certificate" => Ok(Self::Certificate),
            _ => Err(validation_error("persisted server auth type is invalid")),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ServerEnvironment {
    Development,
    Staging,
    Production,
    Other,
}

impl ServerEnvironment {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Development => "development",
            Self::Staging => "staging",
            Self::Production => "production",
            Self::Other => "other",
        }
    }

    pub fn from_persisted(value: &str) -> Result<Self, CoreError> {
        match value {
            "development" => Ok(Self::Development),
            "staging" => Ok(Self::Staging),
            "production" => Ok(Self::Production),
            "other" => Ok(Self::Other),
            _ => Err(validation_error("persisted server environment is invalid")),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct Host(String);

impl Host {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<&str> for Host {
    type Error = CoreError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        let value = normalized_required(value, "host")?.to_lowercase();
        if value.contains("://") {
            return Err(validation_error("host must not include a URL scheme"));
        }

        Ok(Self(value))
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct ServerPort(u16);

impl ServerPort {
    pub fn get(self) -> u16 {
        self.0
    }
}

impl TryFrom<u32> for ServerPort {
    type Error = CoreError;

    fn try_from(value: u32) -> Result<Self, Self::Error> {
        let port = u16::try_from(value)
            .ok()
            .filter(|port| *port > 0)
            .ok_or_else(|| validation_error("server port must be between 1 and 65535"))?;

        Ok(Self(port))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServerInput {
    name: String,
    host: Host,
    port: ServerPort,
    username: String,
    environment: ServerEnvironment,
    auth_type: AuthType,
    group_id: Option<Id>,
    tag_ids: Vec<Id>,
}

impl ServerInput {
    #[allow(clippy::too_many_arguments)]
    pub fn try_new(
        name: &str,
        host: &str,
        port: u32,
        username: &str,
        environment: ServerEnvironment,
        auth_type: AuthType,
        group_id: Option<Id>,
        tag_ids: Vec<Id>,
    ) -> Result<Self, CoreError> {
        let unique_tag_ids = tag_ids.iter().copied().collect::<HashSet<_>>();
        if unique_tag_ids.len() != tag_ids.len() {
            return Err(validation_error("tag IDs must not contain duplicates"));
        }

        Ok(Self {
            name: normalized_required(name, "server name")?,
            host: Host::try_from(host)?,
            port: ServerPort::try_from(port)?,
            username: normalized_required(username, "username")?,
            environment,
            auth_type,
            group_id,
            tag_ids,
        })
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn host(&self) -> &Host {
        &self.host
    }

    pub fn port(&self) -> ServerPort {
        self.port
    }

    pub fn username(&self) -> &str {
        &self.username
    }

    pub fn environment(&self) -> ServerEnvironment {
        self.environment
    }

    pub fn auth_type(&self) -> AuthType {
        self.auth_type
    }

    pub fn group_id(&self) -> Option<Id> {
        self.group_id
    }

    pub fn tag_ids(&self) -> &[Id] {
        &self.tag_ids
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServerSummary {
    pub id: Id,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub environment: ServerEnvironment,
    pub auth_type: AuthType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<Id>,
    pub tag_ids: Vec<Id>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_connected_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServerGroup {
    pub id: Id,
    pub name: String,
    pub sort_order: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServerTag {
    pub id: Id,
    pub name: String,
}

fn normalized_required(value: &str, field: &str) -> Result<String, CoreError> {
    let value = value.trim();
    if value.is_empty() || value.chars().any(char::is_control) {
        return Err(validation_error(format!(
            "{field} must be non-empty and contain no control characters"
        )));
    }

    Ok(value.to_owned())
}

fn validation_error(message: impl Into<String>) -> CoreError {
    CoreError::new(CoreErrorCode::Validation, message, false)
}

#[cfg(test)]
mod tests {
    use super::{AuthType, ServerEnvironment, ServerInput};
    use crate::{CoreErrorCode, Id};

    #[test]
    fn server_input_rejects_duplicate_tag_ids() {
        let tag_id = Id::new();

        let error = ServerInput::try_new(
            "Duplicate tags",
            "duplicate-tags.example.com",
            22,
            "deploy",
            ServerEnvironment::Production,
            AuthType::SshAgent,
            None,
            vec![tag_id, tag_id],
        )
        .expect_err("duplicate tag IDs must be rejected at the domain boundary");

        assert_eq!(error.code(), CoreErrorCode::Validation);
        assert!(
            error
                .message()
                .contains("tag IDs must not contain duplicates")
        );
    }
}
