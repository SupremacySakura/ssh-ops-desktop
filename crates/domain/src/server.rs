use serde::{Deserialize, Serialize};

use crate::{CoreError, CoreErrorCode, Id};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthType {
    Password,
    Key,
}

impl AuthType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Password => "password",
            Self::Key => "key",
        }
    }

    pub fn from_persisted(value: &str) -> Result<Self, CoreError> {
        match value {
            "password" => Ok(Self::Password),
            "key" => Ok(Self::Key),
            _ => Err(validation_error("persisted server auth type is invalid")),
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
        if value.contains("://")
            || value
                .chars()
                .any(|character| character.is_ascii_whitespace())
        {
            return Err(validation_error(
                "host must be a hostname without a URL scheme or whitespace",
            ));
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
    user: String,
    auth_type: AuthType,
    secret_ref: String,
    group_id: Option<Id>,
    favorite: bool,
}

impl ServerInput {
    #[allow(clippy::too_many_arguments)]
    pub fn try_new(
        name: &str,
        host: &str,
        port: u32,
        user: &str,
        auth_type: AuthType,
        secret_ref: &str,
        group_id: Option<Id>,
        favorite: bool,
    ) -> Result<Self, CoreError> {
        Ok(Self {
            name: normalized_required(name, "server name")?,
            host: Host::try_from(host)?,
            port: ServerPort::try_from(port)?,
            user: normalized_identity(user, "user")?,
            auth_type,
            secret_ref: normalized_required(secret_ref, "secret reference")?,
            group_id,
            favorite,
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

    pub fn user(&self) -> &str {
        &self.user
    }

    pub fn auth_type(&self) -> AuthType {
        self.auth_type
    }

    pub fn secret_ref(&self) -> &str {
        &self.secret_ref
    }

    pub fn group_id(&self) -> Option<Id> {
        self.group_id
    }

    pub fn favorite(&self) -> bool {
        self.favorite
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Server {
    pub id: Id,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth_type: AuthType,
    pub secret_ref: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<Id>,
    pub favorite: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_connected_at: Option<i64>,
    pub created_at: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServerGroup {
    pub id: Id,
    pub name: String,
    pub sort_order: i64,
}

impl ServerGroup {
    pub fn try_new(name: &str, sort_order: i64) -> Result<Self, CoreError> {
        Ok(Self {
            id: Id::new(),
            name: normalized_required(name, "group name")?,
            sort_order,
        })
    }
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

fn normalized_identity(value: &str, field: &str) -> Result<String, CoreError> {
    let value = normalized_required(value, field)?;
    if value.chars().any(char::is_whitespace) {
        return Err(validation_error(format!(
            "{field} must not contain whitespace"
        )));
    }
    Ok(value)
}

fn validation_error(message: impl Into<String>) -> CoreError {
    CoreError::new(CoreErrorCode::Validation, message, false)
}
