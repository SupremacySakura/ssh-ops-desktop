use std::{path::PathBuf, process::Stdio, time::Duration};

use opspilot_domain::{CoreError, CoreErrorCode, Id};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::{
    process::{Child, Command},
    sync::Mutex,
};

use crate::{AgentFrame, AgentFrameCodec, AgentStatus};

#[derive(Clone, Debug)]
pub struct SidecarCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub storage_url: String,
}

pub struct AgentSidecar {
    child: Child,
    codec: Mutex<AgentFrameCodec<tokio::process::ChildStdout, tokio::process::ChildStdin>>,
    session_id: Id,
    status: AgentStatus,
}

impl AgentSidecar {
    pub async fn start(command: SidecarCommand) -> Result<Self, CoreError> {
        let stderr = if std::env::var_os("OPSPILOT_AGENT_DEBUG").is_some() {
            Stdio::inherit()
        } else {
            Stdio::null()
        };
        let mut child = Command::new(&command.program)
            .args(&command.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // The protocol is stdout-only. Discard stderr until a bounded, redacted
            // diagnostic collector exists so an undrained pipe cannot deadlock the child.
            .stderr(stderr)
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| sidecar_error(&format!("failed to start Agent Sidecar: {error}")))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| sidecar_error("Agent Sidecar stdin is unavailable"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| sidecar_error("Agent Sidecar stdout is unavailable"))?;
        let mut codec = AgentFrameCodec::new(stdout, stdin);
        let session_id = Id::new();
        let request_id = Id::new();
        let token = random_secret();
        let challenge = random_secret();
        codec
            .write(&AgentFrame::Hello {
                version: 1,
                request_id,
                session_id,
                challenge: challenge.clone(),
                session_token: token.clone(),
                storage_url: command.storage_url,
            })
            .await?;
        let reply = tokio::time::timeout(Duration::from_secs(5), codec.read())
            .await
            .map_err(|_| sidecar_error("Agent Sidecar handshake timed out"))??;
        let AgentFrame::HelloAck {
            request_id: actual_request,
            session_id: actual_session,
            proof,
            ..
        } = reply
        else {
            return Err(sidecar_error(
                "Agent Sidecar did not acknowledge the handshake",
            ));
        };
        if actual_request != request_id || actual_session != session_id {
            return Err(sidecar_error(
                "Agent Sidecar handshake scope does not match",
            ));
        }
        let provided = hex_decode(&proof)?;
        verify_handshake_proof(&token, session_id, &challenge, &provided)?;
        Ok(Self {
            child,
            codec: Mutex::new(codec),
            session_id,
            status: AgentStatus::Ready,
        })
    }

    pub fn status(&self) -> AgentStatus {
        self.status.clone()
    }

    pub async fn request(&self, method: &str, payload: Value) -> Result<Value, CoreError> {
        if method.trim().is_empty() || method.len() > 128 || method.chars().any(char::is_control) {
            return Err(CoreError::new(
                CoreErrorCode::Validation,
                "Agent method is invalid",
                false,
            ));
        }
        let request_id = Id::new();
        let mut codec = self.codec.lock().await;
        codec
            .write(&AgentFrame::Request {
                version: 1,
                request_id,
                method: method.to_owned(),
                payload,
            })
            .await?;
        loop {
            match tokio::time::timeout(Duration::from_secs(30), codec.read())
                .await
                .map_err(|_| sidecar_error("Agent request timed out"))??
            {
                AgentFrame::Heartbeat { .. } => continue,
                AgentFrame::Response {
                    request_id: actual,
                    ok: true,
                    payload,
                    ..
                } if actual == request_id => return Ok(payload),
                AgentFrame::Response {
                    request_id: actual,
                    ok: false,
                    error,
                    ..
                } if actual == request_id => {
                    return Err(error.unwrap_or_else(|| sidecar_error("Agent request failed")));
                }
                _ => return Err(sidecar_error("Agent Sidecar response correlation failed")),
            }
        }
    }

    pub async fn shutdown(mut self) -> Result<(), CoreError> {
        let _ = self.request("shutdown", Value::Null).await;
        match tokio::time::timeout(Duration::from_secs(2), self.child.wait()).await {
            Ok(Ok(_)) => Ok(()),
            _ => {
                self.child.kill().await.map_err(|error| {
                    sidecar_error(&format!("failed to stop Agent Sidecar: {error}"))
                })?;
                Ok(())
            }
        }
    }

    pub fn session_id(&self) -> Id {
        self.session_id
    }
}

fn verify_handshake_proof(
    token: &str,
    session_id: Id,
    challenge: &str,
    provided: &[u8],
) -> Result<(), CoreError> {
    let token = hex_decode(token)?;
    let mut message = session_id.to_string().into_bytes();
    message.extend_from_slice(challenge.as_bytes());
    let expected = hmac_sha256(&token, &message);
    let matches = expected.len() == provided.len()
        && expected
            .iter()
            .zip(provided)
            .fold(0_u8, |difference, (left, right)| {
                difference | (left ^ right)
            })
            == 0;
    if matches {
        Ok(())
    } else {
        Err(sidecar_error("Agent Sidecar proof is invalid"))
    }
}

fn random_secret() -> String {
    let first = Id::new().to_string();
    let second = Id::new().to_string();
    Sha256::digest(format!("{first}{second}").as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn hex_decode(value: &str) -> Result<Vec<u8>, CoreError> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(sidecar_error("Agent proof encoding is invalid"));
    }
    (0..value.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&value[index..index + 2], 16)
                .map_err(|_| sidecar_error("Agent proof encoding is invalid"))
        })
        .collect()
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> Vec<u8> {
    const BLOCK_BYTES: usize = 64;
    let mut normalized = [0_u8; BLOCK_BYTES];
    if key.len() > BLOCK_BYTES {
        normalized[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        normalized[..key.len()].copy_from_slice(key);
    }
    let mut inner_pad = [0x36_u8; BLOCK_BYTES];
    let mut outer_pad = [0x5c_u8; BLOCK_BYTES];
    for index in 0..BLOCK_BYTES {
        inner_pad[index] ^= normalized[index];
        outer_pad[index] ^= normalized[index];
    }
    let mut inner = Sha256::new();
    inner.update(inner_pad);
    inner.update(message);
    let inner_digest = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(outer_pad);
    outer.update(inner_digest);
    outer.finalize().to_vec()
}

fn sidecar_error(message: &str) -> CoreError {
    CoreError::new(CoreErrorCode::SidecarUnavailable, message, true)
}
