use opspilot_domain::{CoreError, CoreErrorCode, Id};
use opspilot_ssh_core::ConnectionHandle;
use serde::{Deserialize, Serialize};

use crate::{RemoteCommand, RemoteCommandRunner};

const MAX_CANDIDATE_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct NginxPath(String);

impl NginxPath {
    pub fn try_new(value: &str) -> Result<Self, CoreError> {
        let value = value.trim();
        // 远端路径是 POSIX 语义：不能用宿主平台 Path 校验（Windows 上 "/etc/nginx" 不是绝对路径）。
        if value.is_empty()
            || value.len() > 4096
            || value.chars().any(char::is_control)
            || !value.starts_with('/')
            || value.split('/').any(|segment| segment == "..")
        {
            return Err(validation("Nginx path must be a safe absolute path"));
        }
        Ok(Self(value.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NginxApplyPlan {
    pub operation_id: Id,
    pub live_path: NginxPath,
    pub main_config_path: NginxPath,
    pub candidate: Vec<u8>,
    pub health_url: Option<String>,
}

impl NginxApplyPlan {
    pub fn try_new(
        operation_id: Id,
        live_path: &str,
        main_config_path: &str,
        candidate: Vec<u8>,
        health_url: Option<&str>,
    ) -> Result<Self, CoreError> {
        if candidate.is_empty() || candidate.len() > MAX_CANDIDATE_BYTES || candidate.contains(&0) {
            return Err(validation(
                "Nginx candidate must contain 1 byte to 1 MiB and no NUL",
            ));
        }
        Ok(Self {
            operation_id,
            live_path: NginxPath::try_new(live_path)?,
            main_config_path: NginxPath::try_new(main_config_path)?,
            candidate,
            health_url: health_url.map(validate_health_url).transpose()?,
        })
    }

    pub fn backup_path(&self) -> String {
        sibling_path(
            self.live_path.as_str(),
            &format!(".opspilot-{}.bak", self.operation_id),
        )
    }

    pub fn temporary_path(&self) -> String {
        sibling_path(
            self.live_path.as_str(),
            &format!(".opspilot-{}.tmp", self.operation_id),
        )
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NginxApplyResult {
    pub backup_path: String,
    pub live_path: String,
    pub rolled_back: bool,
}

#[derive(Clone)]
pub struct NginxAdapter<R> {
    runner: R,
}

impl<R> NginxAdapter<R>
where
    R: RemoteCommandRunner,
{
    pub fn new(runner: R) -> Self {
        Self { runner }
    }

    pub async fn read(
        &self,
        connection: &ConnectionHandle,
        path: &NginxPath,
    ) -> Result<Vec<u8>, CoreError> {
        let output = self
            .run(
                connection,
                RemoteCommand::try_new("cat")?
                    .arg("--")?
                    .arg(path.as_str())?,
            )
            .await?;
        success(output, "read Nginx configuration").map(|output| output.stdout)
    }

    pub async fn discover(&self, connection: &ConnectionHandle) -> Result<String, CoreError> {
        let output = self
            .run(connection, RemoteCommand::try_new("nginx")?.arg("-V")?)
            .await?;
        if output.exit_status != 0 {
            return Err(remote_status("discover Nginx", output.exit_status));
        }
        let mut bytes = output.stdout;
        bytes.extend(output.stderr);
        String::from_utf8(bytes).map_err(|_| parse_error("Nginx version output is not UTF-8"))
    }

    pub async fn apply(
        &self,
        connection: &ConnectionHandle,
        plan: &NginxApplyPlan,
    ) -> Result<NginxApplyResult, CoreError> {
        let backup = plan.backup_path();
        let temporary = plan.temporary_path();
        self.run_success(
            connection,
            copy_preserving(plan.live_path.as_str(), &backup)?,
        )
        .await?;
        self.run_success(
            connection,
            copy_preserving(plan.live_path.as_str(), &temporary)?,
        )
        .await?;
        self.run_success(
            connection,
            RemoteCommand::try_new("tee")?
                .arg("--")?
                .arg(&temporary)?
                .stdin(plan.candidate.clone())?,
        )
        .await?;

        let validation = self
            .run(
                connection,
                RemoteCommand::try_new("nginx")?
                    .arg("-t")?
                    .arg("-c")?
                    .arg(plan.main_config_path.as_str())?,
            )
            .await?;
        if validation.exit_status != 0 {
            let _ = self
                .run(
                    connection,
                    RemoteCommand::try_new("unlink")?
                        .arg("--")?
                        .arg(&temporary)?,
                )
                .await;
            return Err(remote_status(
                "validate Nginx candidate",
                validation.exit_status,
            ));
        }

        self.run_success(
            connection,
            RemoteCommand::try_new("mv")?
                .arg("-f")?
                .arg("--")?
                .arg(&temporary)?
                .arg(plan.live_path.as_str())?,
        )
        .await?;
        let reload = self.run(connection, reload_command()?).await?;
        if reload.exit_status != 0 {
            self.restore(connection, plan, &backup).await?;
            return Err(CoreError::new(
                CoreErrorCode::RemoteCommand,
                "Nginx reload failed; the previous configuration was restored",
                false,
            ));
        }
        if let Some(url) = &plan.health_url {
            let health = self.run(connection, health_command(url)?).await?;
            if health.exit_status != 0 {
                self.restore(connection, plan, &backup).await?;
                return Err(CoreError::new(
                    CoreErrorCode::RemoteCommand,
                    "Nginx health check failed; the previous configuration was restored",
                    false,
                ));
            }
        }
        Ok(NginxApplyResult {
            backup_path: backup,
            live_path: plan.live_path.as_str().to_owned(),
            rolled_back: false,
        })
    }

    async fn restore(
        &self,
        connection: &ConnectionHandle,
        plan: &NginxApplyPlan,
        backup: &str,
    ) -> Result<(), CoreError> {
        let rollback = sibling_path(
            plan.live_path.as_str(),
            &format!(".opspilot-{}-rollback.tmp", plan.operation_id),
        );
        self.run_success(connection, copy_preserving(backup, &rollback)?)
            .await?;
        self.run_success(
            connection,
            RemoteCommand::try_new("mv")?
                .arg("-f")?
                .arg("--")?
                .arg(&rollback)?
                .arg(plan.live_path.as_str())?,
        )
        .await?;
        self.run_success(connection, reload_command()?).await?;
        Ok(())
    }

    async fn run(
        &self,
        connection: &ConnectionHandle,
        command: RemoteCommand,
    ) -> Result<opspilot_ssh_core::ExecOutput, CoreError> {
        self.runner.run(connection, command).await
    }

    async fn run_success(
        &self,
        connection: &ConnectionHandle,
        command: RemoteCommand,
    ) -> Result<opspilot_ssh_core::ExecOutput, CoreError> {
        success(
            self.run(connection, command).await?,
            "execute Nginx change step",
        )
    }
}

fn copy_preserving(source: &str, target: &str) -> Result<RemoteCommand, CoreError> {
    RemoteCommand::try_new("cp")?
        .arg("-p")?
        .arg("--")?
        .arg(source)?
        .arg(target)
}

fn reload_command() -> Result<RemoteCommand, CoreError> {
    RemoteCommand::try_new("nginx")?.arg("-s")?.arg("reload")
}

fn health_command(url: &str) -> Result<RemoteCommand, CoreError> {
    RemoteCommand::try_new("curl")?
        .arg("--fail")?
        .arg("--silent")?
        .arg("--show-error")?
        .arg("--max-time")?
        .arg("10")?
        .arg("--")?
        .arg(url)
}

fn validate_health_url(value: &str) -> Result<String, CoreError> {
    let value = value.trim();
    let rest = value
        .strip_prefix("http://")
        .or_else(|| value.strip_prefix("https://"));
    if value.len() > 2048
        || value.chars().any(char::is_whitespace)
        || value.chars().any(char::is_control)
        || rest.is_none_or(|rest| rest.is_empty() || rest.starts_with('/') || rest.contains('@'))
    {
        return Err(validation(
            "health URL must be an HTTP(S) URL without credentials",
        ));
    }
    Ok(value.to_owned())
}

fn sibling_path(live: &str, name: &str) -> String {
    // 远端路径是 POSIX 语义，用字符串取父目录，避免宿主平台 Path 在 Windows 上输出反斜杠。
    let parent = live
        .rsplit_once('/')
        .map(|(parent, _)| parent)
        .unwrap_or("/");
    if parent.is_empty() {
        format!("/{name}")
    } else {
        format!("{parent}/{name}")
    }
}

fn success(
    output: opspilot_ssh_core::ExecOutput,
    action: &str,
) -> Result<opspilot_ssh_core::ExecOutput, CoreError> {
    if output.exit_status == 0 {
        Ok(output)
    } else {
        Err(remote_status(action, output.exit_status))
    }
}

fn remote_status(action: &str, status: u32) -> CoreError {
    CoreError::new(
        CoreErrorCode::RemoteCommand,
        format!("failed to {action}: exit status {status}"),
        false,
    )
}

fn validation(message: &str) -> CoreError {
    CoreError::new(CoreErrorCode::Validation, message, false)
}
fn parse_error(message: &str) -> CoreError {
    CoreError::new(CoreErrorCode::RemoteParse, message, false)
}
