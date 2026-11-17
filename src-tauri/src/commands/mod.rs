use std::{collections::HashMap, sync::Arc, time::Duration};

use opspilot_persistence::Database;
use opspilot_secrets::{KeyringSecretStore, SecretStore};
use opspilot_ssh_core::{
    ConnectionHandle, RusshConnectionManager, RusshShellBackend, TerminalManager,
};
use tokio::sync::Mutex;

mod catalog;
mod connection;
mod health;
mod terminal;

pub(crate) use catalog::{
    server_create, server_credential_set, server_delete, server_group_create, server_group_delete,
    server_group_list, server_group_update, server_list, server_update,
};
pub(crate) use connection::{connection_connect, connection_disconnect, connection_trust_host_key};
pub(crate) use health::core_health;
pub(crate) use terminal::{terminal_close, terminal_open, terminal_resize, terminal_write};

#[derive(Clone)]
pub(crate) struct CoreServices<S = KeyringSecretStore> {
    pub(crate) database: Database,
    pub(crate) secret_store: Arc<S>,
    pub(crate) connection_manager: RusshConnectionManager<S>,
    pub(crate) terminal_manager: TerminalManager<RusshShellBackend<S>>,
    connection_sequences: Arc<Mutex<HashMap<opspilot_domain::Id, u64>>>,
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
        Self {
            database,
            secret_store,
            connection_manager,
            terminal_manager,
            connection_sequences: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub(crate) async fn next_connection_sequence(&self, server_id: opspilot_domain::Id) -> u64 {
        let mut sequences = self.connection_sequences.lock().await;
        let sequence = sequences.entry(server_id).or_insert(0);
        *sequence = sequence.saturating_add(1);
        *sequence
    }

    pub(crate) async fn shutdown(&self) {
        let _ = self.terminal_manager.close_all().await;
        self.connection_manager.disconnect_all().await;
    }

    pub(crate) async fn register_connection(
        &self,
        connection: &ConnectionHandle,
    ) -> Result<(), opspilot_domain::CoreError> {
        self.terminal_manager.register_connection(connection).await
    }
}
