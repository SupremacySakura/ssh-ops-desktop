use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex as StdMutex},
    time::Duration,
};

use opspilot_persistence::Database;
use opspilot_secrets::{KeyringSecretStore, SecretStore};
use opspilot_ssh_core::{
    ConnectionHandle, RemoteFileService, RusshConnectionManager, RusshSftpConnector,
    RusshShellBackend, TerminalManager,
};
use tokio::sync::Mutex;

use self::file::FileOperations;
use self::ssh_config_import::SshConfigPreviewRegistry;

mod catalog;
mod connection;
mod file;
mod health;
mod ssh_config_import;
mod terminal;

pub(crate) use catalog::{
    server_create, server_credential_set, server_delete, server_group_create, server_group_delete,
    server_group_list, server_group_update, server_list, server_update,
};
pub(crate) use connection::{connection_connect, connection_disconnect, connection_trust_host_key};
pub(crate) use file::{file_download, file_list, file_read, file_write};
pub(crate) use health::core_health;
pub(crate) use ssh_config_import::{ssh_config_import_apply, ssh_config_import_preview};
pub(crate) use terminal::{terminal_close, terminal_open, terminal_resize, terminal_write};

#[derive(Clone)]
pub(crate) struct CoreServices<S = KeyringSecretStore> {
    pub(crate) database: Database,
    pub(crate) secret_store: Arc<S>,
    pub(crate) connection_manager: RusshConnectionManager<S>,
    pub(crate) terminal_manager: TerminalManager<RusshShellBackend<S>>,
    pub(crate) file_operations: Arc<dyn FileOperations>,
    connection_sequences: Arc<Mutex<HashMap<opspilot_domain::Id, u64>>>,
    pub(crate) ssh_config_path: Option<PathBuf>,
    pub(crate) ssh_config_previews: Arc<StdMutex<SshConfigPreviewRegistry>>,
}

impl<S> CoreServices<S>
where
    S: SecretStore + Send + Sync + 'static,
{
    pub(crate) fn new(database: Database, secret_store: S) -> Self {
        let secret_store = Arc::new(secret_store);
        let connection_manager = RusshConnectionManager::new(
            database.clone(),
            secret_store.clone(),
            Duration::from_secs(5 * 60),
        );
        let terminal_manager =
            TerminalManager::new(RusshShellBackend::new(connection_manager.clone()));
        let file_operations = Arc::new(RemoteFileService::new(Arc::new(RusshSftpConnector::new(
            connection_manager.clone(),
        ))));
        Self {
            database,
            secret_store,
            connection_manager,
            terminal_manager,
            file_operations,
            connection_sequences: Arc::new(Mutex::new(HashMap::new())),
            ssh_config_path: None,
            ssh_config_previews: Arc::new(StdMutex::new(SshConfigPreviewRegistry::default())),
        }
    }

    pub(crate) async fn next_connection_sequence(&self, server_id: opspilot_domain::Id) -> u64 {
        let mut sequences = self.connection_sequences.lock().await;
        let sequence = sequences.entry(server_id).or_insert(0);
        *sequence = sequence.saturating_add(1);
        *sequence
    }

    pub(crate) async fn shutdown(&self) {
        if self.terminal_manager.close_all().await.is_err() {
            self.terminal_manager.discard_all().await;
        }
        self.connection_manager.disconnect_all().await;
    }

    pub(crate) async fn register_connection(
        &self,
        connection: &ConnectionHandle,
    ) -> Result<(), opspilot_domain::CoreError> {
        self.terminal_manager.register_connection(connection).await
    }

    #[cfg(test)]
    pub(crate) fn with_ssh_config_path(mut self, path: PathBuf) -> Self {
        self.ssh_config_path = Some(path);
        self
    }
}
