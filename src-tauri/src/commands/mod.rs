use std::sync::Arc;

use opspilot_persistence::Database;
use opspilot_secrets::{KeyringSecretStore, SecretStore};

mod health;

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
