use opspilot_domain::{CoreError, Id};
use opspilot_ssh_core::{
    ConnectionHandle, PtySize, ShellBackend, TerminalManager, TerminalSession,
};
use tauri::{AppHandle, Manager};

use super::CoreServices;

pub(super) async fn open_terminal<B>(
    manager: &TerminalManager<B>,
    connection: ConnectionHandle,
    columns: u32,
    rows: u32,
) -> Result<TerminalSession, CoreError>
where
    B: ShellBackend,
{
    manager
        .open(connection, PtySize::try_new(columns, rows)?)
        .await
}

#[tauri::command]
pub(crate) async fn terminal_open(
    app: AppHandle,
    connection: ConnectionHandle,
    columns: u32,
    rows: u32,
) -> Result<TerminalSession, CoreError> {
    open_terminal(
        &core_services(&app).terminal_manager,
        connection,
        columns,
        rows,
    )
    .await
}

#[tauri::command]
pub(crate) async fn terminal_write(
    app: AppHandle,
    terminal_session_id: Id,
    bytes: Vec<u8>,
) -> Result<(), CoreError> {
    core_services(&app)
        .terminal_manager
        .write(terminal_session_id, &bytes)
        .await
}

#[tauri::command]
pub(crate) async fn terminal_resize(
    app: AppHandle,
    terminal_session_id: Id,
    columns: u32,
    rows: u32,
) -> Result<(), CoreError> {
    core_services(&app)
        .terminal_manager
        .resize(terminal_session_id, PtySize::try_new(columns, rows)?)
        .await
}

#[tauri::command]
pub(crate) async fn terminal_close(
    app: AppHandle,
    terminal_session_id: Id,
) -> Result<(), CoreError> {
    core_services(&app)
        .terminal_manager
        .close(terminal_session_id)
        .await
}

fn core_services(app: &AppHandle) -> CoreServices {
    app.state::<CoreServices>().inner().clone()
}

#[cfg(test)]
mod tests {
    use opspilot_domain::{CoreErrorCode, Id};
    use opspilot_ssh_core::{ConnectionHandle, InMemoryShellBackend, PtySize, TerminalManager};

    use super::open_terminal;

    #[tokio::test]
    async fn command_helper_requires_a_registered_connection_and_valid_pty_size() {
        let manager = TerminalManager::new(InMemoryShellBackend::new());
        let connection = ConnectionHandle::new(Id::new(), Id::new());
        let unregistered = open_terminal(&manager, connection.clone(), 80, 24)
            .await
            .expect_err("the command helper must not accept an arbitrary connection handle");
        assert_eq!(unregistered.code(), CoreErrorCode::NotFound);

        manager.register_connection(&connection).await.unwrap();
        let invalid = open_terminal(&manager, connection.clone(), 1, 24)
            .await
            .expect_err("PTY bounds are validated before backend open");
        assert_eq!(invalid.code(), CoreErrorCode::Validation);

        let session = open_terminal(&manager, connection, 80, 24).await.unwrap();
        manager
            .resize(session.id(), PtySize::try_new(120, 40).unwrap())
            .await
            .unwrap();
    }
}
