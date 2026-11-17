use std::sync::Arc;

use opspilot_persistence::Database;
use opspilot_secrets::{KeyringSecretStore, SecretStore};

mod catalog;
mod health;

pub(crate) use catalog::{
    server_create, server_credential_set, server_delete, server_group_create, server_group_delete,
    server_group_list, server_group_update, server_list, server_update,
};
pub(crate) use health::core_health;

#[derive(Clone)]
pub(crate) struct CoreServices<S = KeyringSecretStore> {
    pub(crate) database: Database,
    pub(crate) secret_store: Arc<S>,
}

impl<S> CoreServices<S>
where
    S: SecretStore + 'static,
{
    pub(crate) fn new(database: Database, secret_store: S) -> Self {
        Self {
            database,
            secret_store: Arc::new(secret_store),
        }
    }
}
