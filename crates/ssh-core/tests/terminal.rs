use std::sync::Arc;

use async_trait::async_trait;
use opspilot_domain::{CoreErrorCode, Id};
use opspilot_ssh_core::{
    ConnectionHandle, InMemoryShellBackend, PtySize, SHELL_EVENT_CHANNEL_CAPACITY, ShellBackend,
    ShellEventReceiver, TerminalCloseReason, TerminalClosed, TerminalCommand, TerminalData,
    TerminalEvent, TerminalGap, TerminalManager,
};
use tokio::sync::Semaphore;

#[derive(Clone)]
struct PausedBackend {
    inner: InMemoryShellBackend,
    started: Arc<Semaphore>,
    resume: Arc<Semaphore>,
}

impl PausedBackend {
    fn new() -> (Self, Arc<Semaphore>, Arc<Semaphore>) {
        let started = Arc::new(Semaphore::new(0));
        let resume = Arc::new(Semaphore::new(0));
        (
            Self {
                inner: InMemoryShellBackend::new(),
                started: started.clone(),
                resume: resume.clone(),
            },
            started,
            resume,
        )
    }

    async fn pause(&self) {
        self.started.add_permits(1);
        let permit = self
            .resume
            .acquire()
            .await
            .expect("the test must release the paused backend");
        permit.forget();
    }
}

#[async_trait]
impl ShellBackend for PausedBackend {
    async fn open(
        &self,
        session_id: Id,
        connection: &ConnectionHandle,
        size: PtySize,
    ) -> Result<ShellEventReceiver, opspilot_domain::CoreError> {
        self.pause().await;
        self.inner.open(session_id, connection, size).await
    }

    async fn open_command(
        &self,
        session_id: Id,
        connection: &ConnectionHandle,
        size: PtySize,
        command: &TerminalCommand,
    ) -> Result<ShellEventReceiver, opspilot_domain::CoreError> {
        self.pause().await;
        self.inner
            .open_command(session_id, connection, size, command)
            .await
    }

    async fn write(&self, session_id: Id, bytes: &[u8]) -> Result<(), opspilot_domain::CoreError> {
        self.inner.write(session_id, bytes).await
    }

    async fn resize(
        &self,
        session_id: Id,
        size: PtySize,
    ) -> Result<(), opspilot_domain::CoreError> {
        self.inner.resize(session_id, size).await
    }

    async fn close(&self, session_id: Id) -> Result<(), opspilot_domain::CoreError> {
        self.inner.close(session_id).await
    }
}

async fn register(manager: &TerminalManager<InMemoryShellBackend>, connection: &ConnectionHandle) {
    manager
        .register_connection(connection)
        .await
        .expect("fixture connection should register");
}

