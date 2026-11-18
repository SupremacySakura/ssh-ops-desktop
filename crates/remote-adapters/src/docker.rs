use std::collections::HashMap;

use opspilot_domain::{CoreError, CoreErrorCode};
use opspilot_ssh_core::{ConnectionHandle, TerminalCommand};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::{RemoteCommand, RemoteCommandRunner};

const INSPECT_BATCH_SIZE: usize = 100;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct ContainerIdentifier(String);

impl ContainerIdentifier {
    pub fn try_new(value: &str) -> Result<Self, CoreError> {
        let value = value.trim();
        let mut characters = value.chars();
        if value.is_empty()
            || value.len() > 128
            || !characters
                .next()
                .is_some_and(|character| character.is_ascii_alphanumeric())
            || !characters.all(|character| {
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
    pub names: Vec<String>,
    pub image: String,
    pub state: String,
    pub status: String,
    pub ports: Vec<String>,
    pub started_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DockerContainerList {
    pub containers: Vec<DockerContainer>,
    pub started_at_warning: Option<String>,
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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DockerLogs {
    pub container_id: String,
    pub tail: u32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DockerAction {
    Start,
    Stop,
    Restart,
}

const MAX_DOCKER_SHELL_BYTES: usize = 256;
const DOCKER_SHELL_METACHARACTERS: &[char] = &[
    ' ', '\t', '\n', '\r', '"', '\'', '`', '$', ';', '|', '&', '<', '>', '(', ')', '{', '}', '*',
    '?', '\\', '!', '#', '~', '[', ']',
];

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct DockerShell {
    value: String,
}

impl Default for DockerShell {
    fn default() -> Self {
        Self {
            value: "sh".to_owned(),
        }
    }
}

impl DockerShell {
    pub fn try_new(value: &str) -> Result<Self, CoreError> {
        let valid_path = value.starts_with('/')
            && value.len() > 1
            && value[1..].chars().all(is_shell_character)
            && !value[1..]
                .split('/')
                .any(|segment| segment.is_empty() || matches!(segment, "." | ".."));
        let valid_command = matches!(value, "sh" | "bash" | "ash" | "zsh" | "busybox");
        if value.is_empty()
            || value.len() > MAX_DOCKER_SHELL_BYTES
            || value.chars().any(|c| c.is_control())
            || value
                .chars()
                .any(|c| DOCKER_SHELL_METACHARACTERS.contains(&c))
            || (!valid_path && !valid_command)
        {
            return Err(validation(
                "Docker shell must be a simple command name or an absolute path",
            ));
        }
        Ok(Self {
            value: value.to_owned(),
        })
    }

    pub fn as_str(&self) -> &str {
        &self.value
    }
}

impl<'de> Deserialize<'de> for DockerShell {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::try_new(&value).map_err(serde::de::Error::custom)
    }
}

fn is_shell_character(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.' | '/')
}

impl DockerAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Stop => "stop",
            Self::Restart => "restart",
        }
    }
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
    ) -> Result<DockerContainerList, CoreError> {
        let command = RemoteCommand::try_new("docker")?
            .arg("container")?
            .arg("ls")?
            .arg("--all")?
            .arg("--no-trunc")?
            .arg("--format")?
            .arg("{{json .}}")?;
        let output = self.success(connection, command).await?;
        let mut containers = parse_containers(&output.stdout)?;
        let (started_at, started_at_warning) =
            match self.inspect_started_at(connection, &containers).await {
                Ok(started_at) => (started_at, None),
                Err(error) => (HashMap::new(), Some(started_at_warning(&error).to_owned())),
            };
        for container in &mut containers {
            container.started_at = started_at.get(&container.id).cloned().flatten();
        }
        Ok(DockerContainerList {
            containers,
            started_at_warning,
        })
    }

    async fn inspect_started_at(
        &self,
        connection: &ConnectionHandle,
        containers: &[DockerContainer],
    ) -> Result<HashMap<String, Option<String>>, CoreError> {
        if containers.is_empty() {
            return Ok(HashMap::new());
        }
        let mut started_at = HashMap::new();
        for batch in containers.chunks(INSPECT_BATCH_SIZE) {
            let mut command = RemoteCommand::try_new("docker")?
                .arg("container")?
                .arg("inspect")?
                .arg("--format")?
                .arg("{{.Id}}\t{{.State.StartedAt}}")?
                .arg("--")?;
            for container in batch {
                command = command.arg(&container.id)?;
            }
            let output = self.success(connection, command).await?;
            started_at.extend(parse_started_at(&output.stdout)?);
        }
        Ok(started_at)
    }

    pub async fn logs(
        &self,
        connection: &ConnectionHandle,
        container: &ContainerIdentifier,
        tail: u32,
    ) -> Result<DockerLogs, CoreError> {
        if !(1..=1_000).contains(&tail) {
            return Err(validation("Docker log tail must be between 1 and 1000"));
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
        Ok(DockerLogs {
            container_id: container.as_str().to_owned(),
            tail,
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
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
        action: DockerAction,
        container: &ContainerIdentifier,
    ) -> Result<(), CoreError> {
        self.success(
            connection,
            RemoteCommand::try_new("docker")?
                .arg("container")?
                .arg(action.as_str())?
                .arg("--")?
                .arg(container.as_str())?,
        )
        .await?;
        Ok(())
    }

    pub async fn verify_exec(
        &self,
        connection: &ConnectionHandle,
        container: &ContainerIdentifier,
        shell: &DockerShell,
    ) -> Result<(), CoreError> {
        let state = self
            .success(
                connection,
                RemoteCommand::try_new("docker")?
                    .arg("container")?
                    .arg("inspect")?
                    .arg("--format")?
                    .arg("{{.State.Running}}")?
                    .arg("--")?
                    .arg(container.as_str())?,
            )
            .await?;
        if decode(state.stdout, "Docker container state")?.trim() != "true" {
            return Err(CoreError::new(
                CoreErrorCode::Conflict,
                "Docker container is not running",
                false,
            ));
        }

        let shell_probe = format!("command -v {}", shell.as_str());
        let probe = self
            .runner
            .run(
                connection,
                RemoteCommand::try_new("docker")?
                    .arg("exec")?
                    .arg("--")?
                    .arg(container.as_str())?
                    .arg(shell.as_str())?
                    .arg("-c")?
                    .arg(&shell_probe)?,
            )
            .await?;
        if probe.exit_status == 0 {
            return Ok(());
        }
        let stderr = String::from_utf8_lossy(&probe.stderr);
        let normalized = stderr.to_ascii_lowercase();
        if matches!(probe.exit_status, 126 | 127)
            || normalized.contains("executable file not found")
            || normalized.contains("no such file or directory")
        {
            return Err(CoreError::new(
                CoreErrorCode::DockerShellUnavailable,
                format!(
                    "Docker shell '{}' is unavailable in the container",
                    shell.as_str()
                ),
                false,
            ));
        }
        Err(classify_failure(&probe))
    }

    pub fn terminal_command(
        &self,
        container: &ContainerIdentifier,
        shell: &DockerShell,
    ) -> TerminalCommand {
        TerminalCommand::try_new(format!(
            "docker exec -it -- {} {}",
            container.as_str(),
            shell.as_str()
        ))
        .expect("validated Docker identifiers and shells produce a safe terminal command")
    }

    async fn success(
        &self,
        connection: &ConnectionHandle,
        command: RemoteCommand,
    ) -> Result<opspilot_ssh_core::ExecOutput, CoreError> {
        let output = self.runner.run(connection, command).await?;
        if output.exit_status != 0 {
            return Err(classify_failure(&output));
        }
        Ok(output)
    }
}

fn classify_failure(output: &opspilot_ssh_core::ExecOutput) -> CoreError {
    let stderr = decode(output.stderr.clone(), "Docker error output")
        .unwrap_or_else(|_| "unreadable error output".to_owned());
    let normalized = stderr.to_ascii_lowercase();
    let (code, retryable) = if (normalized.contains("permission denied")
        || normalized.contains("operation not permitted")
        || normalized.contains("access denied"))
        && (normalized.contains("docker.sock")
            || normalized.contains("docker daemon")
            || normalized.contains("unix://"))
    {
        (CoreErrorCode::DockerPermissionDenied, false)
    } else if [
        "cannot connect to the docker daemon",
        "failed to connect to the docker daemon",
        "is the docker daemon running",
        "docker daemon is unavailable",
        "error during connect",
    ]
    .iter()
    .any(|message| normalized.contains(message))
        || (normalized.contains("connection refused") && normalized.contains("docker"))
    {
        (CoreErrorCode::DockerDaemonUnavailable, true)
    } else if normalized.contains("no such container") || normalized.contains("no such object") {
        (CoreErrorCode::DockerContainerNotFound, false)
    } else if matches!(output.exit_status, 126 | 127) {
        (CoreErrorCode::DockerNotInstalled, false)
    } else {
        (CoreErrorCode::RemoteCommand, false)
    };
    CoreError::new(
        code,
        format!(
            "Docker CLI exited with status {}: {}",
            output.exit_status,
            stderr.trim()
        ),
        retryable,
    )
}

fn started_at_warning(error: &CoreError) -> &'static str {
    match error.code() {
        CoreErrorCode::DockerNotInstalled => "服务器未安装 Docker CLI，无法读取容器启动时间",
        CoreErrorCode::DockerPermissionDenied => "当前用户无权读取容器详情，无法获取启动时间",
        CoreErrorCode::DockerDaemonUnavailable => "Docker daemon 不可用，无法读取容器启动时间",
        CoreErrorCode::DockerContainerNotFound => "部分容器已不存在，无法读取启动时间",
        CoreErrorCode::Timeout => "读取容器启动时间超时",
        CoreErrorCode::SshConnection => "SSH 连接已断开，无法读取容器启动时间",
        _ => "Docker 返回内容无法解析，无法读取容器启动时间",
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
            let id = required(&value, "ID")?;
            let id = ContainerIdentifier::try_new(&id)
                .map_err(|_| parse_error("Docker container ID is invalid"))?;
            Ok(DockerContainer {
                id: id.as_str().to_owned(),
                names: list_field(&value, "Names")?,
                image: required(&value, "Image")?,
                state: required(&value, "State")?,
                status: required(&value, "Status")?,
                ports: split_field(&value, "Ports"),
                started_at: None,
            })
        })
        .collect()
}

pub fn parse_started_at(source: &[u8]) -> Result<HashMap<String, Option<String>>, CoreError> {
    decode(source.to_vec(), "Docker container inspect")?
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let (id, started_at) = line
                .split_once('\t')
                .ok_or_else(|| parse_error("Docker container inspect line is invalid"))?;
            let id = id.trim();
            if id.is_empty() {
                return Err(parse_error("Docker container inspect ID is missing"));
            }
            let started_at = started_at.trim();
            let started_at = if started_at.is_empty() || started_at == "0001-01-01T00:00:00Z" {
                None
            } else {
                Some(started_at.to_owned())
            };
            Ok((id.to_owned(), started_at))
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

fn split_field(value: &Value, field: &str) -> Vec<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn list_field(value: &Value, field: &str) -> Result<Vec<String>, CoreError> {
    let list = split_field(value, field);
    if list.is_empty() {
        return Err(parse_error("Docker JSON is missing a required field"));
    }
    Ok(list)
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
