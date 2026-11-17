use std::{
    collections::HashMap,
    sync::{Arc, Mutex as StdMutex},
};

use async_trait::async_trait;
use opspilot_domain::{CoreError, CoreErrorCode, Id};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, broadcast, mpsc};

pub const MAX_TERMINAL_SESSIONS_PER_SERVER: usize = 8;
pub const MAX_TERMINAL_WRITE_BYTES: usize = 1024 * 1024;
pub const SHELL_EVENT_CHANNEL_CAPACITY: usize = 512;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionHandle {
    server_id: Id,
    connection_id: Id,
}

impl ConnectionHandle {
    pub fn new(server_id: Id, connection_id: Id) -> Self {
        Self {
            server_id,
            connection_id,
        }
    }

    pub fn server_id(&self) -> Id {
        self.server_id
    }

    pub fn connection_id(&self) -> Id {
        self.connection_id
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PtySize {
    columns: u16,
    rows: u16,
}

impl PtySize {
    pub fn try_new(columns: u32, rows: u32) -> Result<Self, CoreError> {
        if !(2..=1_000).contains(&columns) || !(2..=1_000).contains(&rows) {
            return Err(validation(
                "PTY rows and columns must be between 2 and 1000",
            ));
        }
        Ok(Self {
            columns: columns as u16,
            rows: rows as u16,
        })
    }

    pub fn columns(self) -> u16 {
        self.columns
    }

    pub fn rows(self) -> u16 {
        self.rows
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TerminalCommand(String);

impl TerminalCommand {
    pub fn try_new(value: impl Into<String>) -> Result<Self, CoreError> {
        let value = value.into();
        if value.is_empty()
            || value.len() > 4_096
            || value
                .chars()
                .any(|character| character == '\0' || character == '\n' || character == '\r')
        {
            return Err(validation("terminal command is invalid"));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSession {
    id: Id,
    connection: ConnectionHandle,
}

impl TerminalSession {
    pub fn id(&self) -> Id {
        self.id
    }

    pub fn connection(&self) -> &ConnectionHandle {
        &self.connection
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalData {
    pub terminal_session_id: Id,
    pub sequence: u64,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalGap {
    pub terminal_session_id: Id,
    pub missed: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TerminalCloseReason {
    RemoteExit,
    Disconnected,
    Closed,
    ConnectionClosed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalClosed {
    pub terminal_session_id: Id,
    pub reason: TerminalCloseReason,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_status: Option<u32>,
}

#[derive(Clone, Debug)]
pub enum TerminalEvent {
    Data(TerminalData),
    Gap(TerminalGap),
    Closed(TerminalClosed),
}

#[derive(Clone, Debug)]
pub enum ShellEvent {
    Data { bytes: Vec<u8> },
    Closed { exit_status: Option<u32> },
}

pub type ShellEventReceiver = broadcast::Receiver<ShellEvent>;

#[async_trait]
pub trait ShellBackend: Clone + Send + Sync + 'static {
    async fn open(
        &self,
        session_id: Id,
        connection: &ConnectionHandle,
        size: PtySize,
    ) -> Result<ShellEventReceiver, CoreError>;
    async fn open_command(
        &self,
        session_id: Id,
        connection: &ConnectionHandle,
        size: PtySize,
        command: &TerminalCommand,
    ) -> Result<ShellEventReceiver, CoreError>;
    async fn write(&self, session_id: Id, bytes: &[u8]) -> Result<(), CoreError>;
    async fn resize(&self, session_id: Id, size: PtySize) -> Result<(), CoreError>;
    async fn close(&self, session_id: Id) -> Result<(), CoreError>;
}

#[derive(Clone, Debug)]
struct SessionState {
    session: TerminalSession,
    sequence: u64,
}

#[derive(Clone)]
pub struct TerminalManager<B> {
    backend: B,
    sessions: Arc<Mutex<HashMap<Id, SessionState>>>,
    connections: Arc<Mutex<HashMap<Id, Id>>>,
    events: mpsc::UnboundedSender<TerminalEvent>,
    event_receiver: Arc<StdMutex<Option<mpsc::UnboundedReceiver<TerminalEvent>>>>,
}

impl<B> TerminalManager<B>
where
    B: ShellBackend,
{
    pub fn new(backend: B) -> Self {
        let (events, event_receiver) = mpsc::unbounded_channel();
        Self {
            backend,
            sessions: Arc::new(Mutex::new(HashMap::new())),
            connections: Arc::new(Mutex::new(HashMap::new())),
            events,
            event_receiver: Arc::new(StdMutex::new(Some(event_receiver))),
        }
    }

    pub fn subscribe(&self) -> mpsc::UnboundedReceiver<TerminalEvent> {
        self.event_receiver
            .lock()
            .expect("terminal event receiver lock poisoned")
            .take()
            .expect("terminal events support exactly one subscriber")
    }

    pub async fn register_connection(
        &self,
        connection: &ConnectionHandle,
    ) -> Result<(), CoreError> {
        let mut connections = self.connections.lock().await;
        match connections.get(&connection.connection_id()) {
            Some(server_id) if *server_id == connection.server_id() => Ok(()),
            Some(_) => Err(CoreError::new(
                CoreErrorCode::Conflict,
                "SSH connection handle does not match its registered server",
                false,
            )),
            None => {
                connections.insert(connection.connection_id(), connection.server_id());
                Ok(())
            }
        }
    }

    pub async fn is_connection_registered(&self, connection: &ConnectionHandle) -> bool {
        self.connections
            .lock()
            .await
            .get(&connection.connection_id())
            .is_some_and(|server_id| *server_id == connection.server_id())
    }

    pub async fn open(
        &self,
        connection: ConnectionHandle,
        size: PtySize,
    ) -> Result<TerminalSession, CoreError> {
        self.open_session(connection, size, None).await
    }

    pub async fn open_command(
        &self,
        connection: ConnectionHandle,
        size: PtySize,
        command: TerminalCommand,
    ) -> Result<TerminalSession, CoreError> {
        self.open_session(connection, size, Some(&command)).await
    }

    async fn open_session(
        &self,
        connection: ConnectionHandle,
        size: PtySize,
        command: Option<&TerminalCommand>,
    ) -> Result<TerminalSession, CoreError> {
        self.require_registered_connection(&connection).await?;
        let session = TerminalSession {
            id: Id::new(),
            connection,
        };
        {
            let mut sessions = self.sessions.lock().await;
            let session_count = sessions
                .values()
                .filter(|state| state.session.connection.server_id == session.connection.server_id)
                .count();
            if session_count >= MAX_TERMINAL_SESSIONS_PER_SERVER {
                return Err(CoreError::new(
                    CoreErrorCode::Conflict,
                    format!(
                        "each server supports at most {MAX_TERMINAL_SESSIONS_PER_SERVER} concurrent terminal sessions"
                    ),
                    false,
                ));
            }
            sessions.insert(
                session.id,
                SessionState {
                    session: session.clone(),
                    sequence: 0,
                },
            );
        }

        let events = match command {
            Some(command) => {
                self.backend
                    .open_command(session.id, &session.connection, size, command)
                    .await
            }
            None => {
                self.backend
                    .open(session.id, &session.connection, size)
                    .await
            }
        };
        let events = match events {
            Ok(events) => events,
            Err(error) => {
                self.sessions.lock().await.remove(&session.id);
                return Err(error);
            }
        };
        self.forward_events(session.id, events);
        Ok(session)
    }

    pub async fn write(&self, session_id: Id, bytes: &[u8]) -> Result<(), CoreError> {
        if bytes.len() > MAX_TERMINAL_WRITE_BYTES {
            return Err(validation(
                "terminal write exceeds the 1 MiB per-request limit",
            ));
        }
        self.require_session(session_id).await?;
        self.backend.write(session_id, bytes).await
    }

    pub async fn resize(&self, session_id: Id, size: PtySize) -> Result<(), CoreError> {
        self.require_session(session_id).await?;
        self.backend.resize(session_id, size).await
    }

    pub async fn close(&self, session_id: Id) -> Result<(), CoreError> {
        self.close_with_reason(session_id, TerminalCloseReason::Closed)
            .await
    }

    pub async fn close_connection(
        &self,
        connection: &ConnectionHandle,
    ) -> Result<usize, CoreError> {
        self.require_registered_connection(connection).await?;
        let session_ids = {
            let sessions = self.sessions.lock().await;
            sessions
                .values()
                .filter(|state| state.session.connection == *connection)
                .map(|state| state.session.id)
                .collect::<Vec<_>>()
        };
        let mut first_error = None;
        let mut closed = 0;
        for session_id in &session_ids {
            match self
                .close_with_reason(*session_id, TerminalCloseReason::ConnectionClosed)
                .await
            {
                Ok(()) => closed += 1,
                Err(error) => {
                    if first_error.is_none() {
                        first_error = Some(error);
                    }
                }
            }
        }
        if let Some(error) = first_error {
            return Err(error);
        }
        self.connections
            .lock()
            .await
            .remove(&connection.connection_id());
        Ok(closed)
    }

    pub async fn discard_connection(&self, connection: &ConnectionHandle) -> usize {
        let session_ids = {
            let mut sessions = self.sessions.lock().await;
            let session_ids = sessions
                .values()
                .filter(|state| state.session.connection == *connection)
                .map(|state| state.session.id)
                .collect::<Vec<_>>();
            for session_id in &session_ids {
                sessions.remove(session_id);
            }
            session_ids
        };
        for session_id in &session_ids {
            self.emit_closed(*session_id, TerminalCloseReason::ConnectionClosed, None);
        }

        let mut connections = self.connections.lock().await;
        if connections.get(&connection.connection_id()) == Some(&connection.server_id()) {
            connections.remove(&connection.connection_id());
        }
        session_ids.len()
    }

    pub async fn close_all(&self) -> Result<usize, CoreError> {
        let session_ids = self
            .sessions
            .lock()
            .await
            .keys()
            .copied()
            .collect::<Vec<_>>();
        let mut first_error = None;
        let mut closed = 0;
        for session_id in &session_ids {
            match self.backend.close(*session_id).await {
                Ok(()) => {
                    if self.sessions.lock().await.remove(session_id).is_some() {
                        self.emit_closed(*session_id, TerminalCloseReason::ConnectionClosed, None);
                        closed += 1;
                    }
                }
                Err(error) => {
                    if first_error.is_none() {
                        first_error = Some(error);
                    }
                }
            }
        }
        if let Some(error) = first_error {
            return Err(error);
        }
        self.connections.lock().await.clear();
        Ok(closed)
    }

    pub async fn active_session_ids(&self) -> Vec<Id> {
        self.sessions.lock().await.keys().copied().collect()
    }

    pub async fn connection_for_session(&self, session_id: Id) -> Option<ConnectionHandle> {
        self.sessions
            .lock()
            .await
            .get(&session_id)
            .map(|state| state.session.connection.clone())
    }

    async fn close_with_reason(
        &self,
        session_id: Id,
        reason: TerminalCloseReason,
    ) -> Result<(), CoreError> {
        let exists = self.sessions.lock().await.contains_key(&session_id);
        if !exists {
            return Ok(());
        }
        self.backend.close(session_id).await?;
        if self.sessions.lock().await.remove(&session_id).is_some() {
            self.emit_closed(session_id, reason, None);
        }
        Ok(())
    }

    fn forward_events(&self, session_id: Id, mut receiver: ShellEventReceiver) {
        let sessions = self.sessions.clone();
        let events = self.events.clone();
        tokio::spawn(async move {
            loop {
                match receiver.recv().await {
                    Ok(ShellEvent::Data { bytes }) => {
                        let mut sessions = sessions.lock().await;
                        let Some(state) = sessions.get_mut(&session_id) else {
                            break;
                        };
                        let Some(sequence) = state.sequence.checked_add(1) else {
                            sessions.remove(&session_id);
                            break;
                        };
                        state.sequence = sequence;
                        let _ = events.send(TerminalEvent::Data(TerminalData {
                            terminal_session_id: session_id,
                            sequence,
                            bytes,
                        }));
                    }
                    Ok(ShellEvent::Closed { exit_status }) => {
                        if sessions.lock().await.remove(&session_id).is_none() {
                            break;
                        }
                        let reason = if exit_status.is_some() {
                            TerminalCloseReason::RemoteExit
                        } else {
                            TerminalCloseReason::Disconnected
                        };
                        let _ = events.send(TerminalEvent::Closed(TerminalClosed {
                            terminal_session_id: session_id,
                            reason,
                            exit_status,
                        }));
                        break;
                    }
                    Err(broadcast::error::RecvError::Lagged(missed)) => {
                        let _ = events.send(TerminalEvent::Gap(TerminalGap {
                            terminal_session_id: session_id,
                            missed,
                        }));
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    fn emit_closed(&self, session_id: Id, reason: TerminalCloseReason, exit_status: Option<u32>) {
        let _ = self.events.send(TerminalEvent::Closed(TerminalClosed {
            terminal_session_id: session_id,
            reason,
            exit_status,
        }));
    }

    async fn require_registered_connection(
        &self,
        connection: &ConnectionHandle,
    ) -> Result<(), CoreError> {
        match self
            .connections
            .lock()
            .await
            .get(&connection.connection_id())
        {
            Some(server_id) if *server_id == connection.server_id() => Ok(()),
            Some(_) => Err(CoreError::new(
                CoreErrorCode::Conflict,
                "SSH connection handle does not match its registered server",
                false,
            )),
            None => Err(not_found("SSH connection")),
        }
    }

    async fn require_session(&self, session_id: Id) -> Result<(), CoreError> {
        if self.sessions.lock().await.contains_key(&session_id) {
            Ok(())
        } else {
            Err(not_found("terminal session"))
        }
    }
}

#[derive(Clone, Default)]
pub struct InMemoryShellBackend {
    writes: Arc<Mutex<HashMap<Id, Vec<Vec<u8>>>>>,
    resizes: Arc<Mutex<HashMap<Id, Vec<PtySize>>>>,
    commands: Arc<Mutex<HashMap<Id, Option<TerminalCommand>>>>,
    event_senders: Arc<Mutex<HashMap<Id, broadcast::Sender<ShellEvent>>>>,
    close_failures: Arc<Mutex<usize>>,
}

impl InMemoryShellBackend {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn writes(&self, session_id: Id) -> Vec<Vec<u8>> {
        self.writes
            .lock()
            .await
            .get(&session_id)
            .cloned()
            .unwrap_or_default()
    }

    pub async fn resizes(&self, session_id: Id) -> Vec<PtySize> {
        self.resizes
            .lock()
            .await
            .get(&session_id)
            .cloned()
            .unwrap_or_default()
    }

    pub async fn command(&self, session_id: Id) -> Option<TerminalCommand> {
        self.commands
            .lock()
            .await
            .get(&session_id)
            .cloned()
            .flatten()
    }

    pub async fn emit_data(&self, session_id: Id, bytes: Vec<u8>) -> Result<(), CoreError> {
        let sender = self
            .event_senders
            .lock()
            .await
            .get(&session_id)
            .cloned()
            .ok_or_else(|| not_found("shell channel"))?;
        sender
            .send(ShellEvent::Data { bytes })
            .map(|_| ())
            .map_err(|_| not_found("shell output receiver"))
    }

    pub async fn emit_closed(
        &self,
        session_id: Id,
        exit_status: Option<u32>,
    ) -> Result<(), CoreError> {
        let sender = self
            .event_senders
            .lock()
            .await
            .remove(&session_id)
            .ok_or_else(|| not_found("shell channel"))?;
        sender
            .send(ShellEvent::Closed { exit_status })
            .map(|_| ())
            .map_err(|_| not_found("shell output receiver"))
    }

    pub async fn fail_next_closes(&self, count: usize) {
        *self.close_failures.lock().await = count;
    }

    async fn open_fixture(
        &self,
        session_id: Id,
        command: Option<TerminalCommand>,
    ) -> ShellEventReceiver {
        let (sender, receiver) = broadcast::channel(SHELL_EVENT_CHANNEL_CAPACITY);
        self.writes.lock().await.insert(session_id, Vec::new());
        self.resizes.lock().await.insert(session_id, Vec::new());
        self.commands.lock().await.insert(session_id, command);
        self.event_senders.lock().await.insert(session_id, sender);
        receiver
    }
}

#[async_trait]
impl ShellBackend for InMemoryShellBackend {
    async fn open(
        &self,
        session_id: Id,
        _connection: &ConnectionHandle,
        _size: PtySize,
    ) -> Result<ShellEventReceiver, CoreError> {
        Ok(self.open_fixture(session_id, None).await)
    }

    async fn open_command(
        &self,
        session_id: Id,
        _connection: &ConnectionHandle,
        _size: PtySize,
        command: &TerminalCommand,
    ) -> Result<ShellEventReceiver, CoreError> {
        Ok(self.open_fixture(session_id, Some(command.clone())).await)
    }

    async fn write(&self, session_id: Id, bytes: &[u8]) -> Result<(), CoreError> {
        self.writes
            .lock()
            .await
            .get_mut(&session_id)
            .ok_or_else(|| not_found("shell channel"))?
            .push(bytes.to_vec());
        Ok(())
    }

    async fn resize(&self, session_id: Id, size: PtySize) -> Result<(), CoreError> {
        self.resizes
            .lock()
            .await
            .get_mut(&session_id)
            .ok_or_else(|| not_found("shell channel"))?
            .push(size);
        Ok(())
    }

    async fn close(&self, session_id: Id) -> Result<(), CoreError> {
        {
            let mut failures = self.close_failures.lock().await;
            if *failures > 0 {
                *failures -= 1;
                return Err(CoreError::new(
                    CoreErrorCode::SshConnection,
                    "fixture terminal close failure",
                    true,
                ));
            }
        }
        self.writes.lock().await.remove(&session_id);
        self.resizes.lock().await.remove(&session_id);
        self.commands.lock().await.remove(&session_id);
        self.event_senders.lock().await.remove(&session_id);
        Ok(())
    }
}

fn validation(message: &str) -> CoreError {
    CoreError::new(CoreErrorCode::Validation, message, false)
}

fn not_found(resource: &str) -> CoreError {
    CoreError::new(
        CoreErrorCode::NotFound,
        format!("{resource} was not found"),
        false,
    )
}
