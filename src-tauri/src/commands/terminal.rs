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
    connection: ConnectionHandle,
    terminal_session_id: Id,
    bytes: Vec<u8>,
) -> Result<(), CoreError> {
    core_services(&app)
        .terminal_manager
        .write_for(&connection, terminal_session_id, &bytes)
        .await
}

#[tauri::command]
pub(crate) async fn terminal_resize(
    app: AppHandle,
    connection: ConnectionHandle,
    terminal_session_id: Id,
    columns: u32,
    rows: u32,
) -> Result<(), CoreError> {
    core_services(&app)
        .terminal_manager
        .resize_for(
            &connection,
            terminal_session_id,
            PtySize::try_new(columns, rows)?,
        )
        .await
}

#[tauri::command]
pub(crate) async fn terminal_close(
    app: AppHandle,
    connection: ConnectionHandle,
    terminal_session_id: Id,
) -> Result<(), CoreError> {
    core_services(&app)
        .terminal_manager
        .close_for(&connection, terminal_session_id)
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

        let session = open_terminal(&manager, connection.clone(), 80, 24)
            .await
            .unwrap();
        manager
            .resize_for(
                &connection,
                session.id(),
                PtySize::try_new(120, 40).unwrap(),
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn write_resize_and_close_helpers_scope_sessions_to_the_connection() {
        let backend = InMemoryShellBackend::new();
        let manager = TerminalManager::new(backend.clone());
        let owner = ConnectionHandle::new(Id::new(), Id::new());
        let other = ConnectionHandle::new(Id::new(), Id::new());
        manager.register_connection(&owner).await.unwrap();
        manager.register_connection(&other).await.unwrap();
        let session = open_terminal(&manager, owner.clone(), 80, 24)
            .await
            .unwrap();

        assert_eq!(
            manager
                .write_for(&other, session.id(), b"blocked")
                .await
                .unwrap_err()
                .code(),
            CoreErrorCode::NotFound
        );
        assert_eq!(
            manager
                .resize_for(&other, session.id(), PtySize::try_new(120, 40).unwrap())
                .await
                .unwrap_err()
                .code(),
            CoreErrorCode::NotFound
        );
        assert_eq!(
            manager
                .close_for(&other, session.id())
                .await
                .unwrap_err()
                .code(),
            CoreErrorCode::NotFound
        );
        assert!(backend.writes(session.id()).await.is_empty());
        assert!(backend.resizes(session.id()).await.is_empty());
        assert!(manager.active_session_ids().await.contains(&session.id()));
    }
}
