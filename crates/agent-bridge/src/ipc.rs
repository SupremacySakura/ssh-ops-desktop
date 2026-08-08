use std::io;

use opspilot_domain::{CoreError, CoreErrorCode, Id};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};

pub const MAX_FRAME_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AgentFrame {
    Hello {
        version: u8,
        request_id: Id,
        session_id: Id,
        challenge: String,
        session_token: String,
        storage_url: String,
    },
    #[serde(rename = "hello.ack")]
    HelloAck {
        version: u8,
        request_id: Id,
        session_id: Id,
        proof: String,
    },
    Request {
        version: u8,
        request_id: Id,
        method: String,
        payload: Value,
    },
    Response {
        version: u8,
        request_id: Id,
        ok: bool,
        #[serde(default)]
        payload: Value,
        #[serde(default)]
        error: Option<CoreError>,
    },
    Heartbeat {
        version: u8,
        timestamp: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    Ready,
    Closed,
    Degraded,
}

pub struct AgentFrameCodec<R, W> {
    reader: BufReader<R>,
    writer: W,
}

impl<R, W> AgentFrameCodec<R, W>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    pub fn new(reader: R, writer: W) -> Self {
        Self {
            reader: BufReader::new(reader),
            writer,
        }
    }

    pub async fn write(&mut self, frame: &AgentFrame) -> Result<(), CoreError> {
        let bytes = serde_json::to_vec(frame).map_err(protocol_error)?;
        if bytes.is_empty() || bytes.len() > MAX_FRAME_BYTES {
            return Err(sidecar_error("Agent IPC frame exceeds 1 MiB"));
        }
        self.writer.write_all(&bytes).await.map_err(io_error)?;
        self.writer.write_all(b"\n").await.map_err(io_error)?;
        self.writer.flush().await.map_err(io_error)
    }

    pub async fn read(&mut self) -> Result<AgentFrame, CoreError> {
        let mut bytes = Vec::new();
        loop {
            let available = self.reader.fill_buf().await.map_err(io_error)?;
            if available.is_empty() {
                return Err(sidecar_error("Agent Sidecar closed its protocol stream"));
            }
            if let Some(newline) = available.iter().position(|byte| *byte == b'\n') {
                if bytes.len() + newline > MAX_FRAME_BYTES {
                    return Err(sidecar_error("Agent IPC frame exceeds 1 MiB"));
                }
                bytes.extend_from_slice(&available[..newline]);
                self.reader.consume(newline + 1);
                break;
            }
            if bytes.len() + available.len() > MAX_FRAME_BYTES {
                return Err(sidecar_error("Agent IPC frame exceeds 1 MiB"));
            }
            let consumed = available.len();
            bytes.extend_from_slice(available);
            self.reader.consume(consumed);
        }
        let frame: AgentFrame = serde_json::from_slice(&bytes)
            .map_err(|_| sidecar_error("Agent Sidecar emitted an invalid protocol frame"))?;
        validate_frame(&frame)?;
        Ok(frame)
    }
}

fn validate_frame(frame: &AgentFrame) -> Result<(), CoreError> {
    let version = match frame {
        AgentFrame::Hello { version, .. }
        | AgentFrame::HelloAck { version, .. }
        | AgentFrame::Request { version, .. }
        | AgentFrame::Response { version, .. }
        | AgentFrame::Heartbeat { version, .. } => *version,
    };
    if version != 1 {
        return Err(sidecar_error("Agent IPC version is unsupported"));
    }
    Ok(())
}

fn protocol_error(error: serde_json::Error) -> CoreError {
    sidecar_error(&format!("failed to encode Agent IPC frame: {error}"))
}
fn io_error(error: io::Error) -> CoreError {
    sidecar_error(&format!("Agent IPC transport failed: {error}"))
}
fn sidecar_error(message: &str) -> CoreError {
    CoreError::new(CoreErrorCode::SidecarUnavailable, message, true)
}
