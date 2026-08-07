use async_trait::async_trait;
use opspilot_domain::{CoreError, CoreErrorCode, Id};

use crate::{SecretKind, SecretRef, SecretStore, SecretValue};

const SERVICE: &str = "com.opspilot.desktop";

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
