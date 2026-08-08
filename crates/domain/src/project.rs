use std::path::{Component, Path};

use serde::{Deserialize, Serialize};

use crate::{CoreError, CoreErrorCode, Id};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeType {
    DockerCompose,
    StaticSite,
    NodeJs,
    Go,
    Python,
    Generic,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DeployStrategy {
    InPlace,
    ReleaseSymlink,
    DockerCompose,
    StaticAtomic,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct ProjectRoot(String);

impl ProjectRoot {
    pub fn try_new(value: &str) -> Result<Self, CoreError> {
        let value = value.trim();
        let path = Path::new(value);
        if value.is_empty()
            || value.chars().any(char::is_control)
            || !path.is_absolute()
            || path
                .components()
                .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
        {
            return Err(validation(
                "project root must be a safe absolute remote path",
            ));
        }
        Ok(Self(value.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectInput {
    pub server_id: Id,
    pub name: String,
    pub root_path: ProjectRoot,
    pub repository_url: Option<String>,
    pub runtime: RuntimeType,
    pub deploy_strategy: DeployStrategy,
}

impl ProjectInput {
    pub fn try_new(
        server_id: Id,
        name: &str,
        root_path: &str,
        repository_url: Option<&str>,
        runtime: RuntimeType,
        deploy_strategy: DeployStrategy,
    ) -> Result<Self, CoreError> {
        let name = required(name, "project name")?;
        let repository_url = repository_url.map(validate_repository_url).transpose()?;
        Ok(Self {
            server_id,
            name,
            root_path: ProjectRoot::try_new(root_path)?,
            repository_url,
            runtime,
            deploy_strategy,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectSummary {
    pub id: Id,
    pub server_id: Id,
    pub name: String,
    pub root_path: ProjectRoot,
    pub repository_url: Option<String>,
    pub runtime: RuntimeType,
    pub deploy_strategy: DeployStrategy,
}

fn validate_repository_url(value: &str) -> Result<String, CoreError> {
    let value = required(value, "repository URL")?;
    let valid = value.starts_with("https://")
        || value.starts_with("ssh://")
        || value
            .split_once(':')
            .is_some_and(|(owner, path)| owner.contains('@') && !path.starts_with('/'));
    if !valid || value.chars().any(char::is_whitespace) {
        return Err(validation(
            "repository URL must use HTTPS, SSH, or scp-like Git syntax",
        ));
    }
    Ok(value)
}

fn required(value: &str, field: &str) -> Result<String, CoreError> {
    let value = value.trim();
    if value.is_empty() || value.chars().any(char::is_control) {
        return Err(validation(&format!("{field} is invalid")));
    }
    Ok(value.to_owned())
}

fn validation(message: &str) -> CoreError {
    CoreError::new(CoreErrorCode::Validation, message, false)
}
