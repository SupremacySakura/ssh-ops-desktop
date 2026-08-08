use opspilot_domain::{CoreError, CoreErrorCode};
use opspilot_ssh_core::ConnectionHandle;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{RemoteCommand, RemoteCommandRunner};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct ContainerIdentifier(String);

impl ContainerIdentifier {
    pub fn try_new(value: &str) -> Result<Self, CoreError> {
        let value = value.trim();
        if value.is_empty()
            || value.len() > 128
            || value.starts_with('-')
            || value.chars().any(char::is_control)
            || !value.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '-')
            })
        {
            return Err(validation("Docker container identifier is invalid"));
        }
        Ok(Self(value.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DockerVersion {
    pub version: String,
    pub api_version: String,
    pub os: String,
    pub arch: String,
    pub transport: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DockerContainer {
    pub id: String,
    pub names: String,
    pub image: String,
    pub state: String,
    pub status: String,
    pub ports: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DockerStats {
    pub container_id: String,
    pub name: String,
    pub cpu_percent: String,
    pub memory_usage: String,
    pub memory_percent: String,
    pub network_io: String,
    pub block_io: String,
}

#[derive(Clone)]
pub struct DockerCliAdapter<R> {
    runner: R,
}

impl<R> DockerCliAdapter<R>
where
    R: RemoteCommandRunner,
{
    pub fn new(runner: R) -> Self {
        Self { runner }
    }

    pub async fn version(&self, connection: &ConnectionHandle) -> Result<DockerVersion, CoreError> {
        let output = self
            .success(
                connection,
                RemoteCommand::try_new("docker")?
                    .arg("version")?
                    .arg("--format")?
                    .arg("{{json .Server}}")?,
            )
            .await?;
        parse_version(&output.stdout)
    }

    pub async fn list_containers(
        &self,
        connection: &ConnectionHandle,
        include_stopped: bool,
    ) -> Result<Vec<DockerContainer>, CoreError> {
        let mut command = RemoteCommand::try_new("docker")?
            .arg("container")?
            .arg("ls")?;
        if include_stopped {
            command = command.arg("--all")?;
        }
        command = command
            .arg("--no-trunc")?
            .arg("--format")?
            .arg("{{json .}}")?;
        let output = self.success(connection, command).await?;
        parse_containers(&output.stdout)
    }

    pub async fn logs(
        &self,
        connection: &ConnectionHandle,
        container: &ContainerIdentifier,
        tail: u32,
    ) -> Result<String, CoreError> {
        if !(1..=100_000).contains(&tail) {
            return Err(validation("Docker log tail must be between 1 and 100000"));
        }
        let output = self
            .success(
                connection,
                RemoteCommand::try_new("docker")?
                    .arg("logs")?
                    .arg("--timestamps")?
                    .arg("--tail")?
                    .arg(&tail.to_string())?
                    .arg("--")?
                    .arg(container.as_str())?,
            )
            .await?;
        decode(output.stdout, "Docker logs")
    }

    pub async fn stats(
        &self,
        connection: &ConnectionHandle,
        container: &ContainerIdentifier,
    ) -> Result<DockerStats, CoreError> {
        let output = self
            .success(
                connection,
                RemoteCommand::try_new("docker")?
                    .arg("stats")?
                    .arg("--no-stream")?
                    .arg("--format")?
                    .arg("{{json .}}")?
                    .arg("--")?
                    .arg(container.as_str())?,
            )
            .await?;
        parse_stats(&output.stdout)
    }

    pub async fn container_action(
        &self,
        connection: &ConnectionHandle,
        action: &str,
        container: &ContainerIdentifier,
    ) -> Result<(), CoreError> {
        if !matches!(action, "start" | "stop" | "restart" | "rm") {
            return Err(validation("unsupported Docker container action"));
        }
        self.success(
            connection,
            RemoteCommand::try_new("docker")?
                .arg("container")?
                .arg(action)?
                .arg("--")?
                .arg(container.as_str())?,
        )
        .await?;
        Ok(())
    }

    async fn success(
        &self,
        connection: &ConnectionHandle,
        command: RemoteCommand,
    ) -> Result<opspilot_ssh_core::ExecOutput, CoreError> {
        let output = self.runner.run(connection, command).await?;
        if output.exit_status != 0 {
            let stderr = decode(output.stderr, "Docker error output")
                .unwrap_or_else(|_| "unreadable error output".to_owned());
            return Err(CoreError::new(
                CoreErrorCode::RemoteCommand,
                format!(
                    "Docker CLI exited with status {}: {}",
                    output.exit_status,
                    stderr.trim()
                ),
                false,
            ));
        }
        Ok(output)
    }
}

pub fn parse_version(source: &[u8]) -> Result<DockerVersion, CoreError> {
    let value: Value = serde_json::from_slice(source)
        .map_err(|_| parse_error("Docker version JSON is invalid"))?;
    Ok(DockerVersion {
        version: required(&value, "Version")?,
        api_version: required(&value, "ApiVersion")?,
        os: required(&value, "Os")?,
        arch: required(&value, "Arch")?,
        transport: "cli".to_owned(),
    })
}

pub fn parse_containers(source: &[u8]) -> Result<Vec<DockerContainer>, CoreError> {
    decode(source.to_vec(), "Docker container list")?
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let value: Value = serde_json::from_str(line)
                .map_err(|_| parse_error("Docker container JSON line is invalid"))?;
            Ok(DockerContainer {
                id: required(&value, "ID")?,
                names: required(&value, "Names")?,
                image: required(&value, "Image")?,
                state: required(&value, "State")?,
                status: required(&value, "Status")?,
                ports: optional(&value, "Ports"),
            })
        })
        .collect()
}

pub fn parse_stats(source: &[u8]) -> Result<DockerStats, CoreError> {
    let value: Value =
        serde_json::from_slice(source).map_err(|_| parse_error("Docker stats JSON is invalid"))?;
    Ok(DockerStats {
        container_id: required(&value, "ID")?,
        name: required(&value, "Name")?,
        cpu_percent: required(&value, "CPUPerc")?,
        memory_usage: required(&value, "MemUsage")?,
        memory_percent: required(&value, "MemPerc")?,
        network_io: required(&value, "NetIO")?,
        block_io: required(&value, "BlockIO")?,
    })
}

fn required(value: &Value, field: &str) -> Result<String, CoreError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| parse_error("Docker JSON is missing a required field"))
}

fn optional(value: &Value, field: &str) -> String {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn decode(bytes: Vec<u8>, label: &str) -> Result<String, CoreError> {
    String::from_utf8(bytes).map_err(|_| parse_error(&format!("{label} is not UTF-8")))
}

fn validation(message: &str) -> CoreError {
    CoreError::new(CoreErrorCode::Validation, message, false)
}

fn parse_error(message: &str) -> CoreError {
    CoreError::new(CoreErrorCode::RemoteParse, message, false)
}
