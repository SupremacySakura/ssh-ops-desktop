use opspilot_persistence::Database;
use opspilot_secrets::{KeyringSecretStore, SecretStoreReadiness};
use serde::Serialize;
use tauri::{AppHandle, Manager};

#[derive(Clone, Debug)]
pub(crate) struct CoreServices<S = KeyringSecretStore> {
    database: Database,
    secret_store: S,
}

impl<S> CoreServices<S> {
    pub(crate) fn new(database: Database, secret_store: S) -> Self {
        Self {
            database,
            secret_store,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CoreHealth {
    version: &'static str,
    database_ready: bool,
    secret_store_ready: bool,
}

pub(crate) async fn read_core_health<S>(services: &CoreServices<S>) -> CoreHealth
where
    S: SecretStoreReadiness,
{
    let database_ready = sqlx::query_scalar::<_, i64>("SELECT 1")
        .fetch_one(services.database.pool())
        .await
        .is_ok();
    let secret_store_ready = services.secret_store.probe_readiness().await.is_ok();

    CoreHealth {
        version: env!("CARGO_PKG_VERSION"),
        database_ready,
        secret_store_ready,
    }
}

#[tauri::command]
pub(crate) async fn core_health(app: AppHandle) -> CoreHealth {
    let services = app
        .state::<CoreServices<KeyringSecretStore>>()
        .inner()
        .clone();

    read_core_health(&services).await
}

#[cfg(test)]
mod tests {
    use opspilot_domain::{CoreError, CoreErrorCode};
    use opspilot_persistence::Database;
    use opspilot_secrets::{MemorySecretStore, SecretStoreReadiness};

    use super::{CoreServices, read_core_health};

    #[derive(Debug)]
    struct UnavailableSecretStore;

    impl SecretStoreReadiness for UnavailableSecretStore {
        async fn probe_readiness(&self) -> Result<(), CoreError> {
            Err(CoreError::new(
                CoreErrorCode::SecretUnavailable,
                "credential store unavailable",
                false,
            ))
        }
    }

    #[tokio::test]
    async fn reports_explicit_database_and_secret_store_readiness() {
        let database = Database::open(":memory:")
            .await
            .expect("in-memory database should open");
        let services = CoreServices::new(database, MemorySecretStore::default());

        let health = read_core_health(&services).await;

        assert_eq!(health.version, env!("CARGO_PKG_VERSION"));
        assert!(health.database_ready);
        assert!(health.secret_store_ready);
    }

    #[tokio::test]
    async fn reports_an_unavailable_secret_store_as_not_ready() {
        let database = Database::open(":memory:")
            .await
            .expect("in-memory database should open");
        let services = CoreServices::new(database, UnavailableSecretStore);

        let health = read_core_health(&services).await;

        assert!(!health.secret_store_ready);
    }
}
