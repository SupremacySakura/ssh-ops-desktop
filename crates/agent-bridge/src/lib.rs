#![forbid(unsafe_code)]

//! Authenticated private JSONL bridge for the local Agent runtime.

mod context;
mod ipc;
mod sidecar;
mod tools;

pub use context::{AgentContext, AgentContextBuilder};
pub use ipc::{AgentFrame, AgentFrameCodec, AgentStatus, MAX_FRAME_BYTES};
pub use sidecar::{AgentSidecar, SidecarCommand};
pub use tools::{AgentRunScope, ToolDescriptor, ToolRegistry};
