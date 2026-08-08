use std::{collections::VecDeque, sync::Arc};

use async_trait::async_trait;
use opspilot_domain::{CoreError, Id};
use opspilot_remote_adapters::{NginxAdapter, NginxApplyPlan, RemoteCommand, RemoteCommandRunner};
use opspilot_ssh_core::{ConnectionHandle, ExecOutput};
use tokio::sync::Mutex;

#[tokio::test]
async fn invalid_candidate_never_replaces_live_config() {
    let runner = FakeRunner::new([ok(), ok(), ok(), status(1), ok()]);
    let adapter = NginxAdapter::new(runner.clone());
    let plan = plan(None);

    adapter
        .apply(&connection(), &plan)
        .await
        .expect_err("syntax failure must abort");

    let commands = runner.commands().await;
    assert!(!commands.iter().any(|command| command.starts_with("'mv'")));
    assert_eq!(
        commands
            .iter()
            .filter(|command| command.starts_with("'nginx' '-s' 'reload'"))
            .count(),
        0
    );
}

#[tokio::test]
async fn health_failure_restores_snapshot_atomically_and_reloads_again() {
    let runner = FakeRunner::new([
        ok(),
        ok(),
        ok(),
        ok(),
        ok(),
        ok(),
        status(22),
        ok(),
        ok(),
        ok(),
    ]);
    let adapter = NginxAdapter::new(runner.clone());

    let error = adapter
        .apply(&connection(), &plan(Some("http://127.0.0.1/health")))
        .await
        .expect_err("health failure must restore live configuration");

    assert!(
        error
            .message()
            .contains("previous configuration was restored")
    );
    let commands = runner.commands().await;
    assert_eq!(
        commands
            .iter()
            .filter(|command| command.starts_with("'mv'"))
            .count(),
        2
    );
    assert_eq!(
        commands
            .iter()
            .filter(|command| command.starts_with("'nginx' '-s' 'reload'"))
            .count(),
        2
    );
}

#[test]
fn candidate_and_paths_are_bounded_before_remote_execution() {
    assert!(
        NginxApplyPlan::try_new(
            Id::new(),
            "../site.conf",
            "/etc/nginx/nginx.conf",
            b"server {}".to_vec(),
            None,
        )
        .is_err()
    );
    assert!(
        NginxApplyPlan::try_new(
            Id::new(),
            "/etc/nginx/site.conf",
            "/etc/nginx/nginx.conf",
            vec![b'a'; 1024 * 1024 + 1],
            None,
        )
        .is_err()
    );
}

fn plan(health: Option<&str>) -> NginxApplyPlan {
    NginxApplyPlan::try_new(
        Id::new(),
        "/etc/nginx/conf.d/web.conf",
        "/etc/nginx/nginx.conf",
        b"server { listen 80; }\n".to_vec(),
        health,
    )
    .unwrap()
}

fn connection() -> ConnectionHandle {
    ConnectionHandle::new(Id::new(), Id::new())
}
fn ok() -> ExecOutput {
    status(0)
}
fn status(exit_status: u32) -> ExecOutput {
    ExecOutput {
        stdout: Vec::new(),
        stderr: Vec::new(),
        exit_status,
    }
}

#[derive(Clone)]
struct FakeRunner {
    outputs: Arc<Mutex<VecDeque<ExecOutput>>>,
    commands: Arc<Mutex<Vec<String>>>,
}

impl FakeRunner {
    fn new(outputs: impl IntoIterator<Item = ExecOutput>) -> Self {
        Self {
            outputs: Arc::new(Mutex::new(outputs.into_iter().collect())),
            commands: Arc::new(Mutex::new(Vec::new())),
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
    ) -> Result<ExecOutput, CoreError> {
        self.commands.lock().await.push(command.render_posix());
        Ok(self
            .outputs
            .lock()
            .await
            .pop_front()
            .expect("fixture output"))
    }
}
