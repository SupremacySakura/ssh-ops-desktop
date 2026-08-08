use std::{collections::VecDeque, sync::Arc};

use async_trait::async_trait;
use opspilot_domain::{DeployStrategy, Id, ProjectInput, ProjectSummary, RuntimeType};
use opspilot_remote_adapters::{GitRevision, ReleaseDeployer, RemoteCommand, RemoteCommandRunner};
use opspilot_ssh_core::{ConnectionHandle, ExecOutput};
use tokio::sync::Mutex;

#[tokio::test]
async fn health_failure_restores_previous_symlink_and_keeps_failed_release() {
    let runner = FakeRunner::with_outputs([
        output(0, ""),
        output(0, ""),
        output(0, "releases/001\n"),
        output(0, ""),
        output(0, ""),
        output(22, ""),
        output(0, ""),
        output(0, ""),
    ]);
    let deployer = ReleaseDeployer::new(runner.clone());
    let project = project(RuntimeType::StaticSite);
    let release_id = Id::new();
    let plan = deployer
        .plan(
            &project,
            release_id,
            GitRevision::try_new("v2.0.0").unwrap(),
            Some("http://127.0.0.1:8080/health"),
        )
        .unwrap();

    let error = deployer
        .run(&connection(project.server_id), &project, &plan)
        .await
        .expect_err("health failure must fail the deployment");

    assert!(error.message().contains("previous release was restored"));
    let commands = runner.commands().await;
    assert!(
        commands
            .iter()
            .any(|command| command.contains(&plan.release_path))
    );
    assert_eq!(
        commands
            .iter()
            .filter(|command| command.starts_with("'mv'"))
            .count(),
        2
    );
    assert!(!commands.iter().any(|command| command.starts_with("'rm'")));
}

#[tokio::test]
async fn build_failure_never_switches_current() {
    let runner = FakeRunner::with_outputs([output(0, ""), output(0, ""), output(1, "")]);
    let deployer = ReleaseDeployer::new(runner.clone());
    let project = project(RuntimeType::NodeJs);
    let plan = deployer
        .plan(
            &project,
            Id::new(),
            GitRevision::try_new("main").unwrap(),
            None,
        )
        .unwrap();

    deployer
        .run(&connection(project.server_id), &project, &plan)
        .await
        .expect_err("build failure must stop before switching current");

    assert!(
        !runner
            .commands()
            .await
            .iter()
            .any(|command| command.starts_with("'mv'"))
    );
}

#[tokio::test]
async fn compose_deployment_validates_before_applying_without_running_git() {
    let runner = FakeRunner::with_outputs([output(0, ""), output(0, "")]);
    let deployer = ReleaseDeployer::new(runner.clone());
    let input = ProjectInput::try_new(
        Id::new(),
        "compose-app",
        "/srv/compose-app",
        None,
        RuntimeType::DockerCompose,
        DeployStrategy::DockerCompose,
    )
    .unwrap();
    let project = ProjectSummary {
        id: Id::new(),
        server_id: input.server_id,
        name: input.name,
        root_path: input.root_path,
        repository_url: input.repository_url,
        runtime: input.runtime,
        deploy_strategy: input.deploy_strategy,
    };
    let plan = deployer
        .plan(
            &project,
            Id::new(),
            GitRevision::try_new("compose").unwrap(),
            None,
        )
        .unwrap();

    deployer
        .run(&connection(project.server_id), &project, &plan)
        .await
        .unwrap();
    let commands = runner.commands().await;
    assert!(commands[0].contains("'docker' 'compose' 'config' '--quiet'"));
    assert!(commands[1].contains("'docker' 'compose' 'up' '--detach' '--remove-orphans'"));
    assert!(!commands.iter().any(|command| command.contains("'git'")));
}

#[test]
fn rejects_revision_option_injection_and_credentialed_health_urls() {
    assert!(GitRevision::try_new("--upload-pack=pwn").is_err());
    let runner = FakeRunner::with_outputs([]);
    let project = project(RuntimeType::StaticSite);
    let error = ReleaseDeployer::new(runner)
        .plan(
            &project,
            Id::new(),
            GitRevision::try_new("main").unwrap(),
            Some("https://user:secret@example.com/health"),
        )
        .unwrap_err();
    assert_eq!(error.code(), opspilot_domain::CoreErrorCode::Validation);
}

fn project(runtime: RuntimeType) -> ProjectSummary {
    let input = ProjectInput::try_new(
        Id::new(),
        "web",
        "/srv/web",
        Some("https://example.com/team/web.git"),
        runtime,
        DeployStrategy::ReleaseSymlink,
    )
    .unwrap();
    ProjectSummary {
        id: Id::new(),
        server_id: input.server_id,
        name: input.name,
        root_path: input.root_path,
        repository_url: input.repository_url,
        runtime: input.runtime,
        deploy_strategy: input.deploy_strategy,
    }
}

fn connection(server_id: Id) -> ConnectionHandle {
    ConnectionHandle::new(server_id, Id::new())
}

fn output(exit_status: u32, stdout: &str) -> ExecOutput {
    ExecOutput {
        stdout: stdout.as_bytes().to_vec(),
        stderr: Vec::new(),
        exit_status,
    }
}

#[derive(Clone, Default)]
struct FakeRunner {
    outputs: Arc<Mutex<VecDeque<ExecOutput>>>,
    commands: Arc<Mutex<Vec<String>>>,
}

impl FakeRunner {
    fn with_outputs(outputs: impl IntoIterator<Item = ExecOutput>) -> Self {
        Self {
            outputs: Arc::new(Mutex::new(outputs.into_iter().collect())),
            commands: Arc::default(),
        }
    }

    async fn commands(&self) -> Vec<String> {
        self.commands.lock().await.clone()
    }
}

#[async_trait]
impl RemoteCommandRunner for FakeRunner {
    async fn run(
        &self,
        _connection: &ConnectionHandle,
        command: RemoteCommand,
    ) -> Result<ExecOutput, opspilot_domain::CoreError> {
        self.commands.lock().await.push(command.render_posix());
        Ok(self
            .outputs
            .lock()
            .await
            .pop_front()
            .expect("fixture output"))
    }
}