#[tokio::test]
async fn opens_a_validated_interactive_command_in_an_isolated_pty() {
    let backend = InMemoryShellBackend::new();
    let manager = TerminalManager::new(backend.clone());
    let connection = ConnectionHandle::new(Id::new(), Id::new());
    register(&manager, &connection).await;
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
    register(&manager, &connection).await;
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
async fn sequences_output_per_session_and_keeps_sessions_isolated() {
    let backend = InMemoryShellBackend::new();
    let manager = TerminalManager::new(backend.clone());
    let connection = ConnectionHandle::new(Id::new(), Id::new());
    register(&manager, &connection).await;
    let first = manager
        .open(connection.clone(), PtySize::try_new(80, 24).unwrap())
        .await
        .unwrap();
    let second = manager
        .open(connection, PtySize::try_new(80, 24).unwrap())
        .await
        .unwrap();
    let mut events = manager.subscribe();

    backend
        .emit_data(first.id(), b"first-session".to_vec())
        .await
        .unwrap();
    backend
        .emit_data(first.id(), b"second-block".to_vec())
        .await
        .unwrap();
    backend
        .emit_data(second.id(), b"only-second".to_vec())
        .await
        .unwrap();

    let first_event = events.recv().await.unwrap();
    assert!(matches!(
        &first_event,
        TerminalEvent::Data(data)
            if data.terminal_session_id == first.id()
                && data.sequence == 1
                && data.bytes == b"first-session"
    ));
    let second_event = events.recv().await.unwrap();
    assert!(matches!(
        &second_event,
        TerminalEvent::Data(data)
            if data.terminal_session_id == first.id()
                && data.sequence == 2
                && data.bytes == b"second-block"
    ));
    let third_event = events.recv().await.unwrap();
    assert!(matches!(
        &third_event,
        TerminalEvent::Data(data)
            if data.terminal_session_id == second.id()
                && data.sequence == 1
                && data.bytes == b"only-second"
    ));
}

#[tokio::test]
async fn enforces_eight_sessions_per_server_across_connections() {
    let backend = InMemoryShellBackend::new();
    let manager = TerminalManager::new(backend);
    let server_id = Id::new();
    let first_connection = ConnectionHandle::new(server_id, Id::new());
    let second_connection = ConnectionHandle::new(server_id, Id::new());
    register(&manager, &first_connection).await;
    register(&manager, &second_connection).await;

    for index in 0..8 {
        let connection = if index % 2 == 0 {
            first_connection.clone()
        } else {
            second_connection.clone()
        };
        manager
            .open(connection, PtySize::try_new(80, 24).unwrap())
            .await
            .expect("first eight server sessions should open");
    }

    let error = manager
        .open(first_connection.clone(), PtySize::try_new(80, 24).unwrap())
        .await
        .expect_err("the ninth session on the same server must be rejected");
    assert_eq!(error.code(), CoreErrorCode::Conflict);

    let other_server = ConnectionHandle::new(Id::new(), Id::new());
    register(&manager, &other_server).await;
    manager
        .open(other_server, PtySize::try_new(80, 24).unwrap())
        .await
        .expect("the limit is scoped to one server");
}

#[tokio::test]
async fn rejects_unregistered_connections_and_server_mismatches() {
    let manager = TerminalManager::new(InMemoryShellBackend::new());
    let server_id = Id::new();
    let connection = ConnectionHandle::new(server_id, Id::new());
    let unregistered = manager
        .open(connection.clone(), PtySize::try_new(80, 24).unwrap())
        .await
        .expect_err("opening on an unknown connection must fail closed");
    assert_eq!(unregistered.code(), CoreErrorCode::NotFound);

    register(&manager, &connection).await;
    let mismatched = ConnectionHandle::new(Id::new(), connection.connection_id());
    let error = manager
        .open(mismatched, PtySize::try_new(80, 24).unwrap())
        .await
        .expect_err("a handle cannot relabel its connection with another server");
    assert_eq!(error.code(), CoreErrorCode::Conflict);
}

#[tokio::test]
async fn rejects_writes_above_one_mebibyte_without_reaching_the_shell() {
    let backend = InMemoryShellBackend::new();
    let manager = TerminalManager::new(backend.clone());
    let connection = ConnectionHandle::new(Id::new(), Id::new());
    register(&manager, &connection).await;
    let session = manager
        .open(connection, PtySize::try_new(80, 24).unwrap())
        .await
        .unwrap();

    let error = manager
        .write(session.id(), &vec![b'x'; 1024 * 1024 + 1])
        .await
        .expect_err("oversize terminal writes must be rejected");
    assert_eq!(error.code(), CoreErrorCode::Validation);
    assert!(backend.writes(session.id()).await.is_empty());
}

#[tokio::test]
async fn backend_close_removes_the_session_and_emits_a_reason() {
    let backend = InMemoryShellBackend::new();
    let manager = TerminalManager::new(backend.clone());
    let connection = ConnectionHandle::new(Id::new(), Id::new());
    register(&manager, &connection).await;
    let session = manager
        .open(connection, PtySize::try_new(80, 24).unwrap())
        .await
        .unwrap();
    let mut events = manager.subscribe();

    backend.emit_closed(session.id(), Some(0)).await.unwrap();
    let event = events.recv().await.unwrap();
    assert!(matches!(
        event,
        TerminalEvent::Closed(closed)
            if closed.terminal_session_id == session.id()
                && closed.exit_status == Some(0)
    ));

    let error = manager
        .write(session.id(), b"after-close")
        .await
        .expect_err("closed sessions must reject input");
    assert_eq!(error.code(), CoreErrorCode::NotFound);
}

#[tokio::test]
async fn closing_a_connection_cleans_up_all_of_its_sessions() {
    let backend = InMemoryShellBackend::new();
    let manager = TerminalManager::new(backend.clone());
    let connection = ConnectionHandle::new(Id::new(), Id::new());
    register(&manager, &connection).await;
    let first = manager
        .open(connection.clone(), PtySize::try_new(80, 24).unwrap())
        .await
        .unwrap();
    let second = manager
        .open(connection.clone(), PtySize::try_new(80, 24).unwrap())
        .await
        .unwrap();
    let mut events = manager.subscribe();

    let closed = manager.close_connection(&connection).await.unwrap();
    assert_eq!(closed, 2);
    assert!(matches!(
        events.recv().await.unwrap(),
        TerminalEvent::Closed(evented) if evented.reason == TerminalCloseReason::ConnectionClosed
    ));
    assert!(matches!(
        events.recv().await.unwrap(),
        TerminalEvent::Closed(evented) if evented.reason == TerminalCloseReason::ConnectionClosed
    ));
    for session in [first, second] {
        let error = manager
            .write(session.id(), b"after-disconnect")
            .await
            .expect_err("closed connection sessions must be gone");
        assert_eq!(error.code(), CoreErrorCode::NotFound);
    }
    let error = manager
        .open(connection, PtySize::try_new(80, 24).unwrap())
        .await
        .expect_err("a closed connection must not accept new sessions");
    assert_eq!(error.code(), CoreErrorCode::NotFound);
}

#[tokio::test]
async fn connection_close_attempts_every_session_and_keeps_unclosed_state_retryable() {
    let backend = InMemoryShellBackend::new();
    let manager = TerminalManager::new(backend.clone());
    let connection = ConnectionHandle::new(Id::new(), Id::new());
    register(&manager, &connection).await;
    let first = manager
        .open(connection.clone(), PtySize::try_new(80, 24).unwrap())
        .await
        .unwrap();
    let second = manager
        .open(connection.clone(), PtySize::try_new(80, 24).unwrap())
        .await
        .unwrap();
    backend.fail_next_closes(1).await;

    let error = manager
        .close_connection(&connection)
        .await
        .expect_err("one failed channel close must be reported");
    assert_eq!(error.code(), CoreErrorCode::SshConnection);

    let mut open_sessions = 0;
    for session in [first, second] {
        if manager.write(session.id(), b"retry\n").await.is_ok() {
            open_sessions += 1;
        }
    }
    assert_eq!(
        open_sessions, 1,
        "successful siblings must close while the failed channel remains retryable"
    );
    assert_eq!(manager.close_connection(&connection).await.unwrap(), 1);
    assert!(!manager.is_connection_registered(&connection).await);
}

#[tokio::test]
async fn close_all_keeps_failed_sessions_and_connection_registration() {
    let backend = InMemoryShellBackend::new();
    let manager = TerminalManager::new(backend.clone());
    let connection = ConnectionHandle::new(Id::new(), Id::new());
    register(&manager, &connection).await;
    let first = manager
        .open(connection.clone(), PtySize::try_new(80, 24).unwrap())
        .await
        .unwrap();
    let second = manager
        .open(connection.clone(), PtySize::try_new(80, 24).unwrap())
        .await
        .unwrap();
    backend.fail_next_closes(1).await;

    manager
        .close_all()
        .await
        .expect_err("shutdown close must report a failed channel");

    let mut open_sessions = 0;
    for session in [first, second] {
        if manager.write(session.id(), b"retry\n").await.is_ok() {
            open_sessions += 1;
        }
    }
    assert_eq!(open_sessions, 1);
    assert!(manager.is_connection_registered(&connection).await);
}

#[tokio::test]
async fn discard_all_forces_shutdown_cleanup_after_close_failures() {
    let backend = InMemoryShellBackend::new();
    let manager = TerminalManager::new(backend.clone());
    let connection = ConnectionHandle::new(Id::new(), Id::new());
    register(&manager, &connection).await;
    let first = manager
        .open(connection.clone(), PtySize::try_new(80, 24).unwrap())
        .await
        .unwrap();
    let second = manager
        .open(connection.clone(), PtySize::try_new(80, 24).unwrap())
        .await
        .unwrap();
    let mut events = manager.subscribe();
    backend.fail_next_closes(1).await;
    manager.close_all().await.unwrap_err();

    assert_eq!(manager.discard_all().await, 1);
    assert!(manager.active_session_ids().await.is_empty());
    assert!(!manager.is_connection_registered(&connection).await);
    for _ in 0..2 {
        assert!(matches!(
            events.recv().await.unwrap(),
            TerminalEvent::Closed(_)
        ));
    }
    for session in [first, second] {
        assert_eq!(
            manager
                .write(session.id(), b"after-shutdown")
                .await
                .unwrap_err()
                .code(),
            CoreErrorCode::NotFound
        );
    }
}

#[tokio::test]
async fn transport_disconnect_can_force_cleanup_after_a_channel_close_failure() {
    let backend = InMemoryShellBackend::new();
    let manager = TerminalManager::new(backend.clone());
    let connection = ConnectionHandle::new(Id::new(), Id::new());
    register(&manager, &connection).await;
    let first = manager
        .open(connection.clone(), PtySize::try_new(80, 24).unwrap())
        .await
        .unwrap();
    let second = manager
        .open(connection.clone(), PtySize::try_new(80, 24).unwrap())
        .await
        .unwrap();
    backend.fail_next_closes(1).await;

    manager
        .close_connection(&connection)
        .await
        .expect_err("the failed channel must remain visible before transport teardown");
    assert_eq!(manager.discard_connection(&connection).await, 1);
    assert!(!manager.is_connection_registered(&connection).await);
    assert!(manager.active_session_ids().await.is_empty());

    for session in [first, second] {
        let error = manager
            .write(session.id(), b"after-transport-close")
            .await
            .expect_err("transport teardown must remove every terminal session");
        assert_eq!(error.code(), CoreErrorCode::NotFound);
    }
}

#[tokio::test]
async fn a_late_reader_close_does_not_duplicate_a_forced_terminal_close() {
    let backend = InMemoryShellBackend::new();
    let manager = TerminalManager::new(backend.clone());
    let connection = ConnectionHandle::new(Id::new(), Id::new());
    register(&manager, &connection).await;
    manager
        .open(connection.clone(), PtySize::try_new(80, 24).unwrap())
        .await
        .unwrap();
    manager
        .open(connection.clone(), PtySize::try_new(80, 24).unwrap())
        .await
        .unwrap();
    let mut events = manager.subscribe();
    backend.fail_next_closes(1).await;

    manager.close_connection(&connection).await.unwrap_err();
    let remaining = manager.active_session_ids().await;
    assert_eq!(remaining.len(), 1);
    assert_eq!(manager.discard_connection(&connection).await, 1);
    for _ in 0..2 {
        assert!(matches!(
            events.recv().await.unwrap(),
            TerminalEvent::Closed(_)
        ));
    }

    backend.emit_closed(remaining[0], None).await.unwrap();
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(50), events.recv())
            .await
            .is_err(),
        "a reader close after forced cleanup must not emit a duplicate close"
    );
}

