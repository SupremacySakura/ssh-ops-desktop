use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use opspilot_domain::{AuthType, CoreError, CoreErrorCode, Id, Server};
use opspilot_persistence::ServerRepository;
use opspilot_secrets::{SecretRef, SecretStore};
use opspilot_ssh_core::{
    AuthRequest, ConnectOutcome, ConnectionHandle, ConnectionRequest, HostEndpoint,
    RusshConnectionManager,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::CoreServices;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionStateEvent {
    server_id: Id,
    connection_id: Option<Id>,
    sequence: u64,
    state: ConnectionState,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum ConnectionState {
    Connecting,
    Ready,
    Closed,
    Error {
        code: CoreErrorCode,
        message: String,
        retryable: bool,
    },
}

#[async_trait]
pub(super) trait ConnectionAttempt {
    async fn connect(&self, request: ConnectionRequest) -> Result<ConnectOutcome, CoreError>;
}

#[async_trait]
impl<S> ConnectionAttempt for RusshConnectionManager<S>
where
    S: SecretStore + 'static,
{
    async fn connect(&self, request: ConnectionRequest) -> Result<ConnectOutcome, CoreError> {
        RusshConnectionManager::connect(self, request).await
    }
}

pub(super) fn connection_auth(server: &Server) -> Result<AuthRequest, CoreError> {
    let secret_ref = SecretRef::from_persisted(server.require_secret_ref()?.to_owned())?;
    Ok(match server.auth_type {
        AuthType::Password => AuthRequest::Password { secret_ref },
        AuthType::Key => AuthRequest::PrivateKeyContent { secret_ref },
    })
}

pub(super) fn server_endpoint(server: &Server) -> Result<HostEndpoint, CoreError> {
    HostEndpoint::try_new(server.id, &server.host, u32::from(server.port))
}

pub(super) async fn connect_server_at<S, A>(
    services: &CoreServices<S>,
    attempt: &A,
    server_id: Id,
    connected_at: i64,
) -> Result<ConnectOutcome, CoreError>
where
    S: SecretStore + Send + Sync + 'static,
    A: ConnectionAttempt,
{
    let repository = ServerRepository::new(services.database.clone());
    let server = repository.get(server_id).await?;
    let request = ConnectionRequest::try_new(
        server_endpoint(&server)?,
        &server.user,
        connection_auth(&server)?,
    )?;
    let outcome = attempt.connect(request).await?;
    if let ConnectOutcome::Ready { connection } = &outcome {
        if let Err(error) = services.register_connection(connection).await {
            cleanup_connection(services, connection).await;
            return Err(error);
        }
        if let Err(error) = repository.mark_connected(server.id, connected_at).await {
            cleanup_connection(services, connection).await;
            return Err(error);
        }
    }
    Ok(outcome)
}

async fn cleanup_connection<S>(services: &CoreServices<S>, connection: &ConnectionHandle)
where
    S: SecretStore + Send + Sync + 'static,
{
    let _ = services.terminal_manager.close_connection(connection).await;
    let _ = services.connection_manager.disconnect(connection).await;
}

#[tauri::command]
pub(crate) async fn connection_connect(
    app: AppHandle,
    server_id: Id,
) -> Result<ConnectOutcome, CoreError> {
    let services = core_services(&app);
    emit_connection_state_event(
        &app,
        &services,
        server_id,
        None,
        ConnectionState::Connecting,
    )
    .await;
    let result = connect_server_at(
        &services,
        &services.connection_manager,
        server_id,
        unix_timestamp()?,
    )
    .await;

    match &result {
        Ok(ConnectOutcome::Ready { connection }) => {
            emit_connection_state_event(
                &app,
                &services,
                server_id,
                Some(connection.connection_id()),
                ConnectionState::Ready,
            )
            .await;
        }
        Ok(ConnectOutcome::HostKeyRequired { .. }) => {}
        Ok(ConnectOutcome::HostKeyChanged { .. }) => {
            emit_connection_state_event(
                &app,
                &services,
                server_id,
                None,
                ConnectionState::Error {
                    code: CoreErrorCode::SshHostKeyChanged,
                    message: "SSH host key changed; connection blocked".to_owned(),
                    retryable: false,
                },
            )
            .await;
        }
        Err(error) => {
            emit_connection_state_event(
                &app,
                &services,
                server_id,
                None,
                ConnectionState::Error {
                    code: error.code(),
                    message: error.message().to_owned(),
                    retryable: error.is_retryable(),
                },
            )
            .await;
        }
    }
    result
}

#[tauri::command]
pub(crate) async fn connection_trust_host_key(
    app: AppHandle,
    server_id: Id,
    verification_id: Id,
) -> Result<(), CoreError> {
    let services = core_services(&app);
    let server = ServerRepository::new(services.database.clone())
        .get(server_id)
        .await?;
    services
        .connection_manager
        .trust_host_key(verification_id, &server_endpoint(&server)?)
        .await
}

#[tauri::command]
pub(crate) async fn connection_disconnect(
    app: AppHandle,
    connection: ConnectionHandle,
) -> Result<(), CoreError> {
    let services = core_services(&app);
    match services
        .terminal_manager
        .close_connection(&connection)
        .await
    {
        Ok(_) => {}
        Err(error) if error.code() == CoreErrorCode::NotFound => {}
        Err(error) if error.code() == CoreErrorCode::Conflict => return Err(error),
        Err(_) => {
            // The transport teardown below is authoritative for a dead PTY.
        }
    }
    let disconnect_result = services.connection_manager.disconnect(&connection).await;
    if matches!(
        &disconnect_result,
        Err(error) if error.code() == CoreErrorCode::Conflict
    ) {
        return disconnect_result;
    }

    // close() may fail once the transport is already gone. Once disconnect has
    // been attempted, no terminal state may remain to occupy a per-server slot.
    services
        .terminal_manager
        .discard_connection(&connection)
        .await;
    emit_connection_state_event(
        &app,
        &services,
        connection.server_id(),
        Some(connection.connection_id()),
        ConnectionState::Closed,
    )
    .await;
    disconnect_result
}

async fn emit_connection_state_event(
    app: &AppHandle,
    services: &CoreServices,
    server_id: Id,
    connection_id: Option<Id>,
    state: ConnectionState,
) {
    let sequence = services.next_connection_sequence(server_id).await;
    let _ = app.emit(
        "connection:state",
        ConnectionStateEvent {
            server_id,
            connection_id,
            sequence,
            state,
        },
    );
}

fn core_services(app: &AppHandle) -> CoreServices {
    app.state::<CoreServices>().inner().clone()
}

fn unix_timestamp() -> Result<i64, CoreError> {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| {
            CoreError::new(
                CoreErrorCode::Internal,
                format!("system clock is before the Unix epoch: {error}"),
                false,
            )
        })?
        .as_secs();
    i64::try_from(seconds).map_err(|error| {
        CoreError::new(
            CoreErrorCode::Internal,
            format!("system time is outside the supported range: {error}"),
            false,
        )
    })
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use async_trait::async_trait;
    use opspilot_domain::{
        AuthType, CoreError, CoreErrorCode, Id, ServerInput as DomainServerInput,
    };
    use opspilot_persistence::{Database, ServerRepository};
    use opspilot_secrets::{MemorySecretStore, SecretKind, SecretStore, SecretValue};
    use opspilot_ssh_core::{ConnectOutcome, ConnectionHandle, ConnectionRequest, HostKeyPrompt};

    use super::super::CoreServices;
    use super::{ConnectionAttempt, connect_server_at, connection_auth};

    #[derive(Clone)]
    struct FakeAttempt {
        outcome: Result<ConnectOutcome, CoreError>,
    }

    #[async_trait]
    impl ConnectionAttempt for FakeAttempt {
        async fn connect(&self, _request: ConnectionRequest) -> Result<ConnectOutcome, CoreError> {
            self.outcome.clone()
        }
    }

    struct CountingAttempt {
        calls: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl ConnectionAttempt for CountingAttempt {
        async fn connect(&self, _request: ConnectionRequest) -> Result<ConnectOutcome, CoreError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(ConnectOutcome::HostKeyRequired {
                prompt: HostKeyPrompt {
                    verification_id: Id::new(),
                    algorithm: "ssh-ed25519".to_owned(),
                    sha256: "SHA256:fixture".to_owned(),
                    expires_at: "2026-01-01T00:00:00.000Z".to_owned(),
                },
            })
        }
    }

    #[tokio::test]
    async fn marks_a_server_connected_only_after_ready_and_never_after_blocked_outcomes() {
        let database = Database::open(":memory:").await.unwrap();
        let store = MemorySecretStore::default();
        let services = CoreServices::new(database, store);
        let server = create_server(&services, AuthType::Password).await;

        let ready_attempt = FakeAttempt {
            outcome: Ok(ConnectOutcome::Ready {
                connection: ConnectionHandle::new(server.id, Id::new()),
            }),
        };
        connect_server_at(&services, &ready_attempt, server.id, 1_700_000_100)
            .await
            .unwrap();
        assert_eq!(
            ServerRepository::new(services.database.clone())
                .get(server.id)
                .await
                .unwrap()
                .last_connected_at,
            Some(1_700_000_100)
        );

        let second = create_server(&services, AuthType::Key).await;
        let host_key_attempt = FakeAttempt {
            outcome: Ok(ConnectOutcome::HostKeyRequired {
                prompt: HostKeyPrompt {
                    verification_id: Id::new(),
                    algorithm: "ssh-ed25519".to_owned(),
                    sha256: "SHA256:fixture".to_owned(),
                    expires_at: "2026-01-01T00:00:00.000Z".to_owned(),
                },
            }),
        };
        connect_server_at(&services, &host_key_attempt, second.id, 1_700_000_200)
            .await
            .unwrap();
        assert_eq!(
            ServerRepository::new(services.database.clone())
                .get(second.id)
                .await
                .unwrap()
                .last_connected_at,
            None
        );

        let third = create_server(&services, AuthType::Password).await;
        let failure_attempt = FakeAttempt {
            outcome: Err(CoreError::new(
                CoreErrorCode::SshAuthentication,
                "fixture authentication failed",
                false,
            )),
        };
        assert!(
            connect_server_at(&services, &failure_attempt, third.id, 1_700_000_300)
                .await
                .is_err()
        );
        assert_eq!(
            ServerRepository::new(services.database.clone())
                .get(third.id)
                .await
                .unwrap()
                .last_connected_at,
            None
        );
    }

    #[tokio::test]
    async fn a_registration_conflict_does_not_mark_the_server_or_retain_a_second_binding() {
        let database = Database::open(":memory:").await.unwrap();
        let services = CoreServices::new(database, MemorySecretStore::default());
        let first = create_server(&services, AuthType::Password).await;
        let second = create_server(&services, AuthType::Password).await;
        let connection_id = Id::new();
        let first_handle = ConnectionHandle::new(first.id, connection_id);
        let second_handle = ConnectionHandle::new(second.id, connection_id);

        connect_server_at(
            &services,
            &FakeAttempt {
                outcome: Ok(ConnectOutcome::Ready {
                    connection: first_handle.clone(),
                }),
            },
            first.id,
            1_700_000_100,
        )
        .await
        .unwrap();
        let error = connect_server_at(
            &services,
            &FakeAttempt {
                outcome: Ok(ConnectOutcome::Ready {
                    connection: second_handle.clone(),
                }),
            },
            second.id,
            1_700_000_200,
        )
        .await
        .expect_err("one connection id cannot be registered for two servers");

        assert_eq!(error.code(), CoreErrorCode::Conflict);
        assert!(
            services
                .terminal_manager
                .is_connection_registered(&first_handle)
                .await
        );
        assert!(
            !services
                .terminal_manager
                .is_connection_registered(&second_handle)
                .await
        );
        assert_eq!(
            ServerRepository::new(services.database.clone())
                .get(second.id)
                .await
                .unwrap()
                .last_connected_at,
            None
        );
    }

    #[tokio::test]
    async fn a_pending_credential_fails_before_connection_attempt_or_timestamp_update() {
        let database = Database::open(":memory:").await.unwrap();
        let services = CoreServices::new(database, MemorySecretStore::default());
        let input = DomainServerInput::try_new(
            "pending",
            "pending.example.com",
            22,
            "deploy",
            AuthType::Password,
            None,
            None,
            false,
        )
        .unwrap();
        let server = ServerRepository::new(services.database.clone())
            .create(&input, 1_700_000_000)
            .await
            .unwrap();
        let calls = Arc::new(AtomicUsize::new(0));

        let error = connect_server_at(
            &services,
            &CountingAttempt {
                calls: calls.clone(),
            },
            server.id,
            1_700_000_100,
        )
        .await
        .expect_err("a server without a Keychain reference must not attempt authentication");

        assert_eq!(error.code(), CoreErrorCode::SecretUnavailable);
        assert_eq!(
            error.message(),
            "该服务器的凭据尚未配置，请先补充密码或私钥"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(
            ServerRepository::new(services.database.clone())
                .get(server.id)
                .await
                .unwrap()
                .last_connected_at,
            None
        );
    }

    #[test]
    fn server_credentials_resolve_as_keyring_material_not_webview_auth() {
        let server = opspilot_domain::Server {
            id: Id::new(),
            name: "prod".to_owned(),
            host: "prod.example.com".to_owned(),
            port: 22,
            user: "deploy".to_owned(),
            auth_type: AuthType::Key,
            secret_ref: Some("secret-ref-fixture".to_owned()),
            group_id: None,
            favorite: false,
            last_connected_at: None,
            created_at: 1_700_000_000,
        };

        let auth = connection_auth(&server).unwrap();
        assert!(matches!(
            auth,
            opspilot_ssh_core::AuthRequest::PrivateKeyContent { .. }
        ));
        assert!(format!("{auth:?}").contains("PrivateKeyContent"));
        assert!(!format!("{auth:?}").contains("private-key-material"));
    }

    #[test]
    fn connection_state_events_serialize_with_the_shared_camel_case_contract() {
        let server_id = Id::new();
        let connection_id = Id::new();
        assert_eq!(
            serde_json::to_value(super::ConnectionStateEvent {
                server_id,
                connection_id: None,
                sequence: 4,
                state: super::ConnectionState::Error {
                    code: CoreErrorCode::SshHostKeyChanged,
                    message: "blocked".to_owned(),
                    retryable: false,
                },
            })
            .unwrap(),
            serde_json::json!({
                "serverId": server_id,
                "connectionId": null,
                "sequence": 4,
                "state": {
                    "kind": "error",
                    "code": "SSH_HOST_KEY_CHANGED",
                    "message": "blocked",
                    "retryable": false,
                },
            })
        );
        assert_eq!(
            serde_json::to_value(super::ConnectionStateEvent {
                server_id,
                connection_id: Some(connection_id),
                sequence: 5,
                state: super::ConnectionState::Ready,
            })
            .unwrap(),
            serde_json::json!({
                "serverId": server_id,
                "connectionId": connection_id,
                "sequence": 5,
                "state": { "kind": "ready" },
            })
        );
    }

    async fn create_server<S>(
        services: &CoreServices<S>,
        auth_type: AuthType,
    ) -> opspilot_domain::Server
    where
        S: SecretStore + Send + Sync + 'static,
    {
        let secret_ref = services
            .secret_store
            .put(
                if auth_type == AuthType::Password {
                    SecretKind::Password
                } else {
                    SecretKind::PrivateKey
                },
                Id::new(),
                SecretValue::new("credential-fixture"),
            )
            .await
            .unwrap();
        let input = DomainServerInput::try_new(
            "fixture",
            &format!("{}.example.com", Id::new()),
            22,
            "deploy",
            auth_type,
            Some(secret_ref.as_str()),
            None,
            false,
        )
        .unwrap();
        ServerRepository::new(services.database.clone())
            .create(&input, 1_700_000_000)
            .await
            .unwrap()
    }
}
