use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use chrono::{DateTime, SecondsFormat, Utc};
use opspilot_domain::{CoreError, CoreErrorCode, Id};
use opspilot_persistence::Database;
use opspilot_secrets::SecretStore;
use russh::{
    ChannelMsg, ChannelWriteHalf, Disconnect, Sig,
    client::{self, Handle, Msg},
    keys::{PrivateKeyWithHashAlg, agent::client::AgentClient},
};
use russh_sftp::client::SftpSession;
use serde::Serialize;
use tokio::sync::{Mutex, broadcast};

use crate::{
    AuthRequest, AuthResolver, ConnectionHandle, HostEndpoint, HostKeyDecision, HostKeyVerifier,
    HostPublicKey, PtySize, ResolvedAuth, SHELL_EVENT_CHANNEL_CAPACITY, ShellBackend, ShellEvent,
    ShellEventReceiver,
};

#[derive(Debug)]
pub struct ConnectionRequest {
    endpoint: HostEndpoint,
    username: String,
    auth: AuthRequest,
}

impl ConnectionRequest {
    pub fn try_new(
        endpoint: HostEndpoint,
        username: &str,
        auth: AuthRequest,
    ) -> Result<Self, CoreError> {
        let username = username.trim();
        if username.is_empty()
            || username.len() > 128
            || username.chars().any(char::is_control)
            || username.chars().any(char::is_whitespace)
        {
            return Err(validation("SSH username is invalid"));
        }
        Ok(Self {
            endpoint,
            username: username.to_owned(),
            auth,
        })
    }

    pub fn endpoint(&self) -> &HostEndpoint {
        &self.endpoint
    }