#[tokio::test]
async fn retains_an_early_close_when_a_later_burst_exceeds_the_old_bus_capacity() {
    let backend = InMemoryShellBackend::new();
    let manager = TerminalManager::new(backend);
    let connection = ConnectionHandle::new(Id::new(), Id::new());
    register(&manager, &connection).await;
    let first = manager
        .open(connection.clone(), PtySize::try_new(80, 24).unwrap())
        .await
        .unwrap();
    let mut events = manager.subscribe();
    let flood = SHELL_EVENT_CHANNEL_CAPACITY + 64;
    let consumer = tokio::spawn(async move {
        let mut received = Vec::new();
        for _ in 0..=flood {
            let Some(event) = events.recv().await else {
                break;
            };
            received.push(event);
        }
        received
    });

    manager.close(first.id()).await.unwrap();
    for _ in 0..flood {
        let session = manager
            .open(connection.clone(), PtySize::try_new(80, 24).unwrap())
            .await
            .unwrap();
        manager.close(session.id()).await.unwrap();
    }

    let events = tokio::time::timeout(std::time::Duration::from_secs(2), consumer)
        .await
        .expect("the bounded terminal queue should drain while the bridge is active")
        .unwrap();
    assert_eq!(events.len(), flood + 1);
    assert!(events.iter().any(|event| matches!(
        event,
        TerminalEvent::Closed(closed) if closed.terminal_session_id == first.id()
    )));
}

