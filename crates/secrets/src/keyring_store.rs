use async_trait::async_trait;
use opspilot_domain::{CoreError, CoreErrorCode, Id};
use zeroize::Zeroizing;

use crate::{SecretKind, SecretRef, SecretStore, SecretStoreReadiness, SecretValue};

const SERVICE: &str = "com.opspilot.desktop";
const READINESS_ACCOUNT: &str = "__opspilot_readiness_probe__";

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
        let value = run_keyring(move || {
            let entry = keyring::Entry::new(SERVICE, &account)?;
            entry.get_password()
        })
        .await?;

        Ok(SecretValue::new(value))
    }

    async fn delete(&self, secret_ref: &SecretRef) -> Result<(), CoreError> {
        let account = secret_ref.as_str().to_owned();
        run_keyring(move || {
            let entry = keyring::Entry::new(SERVICE, &account)?;
            entry.delete_credential()
        })
        .await
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

async fn run_keyring<T, F>(operation: F) -> Result<T, CoreError>
where
    T: Send + 'static,
    F: FnOnce() -> keyring::Result<T> + Send + 'static,
{
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|error| {
            CoreError::new(
                CoreErrorCode::Internal,
                format!("system credential task failed: {error}"),
                false,
            )
        })?
        .map_err(|error| {
            CoreError::new(
                CoreErrorCode::SecretUnavailable,
                format!("system credential operation failed: {error}"),
                false,
            )
        })
}

#[cfg(test)]
mod tests {
    use super::classify_readiness_probe;

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
