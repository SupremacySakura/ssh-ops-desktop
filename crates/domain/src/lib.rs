#![forbid(unsafe_code)]

//! Shared Harbor domain contracts.

mod error;
mod id;
mod server;
mod validation;

pub use error::{CoreError, CoreErrorCode};
pub use id::Id;
pub use server::{AuthType, Host, Server, ServerGroup, ServerInput, ServerPort};