#[tokio::test]
async fn reports_a_gap_before_the_terminal_close_after_an_output_burst() {
    let backend = InMemoryShellBackend::new();
    let manager = TerminalManager::new(backend.clone());
    let connection = ConnectionHandle::new(Id::new(), Id::new());
    register(&manager, &connection).await;
    let session = manager
        .open(connection, PtySize::try_new(80, 24).unwrap())
        .await
        .unwrap();
    let mut events = manager.subscribe();

    for _ in 0..(SHELL_EVENT_CHANNEL_CAPACITY * 2) {
        backend
            .emit_data(session.id(), vec![b'x'; 32])
            .await
            .unwrap();
    }
    backend.emit_closed(session.id(), Some(0)).await.unwrap();

    let (saw_gap, saw_close) = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        let mut saw_gap = false;
        loop {
            match events.recv().await {
                Some(TerminalEvent::Gap(_)) => saw_gap = true,
                Some(TerminalEvent::Closed(closed)) => {
                    assert_eq!(closed.terminal_session_id, session.id());
                    break (saw_gap, true);
                }
                Some(TerminalEvent::Data(_)) => continue,
                None => break (saw_gap, false),
            }
        }
    })
    .await
    .expect("the bounded bridge must drain the output burst and its close");

    assert!(saw_gap, "dropped terminal output must be reported");
    assert!(saw_close, "the terminal close must follow the gap");
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(50), events.recv())
            .await
            .is_err(),
        "a terminal close must be the final event for its session"
    );
}

