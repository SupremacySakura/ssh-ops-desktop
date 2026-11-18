use async_trait::async_trait;
use opspilot_domain::{CoreError, CoreErrorCode, Id};
use zeroize::Zeroizing;

use crate::{SecretKind, SecretRef, SecretStore, SecretStoreReadiness, SecretValue};

pub const SERVICE: &str = "com.harbor.desktop";
pub const READINESS_ACCOUNT: &str = "__harbor_readiness_probe__";
pub const LEGACY_SERVICE: &str = "com.opspilot.desktop";

/// SecretStore backed by the operating system credential manager.
#[derive(Clone, Copy, Debug, Default)]
pub struct KeyringSecretStore;

impl KeyringSecretStore {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl SecretStore for KeyringSecretStore {
    async fn put(
        &self,
        _kind: SecretKind,
        _owner_id: Id,
        value: SecretValue,
    ) -> Result<SecretRef, CoreError> {
        let secret_ref = SecretRef::random();
        let account = secret_ref.as_str().to_owned();
        let value = value.into_inner();

        run_keyring(move || {
            let entry = keyring::Entry::new(SERVICE, &account)?;
            entry.set_password(value.as_str())
        })
        .await?;

        Ok(secret_ref)
    }

    async fn get(&self, secret_ref: &SecretRef) -> Result<SecretValue, CoreError> {
        let account = secret_ref.as_str().to_owned();
        let value = read_with_legacy_migration(&account).await?;

        Ok(SecretValue::new(value))
    }

    async fn delete(&self, secret_ref: &SecretRef) -> Result<(), CoreError> {
        let account = secret_ref.as_str().to_owned();
        delete_from_services(&account).await
    }
}

impl SecretStoreReadiness for KeyringSecretStore {
    async fn probe_readiness(&self) -> Result<(), CoreError> {
        run_keyring(|| {
            let entry = keyring::Entry::new(SERVICE, READINESS_ACCOUNT)?;
            classify_readiness_probe(entry.get_password())
        })
        .await
    }
}

fn classify_readiness_probe(result: keyring::Result<String>) -> keyring::Result<()> {
    match result {
        Ok(value) => {
            drop(Zeroizing::new(value));
            Ok(())
        }
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error),
    }
}

fn classify_delete(result: keyring::Result<()>) -> keyring::Result<()> {
    match result {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error),
    }
}

async fn read_with_legacy_migration(account: &str) -> Result<String, CoreError> {
    let account = account.to_owned();
    let mut current = read_password(SERVICE, account.clone()).await?;
    match migration_plan(current.is_some()) {
        ReadPlan::Current => current.take().ok_or_else(secret_missing),
        ReadPlan::Legacy => {
            let Some(value) = read_password(LEGACY_SERVICE, account.clone()).await? else {
                return Err(secret_missing());
            };
            let _ = migrate_to_current(&account, &value).await;
            Ok(value)
        }
    }
}

async fn delete_from_services(account: &str) -> Result<(), CoreError> {
    let mut first_error = None;
    for service in delete_order() {
        let service_account = account.to_owned();
        let result = run_keyring(move || {
            let entry = keyring::Entry::new(service, &service_account)?;
            classify_delete(entry.delete_credential())
        })
        .await;
        if let Err(error) = result
            && first_error.is_none()
        {
            first_error = Some(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

fn delete_order() -> &'static [&'static str] {
    &[SERVICE, LEGACY_SERVICE]
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ReadPlan {
    Current,
    Legacy,
}

fn migration_plan(current_exists: bool) -> ReadPlan {
    if current_exists {
        ReadPlan::Current
    } else {
        ReadPlan::Legacy
    }
}

async fn read_password(
    service: &'static str,
    account: String,
) -> Result<Option<String>, CoreError> {
    run_keyring(move || {
        let entry = keyring::Entry::new(service, &account)?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error),
        }
    })
    .await
}

async fn migrate_to_current(account: &str, value: &str) -> Result<(), CoreError> {
    let migration_account = account.to_owned();
    let migration_value = Zeroizing::new(value.to_owned());
    run_keyring(move || {
        let entry = keyring::Entry::new(SERVICE, &migration_account)?;
        entry.set_password(migration_value.as_str())?;
        let legacy = keyring::Entry::new(LEGACY_SERVICE, &migration_account)?;
        classify_delete(legacy.delete_credential())
    })
    .await
}

fn secret_missing() -> CoreError {
    CoreError::new(
        CoreErrorCode::SecretUnavailable,
        "系统凭据库中未找到该凭据",
        false,
    )
}

async fn run_keyring<T, F>(operation: F) -> Result<T, CoreError>
where
    T: Send + 'static,
    F: FnOnce() -> keyring::Result<T> + Send + 'static,
{
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|_error| {
            CoreError::new(
                CoreErrorCode::Internal,
                "系统凭据任务执行失败，请稍后重试",
                false,
            )
        })?
        .map_err(|_error| {
            CoreError::new(
                CoreErrorCode::SecretUnavailable,
                "系统凭据库不可用，请检查系统凭据设置",
                false,
            )
        })
}

#[cfg(test)]
mod tests {
    use super::{
        LEGACY_SERVICE, READINESS_ACCOUNT, ReadPlan, SERVICE, classify_delete,
        classify_readiness_probe, delete_order, migration_plan,
    };

    #[test]
    fn current_service_wins_and_legacy_is_only_a_fallback() {
        assert_eq!(migration_plan(true), ReadPlan::Current);
        assert_eq!(migration_plan(false), ReadPlan::Legacy);
        assert_ne!(SERVICE, LEGACY_SERVICE);
        assert_eq!(delete_order(), [SERVICE, LEGACY_SERVICE]);
    }

    #[test]
    fn readiness_probe_uses_only_the_current_service() {
        assert_eq!(READINESS_ACCOUNT, "__harbor_readiness_probe__");
        assert!(!READINESS_ACCOUNT.contains("opspilot"));
    }

    #[test]
    fn missing_delete_entry_is_already_complete() {
        assert!(classify_delete(Err(keyring::Error::NoEntry)).is_ok());
    }

    #[test]
    fn delete_backend_failure_stays_unavailable() {
        assert!(matches!(
            classify_delete(Err(keyring::Error::NoDefaultStore)),
            Err(keyring::Error::NoDefaultStore)
        ));
    }

    #[test]
    fn missing_probe_entry_still_means_the_store_is_readable() {
        assert!(classify_readiness_probe(Err(keyring::Error::NoEntry)).is_ok());
    }

    #[test]
    fn existing_probe_entry_also_means_the_store_is_readable() {
        assert!(classify_readiness_probe(Ok("readiness-fixture".to_owned())).is_ok());
    }

    #[test]
    fn backend_initialization_failure_means_the_store_is_unavailable() {
        let error = classify_readiness_probe(Err(keyring::Error::NoDefaultStore))
            .expect_err("backend initialization failure must not report readiness");

        assert!(matches!(error, keyring::Error::NoDefaultStore));
    }
}
