use opspilot_domain::CoreError;
use opspilot_remote_adapters::{
    ContainerIdentifier, DockerAction, DockerCliAdapter, DockerContainerList, DockerLogs,
    DockerShell, RemoteCommandRunner, RemoteExecutor,
};
use opspilot_secrets::KeyringSecretStore;
use opspilot_ssh_core::{
    ConnectionHandle, PtySize, ShellBackend, TerminalManager, TerminalSession,
};
use tauri::{AppHandle, Manager};

use super::CoreServices;

pub(super) async fn open_docker_terminal<B, R>(
    terminal_manager: &TerminalManager<B>,
    adapter: &DockerCliAdapter<R>,
    connection: ConnectionHandle,
    container_id: &str,
    shell: DockerShell,
    columns: u32,
    rows: u32,
) -> Result<TerminalSession, CoreError>
where
    B: ShellBackend,
    R: RemoteCommandRunner,
{
    if !terminal_manager.is_connection_registered(&connection).await {
        return Err(CoreError::new(
            opspilot_domain::CoreErrorCode::NotFound,
            "SSH connection was not found",
            false,
        ));
    }
    let container = ContainerIdentifier::try_new(container_id)?;
    adapter.verify_exec(&connection, &container, &shell).await?;
    terminal_manager
        .open_command(
            connection,
            PtySize::try_new(columns, rows)?,
            adapter.terminal_command(&container, &shell),
        )
        .await
}

#[tauri::command]
pub(crate) async fn docker_list(
    app: AppHandle,
    connection: ConnectionHandle,
) -> Result<DockerContainerList, CoreError> {
    let adapter = docker_adapter(&core_services(&app));
    adapter.list_containers(&connection).await
}

#[tauri::command]
pub(crate) async fn docker_logs(
    app: AppHandle,
    connection: ConnectionHandle,
    container_id: String,
    tail: u32,
) -> Result<DockerLogs, CoreError> {
    let adapter = docker_adapter(&core_services(&app));
    let container = ContainerIdentifier::try_new(&container_id)?;
    adapter.logs(&connection, &container, tail).await
}

#[tauri::command]
pub(crate) async fn docker_action(
    app: AppHandle,
    connection: ConnectionHandle,
    container_id: String,
    action: DockerAction,
) -> Result<(), CoreError> {
    let adapter = docker_adapter(&core_services(&app));
    let container = ContainerIdentifier::try_new(&container_id)?;
    adapter
        .container_action(&connection, action, &container)
        .await
}

#[tauri::command]
pub(crate) async fn docker_exec(
    app: AppHandle,
    connection: ConnectionHandle,
    container_id: String,
    shell: Option<DockerShell>,
    columns: u32,
    rows: u32,
) -> Result<TerminalSession, CoreError> {
    let services = core_services(&app);
    let adapter = docker_adapter(&services);
    let shell = match shell {
        Some(shell) => DockerShell::try_new(shell.as_str())?,
        None => DockerShell::default(),
    };
    open_docker_terminal(
        &services.terminal_manager,
        &adapter,
        connection,
        &container_id,
        shell,
        columns,
        rows,
    )
    .await
}

fn docker_adapter(
    services: &CoreServices<KeyringSecretStore>,
) -> DockerCliAdapter<RemoteExecutor<KeyringSecretStore>> {
    DockerCliAdapter::new(RemoteExecutor::new(services.connection_manager.clone()))
}

fn core_services(app: &AppHandle) -> CoreServices<KeyringSecretStore> {
    app.state::<CoreServices<KeyringSecretStore>>()
        .inner()
        .clone()
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use async_trait::async_trait;
    use opspilot_domain::{CoreError, CoreErrorCode, Id};
    use opspilot_remote_adapters::{
        DockerCliAdapter, DockerShell, RemoteCommand, RemoteCommandRunner,
    };
    use opspilot_ssh_core::{ConnectionHandle, ExecOutput, InMemoryShellBackend, TerminalManager};

    use super::open_docker_terminal;

    #[derive(Clone, Default)]
    struct ExecRunner {
        commands: Arc<Mutex<Vec<String>>>,
    }

    impl ExecRunner {
        fn commands(&self) -> Vec<String> {
            self.commands.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl RemoteCommandRunner for ExecRunner {
        async fn run(
            &self,
            _connection: &ConnectionHandle,
            command: RemoteCommand,
        ) -> Result<ExecOutput, CoreError> {
            let rendered = command.render_posix();
            self.commands.lock().unwrap().push(rendered.clone());
            let stdout = if rendered.contains("'container' 'inspect'") {
                "true\n"
            } else if rendered.contains("'exec' '--'") && rendered.contains("'-c'") {
                ""
            } else {
                return Err(CoreError::new(
                    CoreErrorCode::RemoteCommand,
                    format!("unexpected Docker command: {rendered}"),
                    false,
                ));
            };
            Ok(ExecOutput {
                stdout: stdout.as_bytes().to_vec(),
                stderr: Vec::new(),
                exit_status: 0,
            })
        }
    }

    fn connection() -> ConnectionHandle {
        ConnectionHandle::new(Id::new(), Id::new())
    }

    #[tokio::test]
    async fn docker_exec_reuses_terminal_manager_and_builds_the_validated_command() {
        let backend = InMemoryShellBackend::new();
        let manager = TerminalManager::new(backend.clone());
        let runner = ExecRunner::default();
        let adapter = DockerCliAdapter::new(runner.clone());
        let connection = connection();
        manager.register_connection(&connection).await.unwrap();

        let session = open_docker_terminal(
            &manager,
            &adapter,
            connection.clone(),
            "abc123",
            DockerShell::try_new("bash").unwrap(),
            120,
            40,
        )
        .await
        .unwrap();

        assert_eq!(
            backend.command(session.id()).await.unwrap().as_str(),
            "docker exec -it -- abc123 bash"
        );
        assert_eq!(runner.commands().len(), 2);

        for invalid in ["", "--force", "abc; rm -rf /"] {
            let error = open_docker_terminal(
                &manager,
                &adapter,
                connection.clone(),
                invalid,
                DockerShell::try_new("sh").unwrap(),
                80,
                24,
            )
            .await
            .expect_err("invalid container identifiers must be rejected");
            assert_eq!(error.code(), CoreErrorCode::Validation);
        }
    }

    #[tokio::test]
    async fn docker_exec_requires_a_registered_connection_and_the_eight_session_limit() {
        let backend = InMemoryShellBackend::new();
        let manager = TerminalManager::new(backend);
        let adapter = DockerCliAdapter::new(ExecRunner::default());
        let connection = connection();

        let unregistered = open_docker_terminal(
            &manager,
            &adapter,
            connection.clone(),
            "abc123",
            DockerShell::try_new("sh").unwrap(),
            80,
            24,
        )
        .await
        .expect_err("an arbitrary connection handle must not open a Docker terminal");
        assert_eq!(unregistered.code(), CoreErrorCode::NotFound);

        manager.register_connection(&connection).await.unwrap();
        for _ in 0..8 {
            open_docker_terminal(
                &manager,
                &adapter,
                connection.clone(),
                "abc123",
                DockerShell::try_new("sh").unwrap(),
                80,
                24,
            )
            .await
            .unwrap();
        }
        let limited = open_docker_terminal(
            &manager,
            &adapter,
            connection,
            "abc123",
            DockerShell::try_new("sh").unwrap(),
            80,
            24,
        )
        .await
        .expect_err("Docker exec must share the per-server terminal limit");
        assert_eq!(limited.code(), CoreErrorCode::Conflict);
    }
}
