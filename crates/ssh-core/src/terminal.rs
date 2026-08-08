use std::{collections::HashMap, sync::Arc};

use async_trait::async_trait;
use opspilot_domain::{CoreError, CoreErrorCode, Id};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

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
    pub columns: u16,
    pub rows: u16,
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
            return Err(CoreError::new(
                CoreErrorCode::Validation,
                "terminal command is invalid",
                false,
            ));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl PtySize {
    pub fn try_new(columns: u32, rows: u32) -> Result<Self, CoreError> {
        if !(2..=1_000).contains(&columns) || !(2..=1_000).contains(&rows) {
            return Err(CoreError::new(
                CoreErrorCode::Validation,
                "PTY rows and columns must be between 2 and 1000",
                false,
            ));
        }
        Ok(Self {
            columns: columns as u16,
            rows: rows as u16,
        })
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

#[async_trait]
pub trait ShellBackend: Clone + Send + Sync + 'static {
    async fn open(
        &self,
        session_id: Id,
        connection: &ConnectionHandle,
        size: PtySize,
    ) -> Result<(), CoreError>;
    async fn open_command(
        &self,
        session_id: Id,
        connection: &ConnectionHandle,
        size: PtySize,
        command: &TerminalCommand,
    ) -> Result<(), CoreError>;
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
}

impl<B> TerminalManager<B>
where
    B: ShellBackend,
{
    pub fn new(backend: B) -> Self {
        Self {
            backend,
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
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
        let session = TerminalSession {
            id: Id::new(),
            connection,
        };
        if let Some(command) = command {
            self.backend
                .open_command(session.id, &session.connection, size, command)
                .await?;
        } else {
            self.backend
                .open(session.id, &session.connection, size)
                .await?;
        }
        self.sessions.lock().await.insert(
            session.id,
            SessionState {
                session: session.clone(),
                sequence: 0,
            },
        );
        Ok(session)
    }

    pub async fn write(&self, session_id: Id, bytes: &[u8]) -> Result<(), CoreError> {
        self.require_session(session_id).await?;
        self.backend.write(session_id, bytes).await
    }

    pub async fn resize(&self, session_id: Id, size: PtySize) -> Result<(), CoreError> {
        self.require_session(session_id).await?;
        self.backend.resize(session_id, size).await
    }

    pub async fn record_output(
        &self,
        session_id: Id,
        bytes: Vec<u8>,
    ) -> Result<TerminalData, CoreError> {
        if bytes.len() > 4 * 1024 * 1024 {
            return Err(CoreError::new(
                CoreErrorCode::Conflict,
                "terminal output exceeds the per-session backpressure budget",
                true,
            ));
        }
        let mut sessions = self.sessions.lock().await;
        let state = sessions
            .get_mut(&session_id)
            .ok_or_else(|| not_found("terminal session"))?;
        state.sequence = state.sequence.checked_add(1).ok_or_else(|| {
            CoreError::new(CoreErrorCode::Internal, "terminal sequence overflow", false)
        })?;
        Ok(TerminalData {
            terminal_session_id: state.session.id,
            sequence: state.sequence,
            bytes,
        })
    }

    pub async fn close(&self, session_id: Id) -> Result<(), CoreError> {
        let removed = self.sessions.lock().await.remove(&session_id);
        if removed.is_some() {
            self.backend.close(session_id).await?;
        }
        Ok(())
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
}

#[async_trait]
impl ShellBackend for InMemoryShellBackend {
    async fn open(
        &self,
        session_id: Id,
        _connection: &ConnectionHandle,
        _size: PtySize,
    ) -> Result<(), CoreError> {
        self.writes.lock().await.insert(session_id, Vec::new());
        self.resizes.lock().await.insert(session_id, Vec::new());
        self.commands.lock().await.insert(session_id, None);
        Ok(())
    }

    async fn open_command(
        &self,
        session_id: Id,
        _connection: &ConnectionHandle,
        _size: PtySize,
        command: &TerminalCommand,
    ) -> Result<(), CoreError> {
        self.writes.lock().await.insert(session_id, Vec::new());
        self.resizes.lock().await.insert(session_id, Vec::new());
        self.commands
            .lock()
            .await
            .insert(session_id, Some(command.clone()));
        Ok(())
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
        self.writes.lock().await.remove(&session_id);
        self.resizes.lock().await.remove(&session_id);
        self.commands.lock().await.remove(&session_id);
        Ok(())
    }
}

fn not_found(resource: &str) -> CoreError {
    CoreError::new(
        CoreErrorCode::NotFound,
        format!("{resource} was not found"),
        false,
    )
}
