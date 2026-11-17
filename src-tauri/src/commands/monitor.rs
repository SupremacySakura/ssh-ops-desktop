use opspilot_domain::{CoreError, CoreErrorCode};
use opspilot_remote_adapters::MonitorSnapshot;
use opspilot_ssh_core::{ConnectionHandle, ShellBackend, TerminalManager};
use tauri::{AppHandle, Manager};

use super::CoreServices;

pub(super) async fn require_active_connection<B>(
    manager: &TerminalManager<B>,
    connection: &ConnectionHandle,
) -> Result<(), CoreError>
where
    B: ShellBackend,
{
    if manager.is_connection_registered(connection).await {
        Ok(())
    } else {
        Err(CoreError::new(
            CoreErrorCode::NotFound,
            "SSH connection is not active; reconnect before sampling",
            true,
        ))
    }
}

#[tauri::command]
pub(crate) async fn monitor_snapshot(
    app: AppHandle,
    connection: ConnectionHandle,
) -> Result<MonitorSnapshot, CoreError> {
    let services = core_services(&app);
    require_active_connection(&services.terminal_manager, &connection).await?;
    services.monitor.snapshot(&connection).await
}

fn core_services(app: &AppHandle) -> CoreServices {
    app.state::<CoreServices>().inner().clone()
}

#[cfg(test)]
mod tests {
    use opspilot_domain::{CoreErrorCode, Id};
    use opspilot_ssh_core::{ConnectionHandle, InMemoryShellBackend, TerminalManager};

    use super::require_active_connection;

    #[tokio::test]
    async fn monitor_commands_accept_only_the_registered_server_connection() {
        let manager = TerminalManager::new(InMemoryShellBackend::new());
        let connection = ConnectionHandle::new(Id::new(), Id::new());

        let unregistered = require_active_connection(&manager, &connection)
            .await
            .expect_err("an arbitrary handle must not trigger remote sampling");
        assert_eq!(unregistered.code(), CoreErrorCode::NotFound);

        manager.register_connection(&connection).await.unwrap();
        require_active_connection(&manager, &connection)
            .await
            .unwrap();

        let mismatched = ConnectionHandle::new(Id::new(), connection.connection_id());
        let error = require_active_connection(&manager, &mismatched)
            .await
            .expect_err("a connection id must remain bound to its server");
        assert_eq!(error.code(), CoreErrorCode::NotFound);
    }
}
