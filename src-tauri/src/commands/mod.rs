use std::sync::Arc;

use opspilot_audit::{AuditWriter, Redactor};
use opspilot_persistence::Database;
use opspilot_secrets::KeyringSecretStore;
use tokio::sync::Mutex;

mod health;
mod server;

pub(crate) use health::core_health;
pub(crate) use server::{
    server_create, server_delete, server_group_create, server_group_delete, server_group_list,
    server_group_update, server_import_apply, server_import_preview, server_list,
    server_tag_create, server_tag_delete, server_tag_list, server_tag_update, server_update,
};

#[derive(Clone, Debug)]
pub(crate) struct CoreServices<S = KeyringSecretStore> {
    pub(crate) database: Database,
    pub(crate) secret_store: S,
    pub(crate) audit_writer: AuditWriter,
    pub(crate) import_previews: Arc<Mutex<server::ImportPreviewStore>>,
}

impl<S> CoreServices<S> {
    pub(crate) fn new(database: Database, secret_store: S) -> Self {
        Self {
            audit_writer: AuditWriter::new(database.clone(), Redactor::default()),
            database,
            secret_store,
            import_previews: Arc::new(Mutex::new(server::ImportPreviewStore::default())),
        }
    }
}
