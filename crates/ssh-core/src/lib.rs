#![forbid(unsafe_code)]

//! SSH connection, host identity, terminal, and file-transfer boundaries.

mod auth;
mod connection;
mod known_hosts;
mod openssh;
mod russh_backend;
mod sftp;
mod terminal;
mod tunnel;

pub use auth::{AuthRequest, AuthResolver, ResolvedAuth};
pub use connection::{ConnectionEvent, ConnectionMachine, ConnectionState};
pub use known_hosts::{HostEndpoint, HostKeyDecision, HostKeyVerifier, HostPublicKey};
pub use openssh::{OpenSshArgs, OpenSshServer, SshConfigImporter, SshConfigPreview};
pub use russh_backend::{
    ConnectOutcome, ConnectionRequest, ExecOutput, HostKeyProbe, HostKeyPrompt,
    RusshConnectionManager, RusshShellBackend,
};
pub use sftp::{
    ConflictPolicy, LocalSftpAdapter, RemotePath, TransferCheckpoint, TransferFailure,
    UploadOptions, UploadResult,
};
pub use terminal::{
    ConnectionHandle, InMemoryShellBackend, PtySize, ShellBackend, TerminalCommand, TerminalData,
    TerminalManager, TerminalSession,
};
pub use tunnel::{ActiveTunnel, RemoteSocketPath, TunnelDirection, TunnelManager, TunnelRule};
