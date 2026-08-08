use std::{collections::HashMap, net::IpAddr, sync::Arc};

use opspilot_domain::{CoreError, CoreErrorCode, Id};
use opspilot_secrets::SecretStore;
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{Mutex, oneshot},
};

use crate::{ConnectionHandle, RusshConnectionManager};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TunnelDirection {
    Local,
    Remote,
    Dynamic,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TunnelRule {
    direction: TunnelDirection,
    bind_host: String,
    bind_port: u16,
    target_host: Option<String>,
    target_port: Option<u16>,
}

impl TunnelRule {
    pub fn try_new(
        direction: TunnelDirection,
        bind_host: Option<&str>,
        bind_port: u16,
        target_host: Option<&str>,
        target_port: Option<u16>,
        public_bind_confirmed: bool,
    ) -> Result<Self, CoreError> {
        let bind_host = validate_host(bind_host.unwrap_or("127.0.0.1"), "tunnel bind host")?;
        let public = bind_host
            .parse::<IpAddr>()
            .map(|address| address.is_unspecified())
            .unwrap_or(false);
        if public && !public_bind_confirmed {
            return Err(validation(
                "public tunnel bind requires explicit confirmation",
            ));
        }
        let (target_host, target_port) = match direction {
            TunnelDirection::Local | TunnelDirection::Remote => {
                let host = validate_host(
                    target_host.ok_or_else(|| validation("tunnel target host is required"))?,
                    "tunnel target host",
                )?;
                let port = target_port
                    .filter(|port| *port > 0)
                    .ok_or_else(|| validation("tunnel target port is required"))?;
                (Some(host), Some(port))
            }
            TunnelDirection::Dynamic => {
                if target_host.is_some() || target_port.is_some() {
                    return Err(validation(
                        "dynamic tunnel target is chosen by SOCKS clients",
                    ));
                }
                (None, None)
            }
        };
        Ok(Self {
            direction,
            bind_host,
            bind_port,
            target_host,
            target_port,
        })
    }

    pub fn bind_host(&self) -> &str {
        &self.bind_host
    }

    pub fn bind_port(&self) -> u16 {
        self.bind_port
    }

    pub async fn bind_local(&self) -> Result<TcpListener, CoreError> {
        if self.direction == TunnelDirection::Remote {
            return Err(validation("remote tunnels do not create a local listener"));
        }
        TcpListener::bind((self.bind_host.as_str(), self.bind_port))
            .await
            .map_err(|_| {
                CoreError::new(
                    CoreErrorCode::Conflict,
                    "tunnel bind address is unavailable",
                    false,
                )
            })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct RemoteSocketPath(String);

impl RemoteSocketPath {
    pub fn try_new(value: &str) -> Result<Self, CoreError> {
        if !value.starts_with('/')
            || value.len() > 4096
            || value.chars().any(char::is_control)
            || value.split('/').any(|part| part == "..")
        {
            return Err(validation(
                "remote socket path must be a safe absolute path",
            ));
        }
        Ok(Self(value.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveTunnel {
    pub id: Id,
    pub rule: TunnelRule,
    pub bound_port: u16,
}

struct ActiveTunnelState {
    tunnel: ActiveTunnel,
    close: oneshot::Sender<()>,
}

#[derive(Clone)]
pub struct TunnelManager<S> {
    connections: RusshConnectionManager<S>,
    active: Arc<Mutex<HashMap<Id, ActiveTunnelState>>>,
}

impl<S> TunnelManager<S>
where
    S: SecretStore + 'static,
{
    pub fn new(connections: RusshConnectionManager<S>) -> Self {
        Self {
            connections,
            active: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn open(
        &self,
        connection: ConnectionHandle,
        rule: TunnelRule,
    ) -> Result<ActiveTunnel, CoreError> {
        if rule.direction == TunnelDirection::Remote {
            return Err(CoreError::new(
                CoreErrorCode::CapabilityUnavailable,
                "remote forwarding requires server-initiated channel support",
                false,
            ));
        }
        let listener = rule.bind_local().await?;
        let bound_port = listener
            .local_addr()
            .map_err(|_| {
                CoreError::new(
                    CoreErrorCode::Internal,
                    "tunnel listener address is unavailable",
                    false,
                )
            })?
            .port();
        let tunnel = ActiveTunnel {
            id: Id::new(),
            rule: rule.clone(),
            bound_port,
        };
        let (close, mut closed) = oneshot::channel();
        self.active.lock().await.insert(
            tunnel.id,
            ActiveTunnelState {
                tunnel: tunnel.clone(),
                close,
            },
        );
        let connections = self.connections.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut closed => break,
                    accepted = listener.accept() => {
                        let Ok((mut stream, peer)) = accepted else { break };
                        let connections = connections.clone();
                        let connection = connection.clone();
                        let rule = rule.clone();
                        tokio::spawn(async move {
                            let target = match rule.direction {
                                TunnelDirection::Local => rule.target_host.zip(rule.target_port),
                                TunnelDirection::Dynamic => negotiate_socks5(&mut stream).await.ok(),
                                TunnelDirection::Remote => None,
                            };
                            if let Some((host, port)) = target {
                                let _ = connections
                                    .pipe_direct_tcpip(&connection, stream, &host, port, peer)
                                    .await;
                            }
                        });
                    }
                }
            }
        });
        Ok(tunnel)
    }

    pub async fn close(&self, tunnel_id: Id) -> Result<(), CoreError> {
        if let Some(state) = self.active.lock().await.remove(&tunnel_id) {
            let _ = state.close.send(());
        }
        Ok(())
    }

    pub async fn list(&self) -> Vec<ActiveTunnel> {
        self.active
            .lock()
            .await
            .values()
            .map(|state| state.tunnel.clone())
            .collect()
    }
}

async fn negotiate_socks5(stream: &mut TcpStream) -> Result<(String, u16), CoreError> {
    let mut greeting = [0_u8; 2];
    stream.read_exact(&mut greeting).await.map_err(io_failure)?;
    if greeting[0] != 5 || greeting[1] == 0 {
        return Err(validation("invalid SOCKS5 greeting"));
    }
    let mut methods = vec![0_u8; greeting[1] as usize];
    stream.read_exact(&mut methods).await.map_err(io_failure)?;
    if !methods.contains(&0) {
        stream.write_all(&[5, 0xff]).await.map_err(io_failure)?;
        return Err(validation("SOCKS5 client does not support no-auth mode"));
    }
    stream.write_all(&[5, 0]).await.map_err(io_failure)?;
    let mut request = [0_u8; 4];
    stream.read_exact(&mut request).await.map_err(io_failure)?;
    if request[..3] != [5, 1, 0] {
        return Err(validation("only SOCKS5 CONNECT is supported"));
    }
    let host = match request[3] {
        1 => {
            let mut address = [0_u8; 4];
            stream.read_exact(&mut address).await.map_err(io_failure)?;
            std::net::Ipv4Addr::from(address).to_string()
        }
        3 => {
            let mut length = [0_u8; 1];
            stream.read_exact(&mut length).await.map_err(io_failure)?;
            let mut host = vec![0_u8; length[0] as usize];
            stream.read_exact(&mut host).await.map_err(io_failure)?;
            validate_host(
                std::str::from_utf8(&host).map_err(|_| validation("SOCKS5 hostname is invalid"))?,
                "SOCKS5 hostname",
            )?
        }
        4 => {
            let mut address = [0_u8; 16];
            stream.read_exact(&mut address).await.map_err(io_failure)?;
            std::net::Ipv6Addr::from(address).to_string()
        }
        _ => return Err(validation("SOCKS5 address type is unsupported")),
    };
    let mut port = [0_u8; 2];
    stream.read_exact(&mut port).await.map_err(io_failure)?;
    let port = u16::from_be_bytes(port);
    if port == 0 {
        return Err(validation("SOCKS5 target port is invalid"));
    }
    stream
        .write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 0])
        .await
        .map_err(io_failure)?;
    Ok((host, port))
}

fn validate_host(value: &str, field: &str) -> Result<String, CoreError> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 255
        || value.chars().any(char::is_control)
        || value.chars().any(char::is_whitespace)
        || value.contains("://")
    {
        return Err(validation(&format!("{field} is invalid")));
    }
    Ok(value.to_owned())
}

fn io_failure(_error: std::io::Error) -> CoreError {
    CoreError::new(
        CoreErrorCode::SshConnection,
        "tunnel client disconnected",
        true,
    )
}

fn validation(message: &str) -> CoreError {
    CoreError::new(CoreErrorCode::Validation, message, false)
}
