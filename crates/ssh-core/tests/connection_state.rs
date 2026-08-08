use opspilot_domain::CoreErrorCode;
use opspilot_ssh_core::{ConnectionEvent, ConnectionMachine, ConnectionState};

#[test]
fn changed_host_key_never_reaches_authentication() {
    let mut machine = ConnectionMachine::new(3);
    machine.apply(ConnectionEvent::ConnectRequested).unwrap();
    machine.apply(ConnectionEvent::TcpConnected).unwrap();

    let error = machine
        .apply(ConnectionEvent::HostKeyChanged)
        .expect_err("changed host key must stop the state machine");

    assert_eq!(error.code(), CoreErrorCode::SshHostKeyChanged);
    assert!(matches!(
        machine.state(),
        ConnectionState::Error {
            code: CoreErrorCode::SshHostKeyChanged
        }
    ));
}

#[test]
fn ready_disconnect_reconnects_but_manual_close_never_does() {
    let mut machine = ready_machine();
    machine.apply(ConnectionEvent::TransportLost).unwrap();
    assert_eq!(
        machine.state(),
        &ConnectionState::Reconnecting { attempt: 1 }
    );
    machine.apply(ConnectionEvent::RetryConnected).unwrap();
    assert_eq!(machine.state(), &ConnectionState::HostVerifying);

    let mut closed = ready_machine();
    closed.apply(ConnectionEvent::CloseRequested).unwrap();
    assert_eq!(closed.state(), &ConnectionState::Closed);
    let error = closed
        .apply(ConnectionEvent::TransportLost)
        .expect_err("closed connections must not reconnect");
    assert_eq!(error.code(), CoreErrorCode::Conflict);
    assert_eq!(closed.state(), &ConnectionState::Closed);
}

#[test]
fn reconnect_budget_ends_in_retryable_connection_error() {
    let mut machine = ready_machine();
    machine.apply(ConnectionEvent::TransportLost).unwrap();
    machine.apply(ConnectionEvent::RetryFailed).unwrap();
    machine.apply(ConnectionEvent::RetryFailed).unwrap();
    let error = machine
        .apply(ConnectionEvent::RetryFailed)
        .expect_err("last failed attempt must exhaust the retry budget");

    assert_eq!(error.code(), CoreErrorCode::SshConnection);
    assert!(error.is_retryable());
    assert!(matches!(
        machine.state(),
        ConnectionState::Error {
            code: CoreErrorCode::SshConnection
        }
    ));
}

fn ready_machine() -> ConnectionMachine {
    let mut machine = ConnectionMachine::new(3);
    for event in [
        ConnectionEvent::ConnectRequested,
        ConnectionEvent::TcpConnected,
        ConnectionEvent::HostKeyTrusted,
        ConnectionEvent::Authenticated,
    ] {
        machine.apply(event).unwrap();
    }
    assert_eq!(machine.state(), &ConnectionState::Ready);
    machine
}