    pub fn username(&self) -> &str {
        &self.username
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyPrompt {
    pub verification_id: Id,
    pub algorithm: String,
    pub sha256: String,
    pub expires_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ConnectOutcome {
    Ready {
        connection: ConnectionHandle,
    },
    HostKeyRequired {
        prompt: HostKeyPrompt,
    },
    HostKeyChanged {
        expected_sha256: String,
        actual_sha256: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostKeyProbe {
    pub already_trusted: bool,
    pub verification_id: Option<Id>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_status: u32,
}

struct ClientHandler {
    verifier: HostKeyVerifier,
    endpoint: HostEndpoint,
    decision: Arc<Mutex<Option<Result<HostKeyDecision, CoreError>>>>,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let encoded = server_public_key
            .to_bytes()
            .map_err(|_| russh::Error::CouldNotReadKey)?;
        let key = HostPublicKey::try_new(server_public_key.algorithm().as_str(), &encoded)
            .map_err(|_| russh::Error::UnknownKey)?;
        let result = self.verifier.verify(&self.endpoint, &key).await;
        let trusted = matches!(result, Ok(HostKeyDecision::Trusted));
        *self.decision.lock().await = Some(result);
        Ok(trusted)
    }
}

type SharedClient = Arc<Mutex<Handle<ClientHandler>>>;

#[derive(Clone)]
struct RegisteredClient {
    server_id: Id,
    client: SharedClient,
}

pub struct RusshConnectionManager<S> {
    verifier: HostKeyVerifier,
    secret_store: Arc<S>,
    clients: Arc<Mutex<HashMap<Id, RegisteredClient>>>,
}

impl<S> Clone for RusshConnectionManager<S> {
    fn clone(&self) -> Self {
        Self {
            verifier: self.verifier.clone(),
            secret_store: self.secret_store.clone(),
            clients: self.clients.clone(),
        }
    }
}

impl<S> RusshConnectionManager<S>
where
    S: SecretStore + 'static,
{
    pub fn new(database: Database, secret_store: Arc<S>, host_key_ttl: Duration) -> Self {
        Self {
            verifier: HostKeyVerifier::new(database, host_key_ttl),
            secret_store,
            clients: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn connect(&self, request: ConnectionRequest) -> Result<ConnectOutcome, CoreError> {
        let resolved_auth = AuthResolver::new(self.secret_store.as_ref())
            .resolve(request.auth)
            .await?;
        let decision = Arc::new(Mutex::new(None));
        let handler = ClientHandler {
            verifier: self.verifier.clone(),
            endpoint: request.endpoint.clone(),
            decision: decision.clone(),
        };
        let config = Arc::new(client::Config {
            inactivity_timeout: Some(Duration::from_secs(120)),
            keepalive_interval: Some(Duration::from_secs(15)),
            keepalive_max: 3,
            nodelay: true,
            ..Default::default()
        });
        let address = (request.endpoint.host(), request.endpoint.port());
        let connection = client::connect(config, address, handler).await;
        let mut client = match connection {
            Ok(client) => client,
            Err(error) => {
                if let Some(host_decision) = decision.lock().await.take() {
                    return host_decision_to_outcome(host_decision);
                }
                return Err(ssh_error("connect to SSH server", error, true));
            }
        };

        let authenticated = authenticate(&mut client, &request.username, resolved_auth).await?;
        if !authenticated {
            let _ = client
                .disconnect(Disconnect::ByApplication, "authentication failed", "en")
                .await;
            return Err(CoreError::new(
                CoreErrorCode::SshAuthentication,
                "SSH authentication failed",
                false,
            ));
        }
        let connection = ConnectionHandle::new(request.endpoint.server_id(), Id::new());
        self.clients.lock().await.insert(
            connection.connection_id(),
            RegisteredClient {
                server_id: connection.server_id(),
                client: Arc::new(Mutex::new(client)),
            },
        );
        Ok(ConnectOutcome::Ready { connection })
    }

    pub async fn trust_host_key(
        &self,
        verification_id: Id,
        endpoint: &HostEndpoint,
    ) -> Result<(), CoreError> {
        self.verifier.trust_pending(verification_id, endpoint).await
    }

    pub async fn disconnect(&self, connection: &ConnectionHandle) -> Result<(), CoreError> {
        let registered = {
            let mut clients = self.clients.lock().await;
            match clients.get(&connection.connection_id()) {
                Some(registered) if registered.server_id != connection.server_id() => {
                    return Err(CoreError::new(
                        CoreErrorCode::Conflict,
                        "SSH connection handle does not match its registered server",
                        false,
                    ));
                }
                Some(_) => clients.remove(&connection.connection_id()),
                None => None,
            }
        };
        if let Some(registered) = registered {
            registered
                .client
                .lock()
                .await
                .disconnect(Disconnect::ByApplication, "closed by user", "en")
                .await
                .map_err(|error| ssh_error("disconnect SSH session", error, false))?;
        }
        Ok(())
    }

    pub async fn open_sftp(&self, connection: &ConnectionHandle) -> Result<SftpSession, CoreError> {
        let client = self.client(connection).await?;
        let channel = client
            .lock()
            .await
            .channel_open_session()
            .await
            .map_err(|error| ssh_error("open SFTP channel", error, true))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|error| ssh_error("start SFTP subsystem", error, true))?;
        SftpSession::new(channel.into_stream())
            .await
            .map_err(|error| {
                CoreError::new(
                    CoreErrorCode::CapabilityUnavailable,
                    format!("failed to initialize SFTP subsystem: {error}"),
                    true,
                )
            })
    }

    /// Executes only command strings produced by the structured remote-command encoder.
    /// This boundary is deliberately not registered as a Tauri command.
    pub async fn execute_posix(
        &self,
        connection: &ConnectionHandle,
        rendered_command: String,
        stdin: Option<Vec<u8>>,
        timeout: Duration,
    ) -> Result<ExecOutput, CoreError> {
        if rendered_command.is_empty()
            || rendered_command.len() > 256 * 1024
            || rendered_command.contains('\0')
        {
            return Err(validation("encoded remote command is invalid"));
        }
        let client = self.client(connection).await?;
        let mut channel = client
            .lock()
            .await
            .channel_open_session()
            .await
            .map_err(|error| ssh_error("open command channel", error, true))?;
        channel
            .exec(true, rendered_command)
            .await
            .map_err(|error| ssh_error("start remote command", error, true))?;
        if let Some(stdin) = stdin {
            channel
                .data_bytes(stdin)
                .await
                .map_err(|error| ssh_error("write remote command stdin", error, true))?;
        }
        channel
            .eof()
            .await
            .map_err(|error| ssh_error("close remote command stdin", error, true))?;

        let execution = async {
            let mut stdout = Vec::new();
            let mut stderr = Vec::new();
            let mut exit_status = None;
            while let Some(message) = channel.wait().await {
                match message {
                    ChannelMsg::Data { data } => append_bounded(&mut stdout, &data)?,
                    ChannelMsg::ExtendedData { data, .. } => append_bounded(&mut stderr, &data)?,
                    ChannelMsg::ExitStatus {
                        exit_status: status,
                    } => exit_status = Some(status),
                    _ => {}
                }
            }
            Ok::<_, CoreError>(ExecOutput {
                stdout,
                stderr,
                exit_status: exit_status.ok_or_else(|| {
                    CoreError::new(
                        CoreErrorCode::RemoteCommand,
                        "remote command closed without an exit status",
                        true,
                    )
                })?,
            })
        };
        match tokio::time::timeout(timeout, execution).await {
            Ok(result) => result,
            Err(_) => {
                let _ = channel.signal(Sig::TERM).await;
                let _ = channel.close().await;
                Err(CoreError::new(
                    CoreErrorCode::Timeout,
                    "remote command timed out; remote process state requires inspection",
                    true,
                ))
            }
        }
    }

    async fn client(&self, connection: &ConnectionHandle) -> Result<SharedClient, CoreError> {
        let registered = self
            .clients
            .lock()
            .await
            .get(&connection.connection_id())
            .cloned()
            .ok_or_else(|| {
                CoreError::new(
                    CoreErrorCode::NotFound,
                    "SSH connection was not found",
                    false,
                )
            })?;
        if registered.server_id != connection.server_id() {
            return Err(CoreError::new(
                CoreErrorCode::Conflict,
                "SSH connection handle does not match its registered server",
                false,
            ));
        }
        if registered.client.lock().await.is_closed() {
            return Err(CoreError::new(
                CoreErrorCode::SshConnection,
                "SSH connection is closed",
                true,
            ));
        }
        Ok(registered.client)
    }

    pub async fn disconnect_all(&self) {
        let clients = std::mem::take(&mut *self.clients.lock().await);
        for registered in clients.into_values() {
            let _ = registered
                .client
                .lock()
                .await
                .disconnect(Disconnect::ByApplication, "application closing", "en")
                .await;
        }
    }

    #[doc(hidden)]
    pub async fn simulate_host_key_for_test(
        &self,
        endpoint: &HostEndpoint,
        algorithm: &str,
        encoded: &[u8],
    ) -> Result<HostKeyProbe, CoreError> {
        let key = HostPublicKey::try_new(algorithm, encoded)?;
        match self.verifier.verify(endpoint, &key).await? {
            HostKeyDecision::Trusted => Ok(HostKeyProbe {
                already_trusted: true,
                verification_id: None,
            }),
            HostKeyDecision::Unknown {
                verification_id, ..
            } => Ok(HostKeyProbe {
                already_trusted: false,
                verification_id: Some(verification_id),
            }),
            HostKeyDecision::Changed { .. } => Err(CoreError::new(
                CoreErrorCode::SshHostKeyChanged,
                "SSH host key changed",
                false,
            )),
        }
    }
}

async fn authenticate(
    client: &mut Handle<ClientHandler>,
    username: &str,
    auth: ResolvedAuth,
) -> Result<bool, CoreError> {
    Ok(match auth {
        ResolvedAuth::Password(password) => client
            .authenticate_password(username, password.expose())
            .await
            .map_err(|error| ssh_error("authenticate with password", error, false))?
            .success(),
        ResolvedAuth::PrivateKey { path, passphrase } => {
            let key = russh::keys::load_secret_key(
                path,
                passphrase.as_ref().map(|secret| secret.expose()),
            )
            .map_err(|_| authentication_error("SSH private key could not be loaded"))?;
            authenticate_private_key(client, username, key).await?
        }
        ResolvedAuth::PrivateKeyContent { key: key_material } => {
            let key = russh::keys::decode_secret_key(key_material.expose(), None).map_err(|_| {
                authentication_error(
                    "SSH private key could not be parsed; encrypted keys are not supported in the keyring credential format",
                )
            })?;
            authenticate_private_key(client, username, key).await?
        }
        ResolvedAuth::Certificate {
            certificate_path,
            private_key_path,
            passphrase,
            expected_principal,
        } => {
            let certificate = russh::keys::load_openssh_certificate(certificate_path)
                .map_err(|_| authentication_error("SSH certificate could not be loaded"))?;
            validate_certificate(&certificate, &expected_principal)?;
            let key = russh::keys::load_secret_key(
                private_key_path,
                passphrase.as_ref().map(|secret| secret.expose()),
            )
            .map_err(|_| authentication_error("SSH certificate private key could not be loaded"))?;
            client
                .authenticate_openssh_cert(username, Arc::new(key), certificate)
                .await
                .map_err(|error| ssh_error("authenticate with SSH certificate", error, false))?
                .success()
        }
        ResolvedAuth::SshAgent => authenticate_agent(client, username).await?,
    })
}

async fn authenticate_private_key(
    client: &mut Handle<ClientHandler>,
    username: &str,
    key: russh::keys::PrivateKey,
) -> Result<bool, CoreError> {
    let hash = client
        .best_supported_rsa_hash()
        .await
        .map_err(|error| ssh_error("negotiate SSH key algorithm", error, false))?
        .flatten();
    Ok(client
        .authenticate_publickey(username, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
        .await
        .map_err(|error| ssh_error("authenticate with private key", error, false))?
        .success())
}

async fn authenticate_agent(
    client: &mut Handle<ClientHandler>,
    username: &str,
) -> Result<bool, CoreError> {
    #[cfg(unix)]
    let mut agent = AgentClient::connect_env()
        .await
        .map_err(|_| authentication_error("SSH agent is unavailable"))?
        .dynamic();
    #[cfg(windows)]
    let mut agent = AgentClient::connect_pageant()
        .await
        .map_err(|_| authentication_error("SSH agent is unavailable"))?
        .dynamic();
    #[cfg(not(any(unix, windows)))]
    return Err(CoreError::new(
        CoreErrorCode::CapabilityUnavailable,
        "SSH agent authentication is unsupported on this platform",
        false,
    ));

    let identities = agent
        .request_identities()
        .await
        .map_err(|_| authentication_error("SSH agent identities are unavailable"))?;
    for identity in identities {
        let public_key = identity.public_key().into_owned();
        let hash = client
            .best_supported_rsa_hash()
            .await
            .map_err(|error| ssh_error("negotiate SSH agent key algorithm", error, false))?
            .flatten();
        let result = client
            .authenticate_publickey_with(username, public_key, hash, &mut agent)
            .await
            .map_err(|_| authentication_error("SSH agent signing failed"))?;
        if result.success() {
            return Ok(true);
        }
    }
    Ok(false)
}

fn validate_certificate(
    certificate: &russh::keys::ssh_key::Certificate,
    expected_principal: &str,
) -> Result<(), CoreError> {
    certificate
        .verify_signature()
        .map_err(|_| authentication_error("SSH certificate signature is invalid"))?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| authentication_error("system time is invalid"))?
        .as_secs();
    if now < certificate.valid_after() || now >= certificate.valid_before() {
        return Err(authentication_error(
            "SSH certificate is outside its validity period",
        ));
    }
    if !certificate.valid_principals().is_empty()
        && !certificate
            .valid_principals()
            .iter()
            .any(|principal| principal == expected_principal)
    {
        return Err(authentication_error(
            "SSH certificate principal does not match",
        ));
    }
    if !certificate.critical_options().is_empty() {
        return Err(authentication_error(
            "SSH certificate has unsupported critical options",
        ));
    }
    Ok(())
}

fn host_decision_to_outcome(
    decision: Result<HostKeyDecision, CoreError>,
) -> Result<ConnectOutcome, CoreError> {
    match decision? {
        HostKeyDecision::Trusted => Err(CoreError::new(
            CoreErrorCode::SshConnection,
            "SSH handshake failed after host verification",
            true,
        )),
        HostKeyDecision::Unknown {
            verification_id,
            algorithm,
            sha256,
            expires_at,
        } => Ok(ConnectOutcome::HostKeyRequired {
            prompt: HostKeyPrompt {
                verification_id,
                algorithm,
                sha256,
                expires_at: DateTime::<Utc>::from(expires_at)
                    .to_rfc3339_opts(SecondsFormat::Millis, true),
            },
        }),
        HostKeyDecision::Changed {
            expected_sha256,
            actual_sha256,
        } => Ok(ConnectOutcome::HostKeyChanged {
            expected_sha256,
            actual_sha256,
        }),
    }
}

pub struct RusshShellBackend<S> {
    manager: RusshConnectionManager<S>,
    channels: Arc<Mutex<HashMap<Id, Arc<ChannelWriteHalf<Msg>>>>>,
}

impl<S> Clone for RusshShellBackend<S> {
    fn clone(&self) -> Self {
        Self {
            manager: self.manager.clone(),
            channels: self.channels.clone(),
        }
    }
}

impl<S> RusshShellBackend<S>
where
    S: SecretStore + 'static,
{
    pub fn new(manager: RusshConnectionManager<S>) -> Self {
        Self {
            manager,
            channels: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    async fn open_channel(
        &self,
        session_id: Id,
        connection: &ConnectionHandle,
        size: PtySize,
        command: Option<&crate::TerminalCommand>,
    ) -> Result<ShellEventReceiver, CoreError> {
        let client = self.manager.client(connection).await?;
        let channel = client
            .lock()
            .await
            .channel_open_session()
            .await
            .map_err(|error| ssh_error("open terminal channel", error, true))?;
        channel
            .request_pty(
                true,
                "xterm-256color",
                u32::from(size.columns()),
                u32::from(size.rows()),
                0,
                0,
                &[],
            )
            .await
            .map_err(|error| ssh_error("request terminal PTY", error, false))?;
        if let Some(command) = command {
            channel
                .exec(true, command.as_str().to_owned())
                .await
                .map_err(|error| ssh_error("start terminal command", error, false))?;
        } else {
            channel
                .request_shell(true)
                .await
                .map_err(|error| ssh_error("start terminal shell", error, false))?;
        }
        let (mut reader, writer) = channel.split();
        let (events, receiver) = broadcast::channel(SHELL_EVENT_CHANNEL_CAPACITY);
        self.channels
            .lock()
            .await
            .insert(session_id, Arc::new(writer));
        let channels = self.channels.clone();
        tokio::spawn(async move {
            let mut exit_status = None;
            while let Some(message) = reader.wait().await {
                let event = match message {
                    ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                        ShellEvent::Data {
                            bytes: data.to_vec(),
                        }
                    }
                    ChannelMsg::ExitStatus {
                        exit_status: status,
                    } => {
                        exit_status = Some(status);
                        continue;
                    }
                    ChannelMsg::Close => break,
                    _ => continue,
                };
                let _ = events.send(event);
            }
            channels.lock().await.remove(&session_id);
            let _ = events.send(ShellEvent::Closed { exit_status });
        });
        Ok(receiver)
    }
}

#[async_trait]
impl<S> ShellBackend for RusshShellBackend<S>
where
    S: SecretStore + 'static,
{
    async fn open(
        &self,
        session_id: Id,
        connection: &ConnectionHandle,
        size: PtySize,
    ) -> Result<ShellEventReceiver, CoreError> {
        self.open_channel(session_id, connection, size, None).await
    }

    async fn open_command(
        &self,
        session_id: Id,
        connection: &ConnectionHandle,
        size: PtySize,
        command: &crate::TerminalCommand,
    ) -> Result<ShellEventReceiver, CoreError> {
        self.open_channel(session_id, connection, size, Some(command))
            .await
    }

    async fn write(&self, session_id: Id, bytes: &[u8]) -> Result<(), CoreError> {
        let channel = self
            .channels
            .lock()
            .await
            .get(&session_id)
            .cloned()
            .ok_or_else(|| {
                CoreError::new(
                    CoreErrorCode::NotFound,
                    "terminal channel was not found",
                    false,
                )
            })?;
        channel
            .data_bytes(bytes.to_vec())
            .await
            .map_err(|error| ssh_error("write terminal data", error, true))
    }

    async fn resize(&self, session_id: Id, size: PtySize) -> Result<(), CoreError> {
        let channel = self
            .channels
            .lock()
            .await
            .get(&session_id)
            .cloned()
            .ok_or_else(|| {
                CoreError::new(
                    CoreErrorCode::NotFound,
                    "terminal channel was not found",
                    false,
                )
            })?;
        channel
            .window_change(u32::from(size.columns()), u32::from(size.rows()), 0, 0)
            .await
            .map_err(|error| ssh_error("resize terminal PTY", error, true))
    }

    async fn close(&self, session_id: Id) -> Result<(), CoreError> {
        if let Some(channel) = self.channels.lock().await.remove(&session_id) {
            let _ = channel.eof().await;
            channel
                .close()
                .await
                .map_err(|error| ssh_error("close terminal channel", error, false))?;
        }
        Ok(())
    }
}

fn validation(message: &str) -> CoreError {
    CoreError::new(CoreErrorCode::Validation, message, false)
}

fn append_bounded(target: &mut Vec<u8>, bytes: &[u8]) -> Result<(), CoreError> {
    if target.len().saturating_add(bytes.len()) > 4 * 1024 * 1024 {
        return Err(CoreError::new(
            CoreErrorCode::Conflict,
            "remote command output exceeds the 4 MiB capture limit",
            false,
        ));
    }
    target.extend_from_slice(bytes);
    Ok(())
}

fn authentication_error(message: &str) -> CoreError {
    CoreError::new(CoreErrorCode::SshAuthentication, message, false)
}

fn ssh_error(context: &str, error: impl std::fmt::Display, retryable: bool) -> CoreError {
    CoreError::new(
        CoreErrorCode::SshConnection,
        format!("failed to {context}: {error}"),
        retryable,
    )
}
