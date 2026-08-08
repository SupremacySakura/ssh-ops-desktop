use opspilot_domain::{CoreErrorCode, Id};
use opspilot_ssh_core::{
    ConnectionHandle, InMemoryShellBackend, PtySize, TerminalCommand, TerminalManager,
};

#[tokio::test]
async fn opens_a_validated_interactive_command_in_an_isolated_pty() {
    let backend = InMemoryShellBackend::new();
    let manager = TerminalManager::new(backend.clone());
    let connection = ConnectionHandle::new(Id::new(), Id::new());
    let session = manager
        .open_command(
            connection,
            PtySize::try_new(120, 32).unwrap(),
            TerminalCommand::try_new("docker exec -it -- web sh").unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(
        backend.command(session.id()).await.unwrap().as_str(),
        "docker exec -it -- web sh"
    );
    assert_eq!(
        TerminalCommand::try_new("docker exec\nwhoami")
            .unwrap_err()
            .code(),
        CoreErrorCode::Validation
    );
}

#[tokio::test]
async fn routes_bytes_and_resize_to_the_bound_channel_only() {
    let backend = InMemoryShellBackend::new();
    let manager = TerminalManager::new(backend.clone());
    let connection = ConnectionHandle::new(Id::new(), Id::new());
    let first = manager
        .open(connection.clone(), PtySize::try_new(80, 24).unwrap())
        .await
        .unwrap();
    let second = manager
        .open(connection, PtySize::try_new(120, 40).unwrap())
        .await
        .unwrap();

    manager.write(first.id(), b"uptime\n").await.unwrap();
    manager
        .resize(second.id(), PtySize::try_new(140, 50).unwrap())
        .await
        .unwrap();

    assert_eq!(backend.writes(first.id()).await, vec![b"uptime\n".to_vec()]);
    assert!(backend.writes(second.id()).await.is_empty());
    assert_eq!(
        backend.resizes(second.id()).await,
        vec![PtySize::try_new(140, 50).unwrap()]
    );
}

#[tokio::test]
async fn sequences_output_per_session_without_cross_streaming() {
    let backend = InMemoryShellBackend::new();
    let manager = TerminalManager::new(backend);
    let connection = ConnectionHandle::new(Id::new(), Id::new());
    let mut sessions = Vec::new();
    for _ in 0..100 {
        sessions.push(
            manager
                .open(connection.clone(), PtySize::try_new(80, 24).unwrap())
                .await
                .unwrap(),
        );
    }

    for (index, session) in sessions.iter().enumerate() {
        let event = manager
            .record_output(session.id(), format!("session-{index}").into_bytes())
            .await
            .unwrap();
        assert_eq!(event.terminal_session_id, session.id());
        assert_eq!(event.sequence, 1);
        assert_eq!(event.bytes, format!("session-{index}").into_bytes());
    }
    let second = manager
        .record_output(sessions[0].id(), b"second".to_vec())
        .await
        .unwrap();
    assert_eq!(second.sequence, 2);

    manager.close(sessions[0].id()).await.unwrap();
    manager.close(sessions[0].id()).await.unwrap();
    let error = manager
        .write(sessions[0].id(), b"after-close")
        .await
        .expect_err("closed sessions must reject input");
    assert_eq!(error.code(), CoreErrorCode::NotFound);
}

#[test]
fn rejects_unsafe_pty_sizes() {
    assert_eq!(
        PtySize::try_new(1, 24).unwrap_err().code(),
        CoreErrorCode::Validation
    );
    assert_eq!(
        PtySize::try_new(80, 1_001).unwrap_err().code(),
        CoreErrorCode::Validation
    );
}
