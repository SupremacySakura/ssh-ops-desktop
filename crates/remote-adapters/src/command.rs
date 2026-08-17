use std::time::Duration;

use opspilot_domain::{CoreError, CoreErrorCode};
use opspilot_secrets::SecretStore;
use opspilot_ssh_core::{ConnectionHandle, ExecOutput, RusshConnectionManager};

const MAX_STDIN_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValidatedProgram(String);

impl ValidatedProgram {
    pub fn try_new(value: &str) -> Result<Self, CoreError> {
        let value = validate_text(value, "remote program")?;
        // 远端路径是 POSIX 语义，按 '/' 分段检查，避免宿主平台 Path 的差异（Windows 的 UNC/Prefix）。
        if !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '/' | '+' | '-')
        }) || value.split('/').any(|segment| segment == "..")
        {
            return Err(validation("remote program contains unsupported characters"));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RemoteCommand {
    program: ValidatedProgram,
    args: Vec<String>,
    cwd: Option<String>,
    timeout: Duration,
    stdin: Option<Vec<u8>>,
}

impl RemoteCommand {
    pub fn try_new(program: &str) -> Result<Self, CoreError> {
        Ok(Self {
            program: ValidatedProgram::try_new(program)?,
            args: Vec::new(),
            cwd: None,
            timeout: Duration::from_secs(30),
            stdin: None,
        })
    }

    pub fn arg(mut self, value: &str) -> Result<Self, CoreError> {
        if value.contains('\0') || value.len() > 64 * 1024 {
            return Err(validation("remote command argument is invalid"));
        }
        self.args.push(value.to_owned());
        Ok(self)
    }

    pub fn cwd(mut self, value: &str) -> Result<Self, CoreError> {
        let value = validate_text(value, "remote working directory")?;
        // 远端路径是 POSIX 语义：不能用宿主平台 Path 校验（Windows 上 "/srv/app" 不是绝对路径）。
        if !value.starts_with('/') || value.split('/').any(|segment| segment == "..") {
            return Err(validation(
                "remote working directory must be a safe absolute path",
            ));
        }
        self.cwd = Some(value);
        Ok(self)
    }

    pub fn timeout_ms(mut self, value: u64) -> Result<Self, CoreError> {
        if !(100..=3_600_000).contains(&value) {
            return Err(validation(
                "remote command timeout must be between 100 ms and 1 hour",
            ));
        }
        self.timeout = Duration::from_millis(value);
        Ok(self)
    }

    pub fn stdin(mut self, value: Vec<u8>) -> Result<Self, CoreError> {
        if value.len() > MAX_STDIN_BYTES {
            return Err(validation("remote command stdin exceeds the 1 MiB limit"));
        }
        self.stdin = Some(value);
        Ok(self)
    }

    pub fn timeout(&self) -> Duration {
        self.timeout
    }

    pub fn stdin_bytes(&self) -> Option<&[u8]> {
        self.stdin.as_deref()
    }

    pub fn render_posix(&self) -> String {
        let command = std::iter::once(self.program.as_str())
            .chain(self.args.iter().map(String::as_str))
            .map(quote_posix)
            .collect::<Vec<_>>()
            .join(" ");
        match &self.cwd {
            Some(cwd) => format!("cd -- {} && {command}", quote_posix(cwd)),
            None => command,
        }
    }
}

fn quote_posix(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn validate_text(value: &str, field: &str) -> Result<String, CoreError> {
    let value = value.trim();
    if value.is_empty() || value.contains('\0') || value.chars().any(char::is_control) {
        return Err(validation(&format!("{field} is invalid")));
    }
    Ok(value.to_owned())
}

fn validation(message: &str) -> CoreError {
    CoreError::new(CoreErrorCode::Validation, message, false)
}

pub struct RemoteExecutor<S> {
    connections: RusshConnectionManager<S>,
}

impl<S> Clone for RemoteExecutor<S> {
    fn clone(&self) -> Self {
        Self {
            connections: self.connections.clone(),
        }
    }
}

impl<S> RemoteExecutor<S>
where
    S: SecretStore + 'static,
{
    pub fn new(connections: RusshConnectionManager<S>) -> Self {
        Self { connections }
    }

    pub async fn execute(
        &self,
        connection: &ConnectionHandle,
        command: RemoteCommand,
    ) -> Result<ExecOutput, CoreError> {
        let rendered = command.render_posix();
        self.connections
            .execute_posix(connection, rendered, command.stdin, command.timeout)
            .await
    }
}

#[async_trait::async_trait]
pub trait RemoteCommandRunner: Clone + Send + Sync + 'static {
    async fn run(
        &self,
        connection: &ConnectionHandle,
        command: RemoteCommand,
    ) -> Result<ExecOutput, CoreError>;
}

#[async_trait::async_trait]
impl<S> RemoteCommandRunner for RemoteExecutor<S>
where
    S: SecretStore + 'static,
{
    async fn run(
        &self,
        connection: &ConnectionHandle,
        command: RemoteCommand,
    ) -> Result<ExecOutput, CoreError> {
        self.execute(connection, command).await
    }
}
