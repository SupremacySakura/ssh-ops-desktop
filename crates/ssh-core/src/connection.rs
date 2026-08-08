use opspilot_domain::{CoreError, CoreErrorCode};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ConnectionState {
    Idle,
    Connecting,
    HostVerifying,
    Authenticating,
    Ready,
    Reconnecting { attempt: u8 },
    Closed,
    Error { code: CoreErrorCode },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnectionEvent {
    ConnectRequested,
    TcpConnected,
    HostKeyTrusted,
    HostKeyChanged,
    Authenticated,
    AuthenticationFailed,
    TransportLost,
    RetryConnected,
    RetryFailed,
    CloseRequested,
}

#[derive(Clone, Debug)]
pub struct ConnectionMachine {
    state: ConnectionState,
    max_reconnect_attempts: u8,
}

impl ConnectionMachine {
    pub fn new(max_reconnect_attempts: u8) -> Self {
        Self {
            state: ConnectionState::Idle,
            max_reconnect_attempts: max_reconnect_attempts.max(1),
        }
    }

    pub fn state(&self) -> &ConnectionState {
        &self.state
    }

    pub fn apply(&mut self, event: ConnectionEvent) -> Result<&ConnectionState, CoreError> {
        if event == ConnectionEvent::CloseRequested {
            self.state = ConnectionState::Closed;
            return Ok(&self.state);
        }

        let next = match (&self.state, event) {
            (ConnectionState::Idle, ConnectionEvent::ConnectRequested) => {
                ConnectionState::Connecting
            }
            (ConnectionState::Connecting, ConnectionEvent::TcpConnected) => {
                ConnectionState::HostVerifying
            }
            (ConnectionState::HostVerifying, ConnectionEvent::HostKeyTrusted) => {
                ConnectionState::Authenticating
            }
            (ConnectionState::HostVerifying, ConnectionEvent::HostKeyChanged) => {
                return self.fail(
                    CoreErrorCode::SshHostKeyChanged,
                    "SSH host key changed; connection blocked",
                    false,
                );
            }
            (ConnectionState::Authenticating, ConnectionEvent::Authenticated) => {
                ConnectionState::Ready
            }
            (ConnectionState::Authenticating, ConnectionEvent::AuthenticationFailed) => {
                return self.fail(
                    CoreErrorCode::SshAuthentication,
                    "SSH authentication failed",
                    true,
                );
            }
            (ConnectionState::Ready, ConnectionEvent::TransportLost) => {
                ConnectionState::Reconnecting { attempt: 1 }
            }
            (ConnectionState::Reconnecting { .. }, ConnectionEvent::RetryConnected) => {
                ConnectionState::HostVerifying
            }
            (ConnectionState::Reconnecting { attempt }, ConnectionEvent::RetryFailed)
                if *attempt < self.max_reconnect_attempts =>
            {
                ConnectionState::Reconnecting {
                    attempt: *attempt + 1,
                }
            }
            (ConnectionState::Reconnecting { .. }, ConnectionEvent::RetryFailed) => {
                return self.fail(
                    CoreErrorCode::SshConnection,
                    "SSH reconnect attempts exhausted",
                    true,
                );
            }
            _ => return Err(invalid_transition(&self.state, event)),
        };
        self.state = next;
        Ok(&self.state)
    }

    fn fail(
        &mut self,
        code: CoreErrorCode,
        message: &'static str,
        retryable: bool,
    ) -> Result<&ConnectionState, CoreError> {
        self.state = ConnectionState::Error { code };
        Err(CoreError::new(code, message, retryable))
    }
}

impl Default for ConnectionMachine {
    fn default() -> Self {
        Self::new(3)
    }
}

fn invalid_transition(state: &ConnectionState, event: ConnectionEvent) -> CoreError {
    CoreError::new(
        CoreErrorCode::Conflict,
        format!("invalid SSH connection transition from {state:?} using {event:?}"),
        false,
    )
}
