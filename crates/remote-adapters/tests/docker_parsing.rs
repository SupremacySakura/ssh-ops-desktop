use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};

use async_trait::async_trait;
use opspilot_domain::{CoreError, CoreErrorCode, Id};
use opspilot_remote_adapters::{
    ContainerIdentifier, DockerAction, DockerCliAdapter, DockerContainer, DockerContainerList,
    DockerShell, RemoteCommand, RemoteCommandRunner, parse_containers, parse_stats, parse_version,
};
use opspilot_ssh_core::{ConnectionHandle, ExecOutput};

#[derive(Clone, Default)]
struct ScriptedRunner {
    outputs: Arc<Mutex<VecDeque<Result<ExecOutput, CoreError>>>>,
    commands: Arc<Mutex<Vec<String>>>,
}

impl ScriptedRunner {
    fn new(outputs: Vec<Result<ExecOutput, CoreError>>) -> Self {
        Self {
            outputs: Arc::new(Mutex::new(outputs.into())),
            commands: Arc::default(),
        }
    }

    fn commands(&self) -> Vec<String> {
        self.commands.lock().unwrap().clone()
    }
}

#[async_trait]
impl RemoteCommandRunner for ScriptedRunner {
    async fn run(
        &self,
        _connection: &ConnectionHandle,
        command: RemoteCommand,
    ) -> Result<ExecOutput, CoreError> {
        self.commands.lock().unwrap().push(command.render_posix());
        self.outputs
            .lock()
            .unwrap()
            .pop_front()
            .expect("scripted Docker command output")
    }
}

fn connection() -> ConnectionHandle {
    ConnectionHandle::new(Id::new(), Id::new())
}

fn success(stdout: &str, stderr: &str) -> ExecOutput {
    ExecOutput {
        stdout: stdout.as_bytes().to_vec(),
        stderr: stderr.as_bytes().to_vec(),
        exit_status: 0,
    }
}

