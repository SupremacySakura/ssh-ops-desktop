use std::path::PathBuf;

use opspilot_audit::AuditEvent;
use opspilot_domain::{AuthType, CoreError, CoreErrorCode, Id};
use opspilot_persistence::ServerRepository;
use opspilot_secrets::SecretRef;
use opspilot_ssh_core::{
    ActiveTunnel, AuthRequest, ConnectOutcome, ConnectionHandle, ConnectionRequest, HostEndpoint,
    PtySize, TerminalSession, TunnelDirection, TunnelRule,
};
use serde::Deserialize;
use tauri::{AppHandle, Emitter};

use super::services;

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum ConnectionAuthInput {
    Password,
    PrivateKey {
        private_key_path: PathBuf,
    },
    SshAgent,
    Certificate {
        certificate_path: PathBuf,
        private_key_path: PathBuf,
        expected_principal: String,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConnectionConnectRequest {
    server_id: Id,
    auth: ConnectionAuthInput,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HostKeyTrustRequest {
    server_id: Id,
    verification_id: Id,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TerminalOpenRequest {
    connection: ConnectionHandle,
    columns: u32,
    rows: u32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TerminalWriteRequest {
    terminal_session_id: Id,
    bytes: Vec<u8>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TerminalResizeRequest {
    terminal_session_id: Id,
    columns: u32,
    rows: u32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TunnelOpenRequest {
    connection: ConnectionHandle,
    direction: TunnelDirection,
    bind_host: Option<String>,
    bind_port: u16,
    target_host: Option<String>,
    target_port: Option<u16>,
    public_bind_confirmed: bool,
}

pub(super) fn into_auth_request(
    expected: AuthType,
    input: ConnectionAuthInput,
    stored_secret: Option<SecretRef>,
) -> Result<AuthRequest, CoreError> {
    match (expected, input) {
        (AuthType::Password, ConnectionAuthInput::Password) => Ok(AuthRequest::Password {
            secret_ref: stored_secret.ok_or_else(|| {
                CoreError::new(
                    CoreErrorCode::Validation,
                    "password authentication requires a credential configured for this server",
                    false,
                )
            })?,
        }),
        (AuthType::PrivateKey, ConnectionAuthInput::PrivateKey { private_key_path }) => {
            Ok(AuthRequest::PrivateKey {
                path: private_key_path,
                passphrase_ref: stored_secret,
            })
        }
        (AuthType::SshAgent, ConnectionAuthInput::SshAgent) => Ok(AuthRequest::SshAgent),
        (
            AuthType::Certificate,
            ConnectionAuthInput::Certificate {
                certificate_path,
                private_key_path,
                expected_principal,
            },
        ) => Ok(AuthRequest::Certificate {
            certificate_path,
            private_key_path,
            passphrase_ref: stored_secret,
            expected_principal,
        }),
        _ => Err(CoreError::new(
            CoreErrorCode::Validation,
            "connection authentication kind does not match the server profile",
            false,
        )),
    }
}

#[tauri::command]
pub(crate) async fn connection_connect(
    app: AppHandle,
    request: ConnectionConnectRequest,
) -> Result<ConnectOutcome, CoreError> {
    let services = services(&app);
    let server = ServerRepository::new(services.database.clone())
        .get(request.server_id)
        .await?;
    let endpoint = HostEndpoint::try_new(server.id, &server.host, u32::from(server.port))?;
    let stored_secret = ServerRepository::new(services.database.clone())
        .connection_secret_ref(server.id)
        .await?;
    let auth = into_auth_request(server.auth_type, request.auth, stored_secret)?;
    let outcome = services
        .connection_manager
        .connect(ConnectionRequest::try_new(
            endpoint,
            &server.username,
            auth,
        )?)
        .await;
    let (result, detail) = match &outcome {
        Ok(ConnectOutcome::Ready { connection }) => {
            let _ = app.emit(
                "connection:state",
                serde_json::json!({
                    "serverId": connection.server_id(),
                    "connectionId": connection.connection_id(),
                    "sequence": 1,
                    "state": { "kind": "ready" },
                }),
            );
            ("success", "ready")
        }
        Ok(ConnectOutcome::HostKeyRequired { .. }) => ("pending", "host_key_required"),
        Ok(ConnectOutcome::HostKeyChanged { .. }) => ("blocked", "host_key_changed"),
        Err(_) => ("failed", "connection_error"),
    };
    services
        .audit_writer
        .append(
            AuditEvent::new(
                "connection.connect",
                "server",
                result,
                serde_json::json!({ "state": detail }),
            )
            .with_server_id(server.id.to_string()),
        )
        .await?;
    outcome
}

#[tauri::command]
pub(crate) async fn connection_trust_host_key(
    app: AppHandle,
    request: HostKeyTrustRequest,
) -> Result<(), CoreError> {
    let services = services(&app);
    let server = ServerRepository::new(services.database.clone())
        .get(request.server_id)
        .await?;
    let endpoint = HostEndpoint::try_new(server.id, &server.host, u32::from(server.port))?;
    services
        .connection_manager
        .trust_host_key(request.verification_id, &endpoint)
        .await?;
    services
        .audit_writer
        .append(
            AuditEvent::new(
                "connection.host_key_trust",
                "server",
                "success",
                serde_json::json!({ "verificationId": request.verification_id }),
            )
            .with_server_id(server.id.to_string()),
        )
        .await
}

#[tauri::command]
pub(crate) async fn connection_disconnect(
    app: AppHandle,
    connection: ConnectionHandle,
) -> Result<(), CoreError> {
    let services = services(&app);
    services.connection_manager.disconnect(&connection).await?;
    let _ = app.emit(
        "connection:state",
        serde_json::json!({
            "serverId": connection.server_id(),
            "connectionId": connection.connection_id(),
            "sequence": 2,
            "state": { "kind": "closed" },
        }),
    );
    Ok(())
}

#[tauri::command]
pub(crate) async fn terminal_open(
    app: AppHandle,
    request: TerminalOpenRequest,
) -> Result<TerminalSession, CoreError> {
    let services = services(&app);
    services
        .terminal_manager
        .open(
            request.connection,
            PtySize::try_new(request.columns, request.rows)?,
        )
        .await
}

#[tauri::command]
pub(crate) async fn terminal_write(
    app: AppHandle,
    request: TerminalWriteRequest,
) -> Result<(), CoreError> {
    if request.bytes.len() > 1024 * 1024 {
        return Err(CoreError::new(
            CoreErrorCode::Validation,
            "terminal write exceeds the 1 MiB IPC limit",
            false,
        ));
    }
    services(&app)
        .terminal_manager
        .write(request.terminal_session_id, &request.bytes)
        .await
}

#[tauri::command]
pub(crate) async fn terminal_resize(
    app: AppHandle,
    request: TerminalResizeRequest,
) -> Result<(), CoreError> {
    services(&app)
        .terminal_manager
        .resize(
            request.terminal_session_id,
            PtySize::try_new(request.columns, request.rows)?,
        )
        .await
}

#[tauri::command]
pub(crate) async fn terminal_close(
    app: AppHandle,
    terminal_session_id: Id,
) -> Result<(), CoreError> {
    services(&app)
        .terminal_manager
        .close(terminal_session_id)
        .await
}

#[tauri::command]
pub(crate) async fn tunnel_open(
    app: AppHandle,
    request: TunnelOpenRequest,
) -> Result<ActiveTunnel, CoreError> {
    let services = services(&app);
    let rule = TunnelRule::try_new(
        request.direction,
        request.bind_host.as_deref(),
        request.bind_port,
        request.target_host.as_deref(),
        request.target_port,
        request.public_bind_confirmed,
    )?;
    services.tunnel_manager.open(request.connection, rule).await
}

#[tauri::command]
pub(crate) async fn tunnel_close(app: AppHandle, tunnel_id: Id) -> Result<(), CoreError> {
    services(&app).tunnel_manager.close(tunnel_id).await
}

#[tauri::command]
pub(crate) async fn tunnel_list(app: AppHandle) -> Vec<ActiveTunnel> {
    services(&app).tunnel_manager.list().await
}

#[cfg(test)]
mod tests {
    use opspilot_domain::{AuthType, CoreErrorCode};
    use opspilot_secrets::SecretRef;

    use super::{ConnectionAuthInput, into_auth_request};

    #[test]
    fn auth_input_must_match_server_auth_type_and_never_contains_plaintext() {
        let request = into_auth_request(
            AuthType::Password,
            ConnectionAuthInput::Password,
            Some(SecretRef::from_persisted("keyring-ref").unwrap()),
        )
        .unwrap();
        assert!(format!("{request:?}").contains("Password"));
        assert!(!format!("{request:?}").contains("plaintext"));

        let error = into_auth_request(
            AuthType::SshAgent,
            ConnectionAuthInput::Password,
            Some(SecretRef::from_persisted("keyring-ref").unwrap()),
        )
        .expect_err("auth kind mismatch must fail closed");
        assert_eq!(error.code(), CoreErrorCode::Validation);
    }
}
