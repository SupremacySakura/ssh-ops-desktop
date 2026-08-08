use std::path::Path;

use opspilot_domain::{CoreError, CoreErrorCode, DeployStrategy, Id, ProjectSummary, RuntimeType};
use opspilot_ssh_core::{ConnectionHandle, ExecOutput};
use serde::{Deserialize, Serialize};

use crate::{RemoteCommand, RemoteCommandRunner};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct GitRevision(String);

impl GitRevision {
    pub fn try_new(value: &str) -> Result<Self, CoreError> {
        let value = value.trim();
        if value.is_empty()
            || value.len() > 256
            || value.starts_with('-')
            || value.chars().any(char::is_control)
            || !value.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '/' | '-')
            })
            || value
                .split('/')
                .any(|segment| segment.is_empty() || segment == "..")
        {
            return Err(validation("Git revision is invalid"));
        }
        Ok(Self(value.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeploymentPlan {
    pub project_id: Id,
    pub release_id: Id,
    pub revision: GitRevision,
    pub release_path: String,
    pub current_path: String,
    pub commands: Vec<String>,
    pub health_url: Option<String>,
    pub impact_summary: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeploymentResult {
    pub release_path: String,
    pub previous_target: Option<String>,
    pub rolled_back: bool,
}

#[derive(Clone)]
pub struct ReleaseDeployer<R> {
    runner: R,
}

impl<R> ReleaseDeployer<R>
where
    R: RemoteCommandRunner,
{
    pub fn new(runner: R) -> Self {
        Self { runner }
    }

    pub fn plan(
        &self,
        project: &ProjectSummary,
        release_id: Id,
        revision: GitRevision,
        health_url: Option<&str>,
    ) -> Result<DeploymentPlan, CoreError> {
        if project.deploy_strategy == DeployStrategy::DockerCompose {
            return compose_plan(project, release_id, revision, health_url);
        }
        if project.deploy_strategy != DeployStrategy::ReleaseSymlink {
            return Err(CoreError::new(
                CoreErrorCode::CapabilityUnavailable,
                "the project is not configured for release-symlink deployment",
                false,
            ));
        }
        let repository = project
            .repository_url
            .as_deref()
            .ok_or_else(|| validation("release-symlink deployment requires a repository URL"))?;
        let root = project.root_path.as_str().trim_end_matches('/');
        let releases_path = format!("{root}/releases");
        let release_path = format!("{releases_path}/{release_id}");
        let current_path = format!("{root}/current");
        let temporary_link = format!("{root}/.opspilot-current-{release_id}.tmp");
        let health_url = health_url.map(validate_health_url).transpose()?;
        let mut commands = vec![
            RemoteCommand::try_new("mkdir")?
                .arg("-p")?
                .arg(&releases_path)?,
            RemoteCommand::try_new("git")?
                .arg("clone")?
                .arg("--depth")?
                .arg("1")?
                .arg("--branch")?
                .arg(revision.as_str())?
                .arg("--")?
                .arg(repository)?
                .arg(&release_path)?,
        ];
        commands.extend(build_commands(project.runtime, &release_path)?);
        commands.extend([
            RemoteCommand::try_new("ln")?
                .arg("-sfn")?
                .arg(&release_path)?
                .arg(&temporary_link)?,
            RemoteCommand::try_new("mv")?
                .arg("-Tf")?
                .arg(&temporary_link)?
                .arg(&current_path)?,
        ]);
        if let Some(url) = &health_url {
            commands.push(health_command(url)?);
        }
        Ok(DeploymentPlan {
            project_id: project.id,
            release_id,
            revision,
            release_path,
            current_path,
            commands: commands.iter().map(RemoteCommand::render_posix).collect(),
            health_url,
            impact_summary: "materialize a new release, atomically switch current, and restore it if health fails".to_owned(),
        })
    }

    pub async fn run(
        &self,
        connection: &ConnectionHandle,
        project: &ProjectSummary,
        plan: &DeploymentPlan,
    ) -> Result<DeploymentResult, CoreError> {
        if plan.project_id != project.id || connection.server_id() != project.server_id {
            return Err(CoreError::new(
                CoreErrorCode::ToolScopeViolation,
                "deployment scope does not match the project and SSH connection",
                false,
            ));
        }
        if project.deploy_strategy == DeployStrategy::DockerCompose {
            return run_compose(&self.runner, connection, project, plan).await;
        }
        let root = project.root_path.as_str().trim_end_matches('/');
        let releases_path = format!("{root}/releases");
        run_success(
            &self.runner,
            connection,
            RemoteCommand::try_new("mkdir")?
                .arg("-p")?
                .arg(&releases_path)?,
        )
        .await?;
        let repository = project
            .repository_url
            .as_deref()
            .ok_or_else(|| validation("project repository is missing"))?;
        run_success(
            &self.runner,
            connection,
            RemoteCommand::try_new("git")?
                .arg("clone")?
                .arg("--depth")?
                .arg("1")?
                .arg("--branch")?
                .arg(plan.revision.as_str())?
                .arg("--")?
                .arg(repository)?
                .arg(&plan.release_path)?,
        )
        .await?;
        for command in build_commands(project.runtime, &plan.release_path)? {
            run_success(&self.runner, connection, command).await?;
        }

        let old = self
            .runner
            .run(
                connection,
                RemoteCommand::try_new("readlink")?
                    .arg("--")?
                    .arg(&plan.current_path)?,
            )
            .await?;
        let previous_target = match old.exit_status {
            0 => Some(parse_link_target(&old.stdout)?),
            1 => None,
            status => return Err(remote_status("read current release", status)),
        };
        switch_link(
            &self.runner,
            connection,
            root,
            plan.release_id,
            &plan.release_path,
            &plan.current_path,
        )
        .await?;

        if let Some(url) = &plan.health_url {
            let health = self.runner.run(connection, health_command(url)?).await?;
            if health.exit_status != 0 {
                restore_link(
                    &self.runner,
                    connection,
                    root,
                    plan.release_id,
                    &plan.current_path,
                    previous_target.as_deref(),
                )
                .await?;
                return Err(CoreError::new(
                    CoreErrorCode::RemoteCommand,
                    "deployment health check failed; the previous release was restored",
                    false,
                ));
            }
        }
        Ok(DeploymentResult {
            release_path: plan.release_path.clone(),
            previous_target,
            rolled_back: false,
        })
    }
}

fn compose_plan(
    project: &ProjectSummary,
    release_id: Id,
    revision: GitRevision,
    health_url: Option<&str>,
) -> Result<DeploymentPlan, CoreError> {
    if project.runtime != RuntimeType::DockerCompose {
        return Err(CoreError::new(
            CoreErrorCode::CapabilityUnavailable,
            "Docker Compose deployment requires a Compose project runtime",
            false,
        ));
    }
    let root = project.root_path.as_str().trim_end_matches('/');
    let health_url = health_url.map(validate_health_url).transpose()?;
    let mut commands = vec![compose_config_command(root)?, compose_up_command(root)?];
    if let Some(url) = &health_url {
        commands.push(health_command(url)?);
    }
    Ok(DeploymentPlan {
        project_id: project.id,
        release_id,
        revision,
        release_path: root.to_owned(),
        current_path: root.to_owned(),
        commands: commands.iter().map(RemoteCommand::render_posix).collect(),
        health_url,
        impact_summary: "validate and apply the reviewed Docker Compose project".to_owned(),
    })
}

async fn run_compose<R>(
    runner: &R,
    connection: &ConnectionHandle,
    project: &ProjectSummary,
    plan: &DeploymentPlan,
) -> Result<DeploymentResult, CoreError>
where
    R: RemoteCommandRunner,
{
    let root = project.root_path.as_str().trim_end_matches('/');
    run_success(runner, connection, compose_config_command(root)?).await?;
    run_success(runner, connection, compose_up_command(root)?).await?;
    if let Some(url) = &plan.health_url {
        let health = runner.run(connection, health_command(url)?).await?;
        if health.exit_status != 0 {
            return Err(CoreError::new(
                CoreErrorCode::RemoteCommand,
                "Docker Compose health check failed; inspect the current task before retrying",
                false,
            ));
        }
    }
    Ok(DeploymentResult {
        release_path: root.to_owned(),
        previous_target: None,
        rolled_back: false,
    })
}

fn compose_config_command(root: &str) -> Result<RemoteCommand, CoreError> {
    RemoteCommand::try_new("docker")?
        .arg("compose")?
        .arg("config")?
        .arg("--quiet")?
        .cwd(root)
}

fn compose_up_command(root: &str) -> Result<RemoteCommand, CoreError> {
    RemoteCommand::try_new("docker")?
        .arg("compose")?
        .arg("up")?
        .arg("--detach")?
        .arg("--remove-orphans")?
        .cwd(root)
}

fn build_commands(
    runtime: RuntimeType,
    release_path: &str,
) -> Result<Vec<RemoteCommand>, CoreError> {
    Ok(match runtime {
        RuntimeType::NodeJs => vec![
            RemoteCommand::try_new("npm")?
                .arg("ci")?
                .cwd(release_path)?,
            RemoteCommand::try_new("npm")?
                .arg("run")?
                .arg("build")?
                .cwd(release_path)?,
        ],
        RuntimeType::Go => vec![
            RemoteCommand::try_new("go")?
                .arg("build")?
                .arg("./...")?
                .cwd(release_path)?,
        ],
        RuntimeType::Python => vec![
            RemoteCommand::try_new("python3")?
                .arg("-m")?
                .arg("compileall")?
                .arg(".")?
                .cwd(release_path)?,
        ],
        RuntimeType::StaticSite | RuntimeType::Generic => Vec::new(),
        RuntimeType::DockerCompose => {
            return Err(CoreError::new(
                CoreErrorCode::CapabilityUnavailable,
                "Docker Compose projects use the Compose deployment workflow",
                false,
            ));
        }
    })
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
        || value.chars().any(char::is_control)
        || value.chars().any(char::is_whitespace)
        || rest.is_none_or(|rest| rest.is_empty() || rest.starts_with('/') || rest.contains('@'))
    {
        return Err(validation(
            "health URL must be an HTTP(S) URL without credentials",
        ));
    }
    Ok(value.to_owned())
}

async fn run_success<R: RemoteCommandRunner>(
    runner: &R,
    connection: &ConnectionHandle,
    command: RemoteCommand,
) -> Result<ExecOutput, CoreError> {
    let result = runner.run(connection, command).await?;
    if result.exit_status == 0 {
        Ok(result)
    } else {
        Err(remote_status("execute deployment step", result.exit_status))
    }
}

async fn switch_link<R: RemoteCommandRunner>(
    runner: &R,
    connection: &ConnectionHandle,
    root: &str,
    release_id: Id,
    target: &str,
    current: &str,
) -> Result<(), CoreError> {
    let temporary = format!("{root}/.opspilot-current-{release_id}.tmp");
    run_success(
        runner,
        connection,
        RemoteCommand::try_new("ln")?
            .arg("-sfn")?
            .arg(target)?
            .arg(&temporary)?,
    )
    .await?;
    run_success(
        runner,
        connection,
        RemoteCommand::try_new("mv")?
            .arg("-Tf")?
            .arg(&temporary)?
            .arg(current)?,
    )
    .await?;
    Ok(())
}

async fn restore_link<R: RemoteCommandRunner>(
    runner: &R,
    connection: &ConnectionHandle,
    root: &str,
    release_id: Id,
    current: &str,
    previous: Option<&str>,
) -> Result<(), CoreError> {
    match previous {
        Some(target) => switch_link(runner, connection, root, release_id, target, current).await,
        None => {
            let output = runner
                .run(
                    connection,
                    RemoteCommand::try_new("unlink")?.arg("--")?.arg(current)?,
                )
                .await?;
            if output.exit_status == 0 {
                Ok(())
            } else {
                Err(remote_status(
                    "restore empty current release",
                    output.exit_status,
                ))
            }
        }
    }
}

fn parse_link_target(bytes: &[u8]) -> Result<String, CoreError> {
    let value = std::str::from_utf8(bytes)
        .map_err(|_| {
            CoreError::new(
                CoreErrorCode::RemoteParse,
                "current symlink target is not UTF-8",
                false,
            )
        })?
        .trim();
    if value.is_empty()
        || value.chars().any(char::is_control)
        || Path::new(value)
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(CoreError::new(
            CoreErrorCode::RemoteParse,
            "current symlink target is unsafe",
            false,
        ));
    }
    Ok(value.to_owned())
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
