#![forbid(unsafe_code)]

//! SSH connection, host identity, terminal, and file-transfer boundaries.

mod auth;
mod connection;
mod known_hosts;
mod openssh;
mod russh_backend;
mod sftp;
mod terminal;

pub use auth::{AuthRequest, AuthResolver, ResolvedAuth};
pub use connection::{ConnectionEvent, ConnectionMachine, ConnectionState};
pub use known_hosts::{HostEndpoint, HostKeyDecision, HostKeyVerifier, HostPublicKey};
pub use openssh::{
    OpenSshArgs, OpenSshServer, SshConfigEntry, SshConfigFile, SshConfigImporter, SshConfigParse,
    SshConfigWarning, read_ssh_config,
};
pub use russh_backend::{
    ConnectOutcome, ConnectionRequest, ExecOutput, HostKeyChangedPrompt, HostKeyProbe,
    HostKeyPrompt, RusshConnectionManager, RusshShellBackend,
};
pub use sftp::{
    ConflictPolicy, LocalSftpAdapter, RemotePath, TransferCheckpoint, TransferFailure,
    UploadOptions, UploadResult,
};
pub use terminal::{
    ConnectionHandle, InMemoryShellBackend, MAX_TERMINAL_SESSIONS_PER_SERVER,
    MAX_TERMINAL_WRITE_BYTES, PtySize, SHELL_EVENT_CHANNEL_CAPACITY, ShellBackend, ShellEvent,
    ShellEventReceiver, TerminalCloseReason, TerminalClosed, TerminalCommand, TerminalData,
    TerminalEvent, TerminalGap, TerminalManager, TerminalSession,
};
