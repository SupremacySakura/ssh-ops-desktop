use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

use opspilot_persistence::Database;
use opspilot_secrets::{KeyringSecretStore, SecretStore};

use self::ssh_config_import::SshConfigPreviewRegistry;

mod catalog;
mod health;
mod ssh_config_import;

pub(crate) use catalog::{
    server_create, server_credential_set, server_delete, server_group_create, server_group_delete,
    server_group_list, server_group_update, server_list, server_update,
};
pub(crate) use health::core_health;
pub(crate) use ssh_config_import::{ssh_config_import_apply, ssh_config_import_preview};

#[derive(Clone)]
pub(crate) struct CoreServices<S = KeyringSecretStore> {
    pub(crate) database: Database,
    pub(crate) secret_store: Arc<S>,
    pub(crate) ssh_config_path: Option<PathBuf>,
    pub(crate) ssh_config_previews: Arc<Mutex<SshConfigPreviewRegistry>>,
}

impl<S> CoreServices<S>
where
    S: SecretStore + 'static,
{
    pub(crate) fn new(database: Database, secret_store: S) -> Self {
        Self {
            database,
            secret_store: Arc::new(secret_store),
            ssh_config_path: None,
            ssh_config_previews: Arc::new(Mutex::new(SshConfigPreviewRegistry::default())),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_ssh_config_path(mut self, path: PathBuf) -> Self {
        self.ssh_config_path = Some(path);
        self
    }
}
