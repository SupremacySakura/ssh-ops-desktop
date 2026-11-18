#![forbid(unsafe_code)]

//! SSH connection, host identity, terminal, and file-transfer boundaries.

mod auth;
mod connection;
mod known_hosts;
mod openssh;
mod remote_files;
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
pub use remote_files::{
    CreateFileFailure, FILE_DOWNLOAD_WARNING_BYTES, FILE_UPLOAD_WARNING_BYTES,
    MAX_EDIT_WRITE_BYTES, MAX_EDITABLE_FILE_BYTES, MAX_FILE_DOWNLOAD_BYTES, MAX_FILE_UPLOAD_BYTES,
    MAX_UPLOAD_BATCH_BYTES, MAX_UPLOAD_BATCH_FILES, RemoteFileDownload, RemoteFileEntry,
    RemoteFileKind, RemoteFileMutationResult, RemoteFileService, RemoteFileWriteResult,
    RemoteRenameResult, RemoteTextFile, RemoteUploadFile, RemoteUploadOutcome, RenameStatus,
    RusshSftpConnector, ScopedDirectoryEntry, ScopedMetadata, ScopedSftp, SftpConnector,
    UploadBatchStatus,
};
pub use russh_backend::{
    ConnectOutcome, ConnectionRequest, ExecOutput, HostKeyChangedPrompt, HostKeyProbe,
    HostKeyPrompt, RusshConnectionManager, RusshShellBackend,
};
pub use sftp::{RemoteDirectoryPath, RemotePath};
pub use terminal::{
    ConnectionHandle, InMemoryShellBackend, MAX_TERMINAL_SESSIONS_PER_SERVER,
    MAX_TERMINAL_WRITE_BYTES, PtySize, SHELL_EVENT_CHANNEL_CAPACITY, ShellBackend, ShellEvent,
    ShellEventReceiver, TerminalCloseReason, TerminalClosed, TerminalCommand, TerminalData,
    TerminalEvent, TerminalGap, TerminalManager, TerminalSession,
};