#[tokio::test]
async fn disconnecting_a_connection_waits_for_an_in_flight_terminal_open() {
    let (backend, started, resume) = PausedBackend::new();
    let manager = TerminalManager::new(backend);
    let connection = ConnectionHandle::new(Id::new(), Id::new());
    manager
        .register_connection(&connection)
        .await
        .expect("fixture connection should register");

    let opener = {
        let manager = manager.clone();
        let connection = connection.clone();
        tokio::spawn(async move {
            manager
                .open(connection, PtySize::try_new(80, 24).unwrap())
                .await
        })
    };
    let permit = started
        .acquire()
        .await
        .expect("terminal open should reach the paused backend");
    permit.forget();
    let mut closer = {
        let manager = manager.clone();
        let connection = connection.clone();
        tokio::spawn(async move { manager.close_connection(&connection).await })
    };

    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(50), &mut closer)
            .await
            .is_err(),
        "connection teardown must wait for the in-flight terminal open"
    );
    resume.add_permits(1);

    let opened = opener
        .await
        .unwrap()
        .expect("the terminal should finish opening");
    assert_eq!(
        tokio::time::timeout(std::time::Duration::from_secs(1), closer)
            .await
            .expect("connection teardown should resume after open")
            .unwrap()
            .unwrap(),
        1
    );
    assert!(
        manager
            .write(opened.id(), b"must-not-reach-closed-channel")
            .await
            .is_err()
    );
    assert!(!manager.is_connection_registered(&connection).await);
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

#[test]
fn terminal_events_serialize_with_the_frontend_camel_case_contract() {
    let session_id = Id::new();
    assert_eq!(
        serde_json::to_value(TerminalData {
            terminal_session_id: session_id,
            sequence: 7,
            bytes: vec![65, 66],
        })
        .unwrap(),
        serde_json::json!({
            "terminalSessionId": session_id,
            "sequence": 7,
            "bytes": [65, 66],
        })
    );
    assert_eq!(
        serde_json::to_value(TerminalGap {
            terminal_session_id: session_id,
            missed: 3,
        })
        .unwrap(),
        serde_json::json!({
            "terminalSessionId": session_id,
            "missed": 3,
        })
    );
    assert_eq!(
        serde_json::to_value(TerminalClosed {
            terminal_session_id: session_id,
            reason: TerminalCloseReason::RemoteExit,
            exit_status: Some(127),
        })
        .unwrap(),
        serde_json::json!({
            "terminalSessionId": session_id,
            "reason": "remoteExit",
            "exitStatus": 127,
        })
    );
    assert_eq!(
        serde_json::to_value(TerminalClosed {
            terminal_session_id: session_id,
            reason: TerminalCloseReason::ConnectionClosed,
            exit_status: None,
        })
        .unwrap(),
        serde_json::json!({
            "terminalSessionId": session_id,
            "reason": "connectionClosed",
        })
    );
}