#[test]
fn parses_json_lines_without_localized_table_output() {
    let containers = parse_containers(br#"{"ID":"abc123","Names":"web","Image":"nginx:alpine","State":"running","Status":"Up 3 hours","Ports":"80/tcp"}
{"ID":"def456","Names":"worker","Image":"worker:1","State":"exited","Status":"Exited (0)","Ports":""}
"#).unwrap();
    assert_eq!(containers.len(), 2);
    assert_eq!(containers[0].names, ["web"]);
    assert!(
        parse_containers(br#"{"ID":"--privileged","Names":"web","Image":"nginx","State":"running","Status":"Up","Ports":""}"#)
            .is_err(),
        "container IDs from Docker output must still be validated before reuse"
    );
}

#[test]
fn parses_version_and_stats_and_rejects_option_like_ids() {
    let version =
        parse_version(br#"{"Version":"27.1.1","ApiVersion":"1.46","Os":"linux","Arch":"amd64"}"#)
            .unwrap();
    assert_eq!(version.transport, "cli");
    let stats = parse_stats(br#"{"ID":"abc123","Name":"web","CPUPerc":"0.10%","MemUsage":"1MiB / 1GiB","MemPerc":"0.10%","NetIO":"1kB / 2kB","BlockIO":"0B / 0B"}"#).unwrap();
    assert_eq!(stats.name, "web");
    assert!(ContainerIdentifier::try_new("--host=tcp://evil").is_err());
}

#[tokio::test]
async fn lists_containers_then_enriches_started_at_with_a_separate_inspect() {
    let runner = ScriptedRunner::new(vec![
        Ok(success(
            r#"{"ID":"abc123","Names":"web,web-alias","Image":"nginx:alpine","State":"running","Status":"Up 3 hours","Ports":"0.0.0.0:8080->80/tcp, :::8080->80/tcp"}
{"ID":"def456","Names":"worker","Image":"worker:1","State":"exited","Status":"Exited (0)","Ports":""}
"#,
            "",
        )),
        Ok(success(
            "abc123\t2026-11-17T12:00:00.123456789Z\ndef456\t0001-01-01T00:00:00Z\n",
            "",
        )),
    ]);
    let adapter = DockerCliAdapter::new(runner.clone());

    let list = adapter.list_containers(&connection()).await.unwrap();

    assert_eq!(list.containers.len(), 2);
    assert_eq!(list.containers[0].names, ["web", "web-alias"]);
    assert_eq!(
        list.containers[0].ports,
        ["0.0.0.0:8080->80/tcp", ":::8080->80/tcp"]
    );
    assert_eq!(
        list.containers[0].started_at.as_deref(),
        Some("2026-11-17T12:00:00.123456789Z")
    );
    assert_eq!(list.containers[1].started_at, None);
    assert_eq!(list.started_at_warning, None);

    let commands = runner.commands();
    assert_eq!(commands.len(), 2);
    assert!(commands[0].contains("'container' 'ls' '--all'"));
    assert!(commands[1].contains("'container' 'inspect'"));
    assert!(commands[1].contains("'abc123' 'def456'"));
}

#[tokio::test]
async fn inspect_batches_bound_the_command_length_and_merge_started_at() {
    let listed = (0..101)
        .map(|index| {
            format!(
                r#"{{"ID":"container-{index:03}","Names":"web-{index}","Image":"nginx","State":"running","Status":"Up","Ports":""}}"#
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let first_batch = (0..100)
        .map(|index| format!("container-{index:03}\t2026-11-17T12:00:00Z"))
        .collect::<Vec<_>>()
        .join("\n");
    let second_batch = "container-100\t2026-11-17T13:00:00Z";
    let runner = ScriptedRunner::new(vec![
        Ok(success(&format!("{listed}\n"), "")),
        Ok(success(&format!("{first_batch}\n"), "")),
        Ok(success(&format!("{second_batch}\n"), "")),
    ]);
    let adapter = DockerCliAdapter::new(runner.clone());

    let list = adapter.list_containers(&connection()).await.unwrap();

    assert_eq!(list.containers.len(), 101);
    assert_eq!(
        list.containers[0].started_at.as_deref(),
        Some("2026-11-17T12:00:00Z")
    );
    assert_eq!(
        list.containers[100].started_at.as_deref(),
        Some("2026-11-17T13:00:00Z")
    );
    let commands = runner.commands();
    assert_eq!(commands.len(), 3);
    assert!(commands[1].contains("'container-000'"));
    assert!(commands[1].contains("'container-099'"));
    assert!(!commands[1].contains("'container-100'"));
    assert!(commands[2].contains("'container-100'"));
}

#[tokio::test]
async fn inspect_failure_keeps_the_container_list_and_reports_a_warning() {
    let runner = ScriptedRunner::new(vec![
        Ok(success(
            r#"{"ID":"abc123","Names":"web","Image":"nginx:alpine","State":"running","Status":"Up 3 hours","Ports":"80/tcp"}
"#,
            "",
        )),
        Ok(ExecOutput {
            stdout: Vec::new(),
            stderr: b"Docker daemon is unavailable".to_vec(),
            exit_status: 1,
        }),
    ]);
    let adapter = DockerCliAdapter::new(runner);

    let list = adapter.list_containers(&connection()).await.unwrap();

    assert_eq!(list.containers.len(), 1);
    assert_eq!(list.containers[0].id, "abc123");
    assert_eq!(list.containers[0].started_at, None);
    assert!(
        list.started_at_warning
            .as_deref()
            .is_some_and(|warning| warning.contains("Docker daemon is unavailable"))
    );
}

#[tokio::test]
async fn classifies_docker_availability_and_container_failures_with_stable_codes() {
    for (status, stderr, expected) in [
        (
            127,
            "sh: 1: docker: not found",
            CoreErrorCode::DockerNotInstalled,
        ),
        (
            1,
            "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock",
            CoreErrorCode::DockerPermissionDenied,
        ),
        (
            126,
            "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock",
            CoreErrorCode::DockerPermissionDenied,
        ),
        (
            1,
            "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
            CoreErrorCode::DockerDaemonUnavailable,
        ),
        (
            1,
            "Error response from daemon: No such container: abc123",
            CoreErrorCode::DockerContainerNotFound,
        ),
    ] {
        let runner = ScriptedRunner::new(vec![Ok(ExecOutput {
            stdout: Vec::new(),
            stderr: stderr.as_bytes().to_vec(),
            exit_status: status,
        })]);
        let adapter = DockerCliAdapter::new(runner);

        let error = adapter
            .list_containers(&connection())
            .await
            .expect_err("Docker CLI failure must be classified");

        assert_eq!(error.code(), expected, "stderr: {stderr}");
        assert!(error.message().contains(stderr));
    }
}

#[tokio::test]
async fn logs_include_stdout_and_stderr_and_enforce_a_bounded_tail() {
    let runner = ScriptedRunner::new(vec![Ok(success("stdout line\n", "stderr line\n"))]);
    let adapter = DockerCliAdapter::new(runner.clone());
    let container = ContainerIdentifier::try_new("abc123").unwrap();

    let logs = adapter.logs(&connection(), &container, 500).await.unwrap();

    assert_eq!(logs.container_id, "abc123");
    assert_eq!(logs.tail, 500);
    assert_eq!(logs.stdout, "stdout line\n");
    assert_eq!(logs.stderr, "stderr line\n");
    assert!(runner.commands()[0].contains("'logs' '--timestamps' '--tail' '500'"));

    for invalid_tail in [0, 1_001] {
        let error = adapter
            .logs(&connection(), &container, invalid_tail)
            .await
            .expect_err("unbounded log tails must be rejected");
        assert_eq!(error.code(), CoreErrorCode::Validation);
    }
}

#[tokio::test]
async fn container_actions_are_typed_and_never_include_remove() {
    let runner = ScriptedRunner::new(vec![
        Ok(success("", "")),
        Ok(success("", "")),
        Ok(success("", "")),
    ]);
    let adapter = DockerCliAdapter::new(runner.clone());
    let container = ContainerIdentifier::try_new("abc123").unwrap();

    for action in [
        DockerAction::Start,
        DockerAction::Stop,
        DockerAction::Restart,
    ] {
        adapter
            .container_action(&connection(), action, &container)
            .await
            .unwrap();
    }

    let commands = runner.commands();
    assert_eq!(commands.len(), 3);
    assert!(commands[0].contains("'container' 'start' '--' 'abc123'"));
    assert!(commands[1].contains("'container' 'stop' '--' 'abc123'"));
    assert!(commands[2].contains("'container' 'restart' '--' 'abc123'"));
    assert!(commands.iter().all(|command| !command.contains("'rm'")));
}

#[tokio::test]
async fn exec_verification_and_terminal_command_use_only_validated_ids_and_whitelisted_shells() {
    let runner = ScriptedRunner::new(vec![
        Ok(success("true\n", "")),
        Err(CoreError::new(
            CoreErrorCode::DockerShellUnavailable,
            "shell is unavailable",
            false,
        )),
    ]);
    let adapter = DockerCliAdapter::new(runner.clone());
    let container = ContainerIdentifier::try_new("abc123").unwrap();

    let error = adapter
        .verify_exec(&connection(), &container, DockerShell::Bash)
        .await
        .expect_err("the missing shell must be surfaced before opening a terminal");
    assert_eq!(error.code(), CoreErrorCode::DockerShellUnavailable);

    let commands = runner.commands();
    assert_eq!(commands.len(), 2);
    assert!(commands[0].contains("'container' 'inspect' '--format' '{{.State.Running}}'"));
    assert!(commands[1].contains("'exec' '--' 'abc123' 'bash' '-c' 'command -v bash'"));
    assert_eq!(
        adapter
            .terminal_command(&container, DockerShell::Bash)
            .as_str(),
        "docker exec -it -- abc123 bash"
    );
    assert_eq!(
        adapter
            .terminal_command(&container, DockerShell::Sh)
            .as_str(),
        "docker exec -it -- abc123 sh"
    );
    assert_eq!(
        adapter
            .terminal_command(&container, DockerShell::Ash)
            .as_str(),
        "docker exec -it -- abc123 ash"
    );
}

#[tokio::test]
async fn exec_verification_maps_a_missing_shell_probe_to_shell_unavailable() {
    let runner = ScriptedRunner::new(vec![
        Ok(success("true\n", "")),
        Ok(ExecOutput {
            stdout: Vec::new(),
            stderr: b"OCI runtime exec failed: exec: \"bash\": executable file not found in $PATH"
                .to_vec(),
            exit_status: 127,
        }),
    ]);
    let adapter = DockerCliAdapter::new(runner);
    let container = ContainerIdentifier::try_new("abc123").unwrap();

    let error = adapter
        .verify_exec(&connection(), &container, DockerShell::Bash)
        .await
        .expect_err("missing shell must be reported");

    assert_eq!(error.code(), CoreErrorCode::DockerShellUnavailable);
}

#[test]
fn docker_contract_serializes_camel_case_and_stable_enum_values() {
    let list = DockerContainerList {
        containers: vec![DockerContainer {
            id: "abc123".to_owned(),
            names: vec!["web".to_owned()],
            image: "nginx:alpine".to_owned(),
            state: "running".to_owned(),
            status: "Up 3 hours".to_owned(),
            ports: vec!["8080->80/tcp".to_owned()],
            started_at: Some("2026-11-17T12:00:00Z".to_owned()),
        }],
        started_at_warning: None,
    };

    let value = serde_json::to_value(list).unwrap();
    assert_eq!(value["containers"][0]["startedAt"], "2026-11-17T12:00:00Z");
    assert_eq!(value["startedAtWarning"], serde_json::Value::Null);
    assert!(value["containers"][0].get("started_at").is_none());
    assert_eq!(
        serde_json::to_string(&DockerAction::Restart).unwrap(),
        "\"restart\""
    );
    assert_eq!(serde_json::to_string(&DockerShell::Ash).unwrap(), "\"ash\"");
    assert_eq!(
        serde_json::to_value(CoreError::new(
            CoreErrorCode::DockerDaemonUnavailable,
            "docker daemon unavailable",
            true,
        ))
        .unwrap()["code"],
        "DOCKER_DAEMON_UNAVAILABLE"
    );
}
