use std::collections::HashMap;

use async_trait::async_trait;
use opspilot_domain::{CoreError, CoreErrorCode, Id};
use tokio::sync::RwLock;
use zeroize::Zeroizing;

use crate::{SecretKind, SecretRef, SecretStore, SecretStoreReadiness, SecretValue};

/// In-memory SecretStore used by unit and integration tests.
#[derive(Debug, Default)]
pub struct MemorySecretStore {
    values: RwLock<HashMap<SecretRef, Zeroizing<String>>>,
}

#[async_trait]
impl SecretStore for MemorySecretStore {
    async fn put(
        &self,
        _kind: SecretKind,
        _owner_id: Id,
        value: SecretValue,
    ) -> Result<SecretRef, CoreError> {
        let secret_ref = SecretRef::random();
        self.values
            .write()
            .await
            .insert(secret_ref.clone(), value.into_inner());
        Ok(secret_ref)
    }

    async fn get(&self, secret_ref: &SecretRef) -> Result<SecretValue, CoreError> {
        let values = self.values.read().await;
        let value = values.get(secret_ref).ok_or_else(secret_unavailable)?;
        Ok(SecretValue::new(value.as_str()))
    }

    async fn delete(&self, secret_ref: &SecretRef) -> Result<(), CoreError> {
        self.values
            .write()
            .await
            .remove(secret_ref)
            .map(|_| ())
            .ok_or_else(secret_unavailable)
    }
}

impl SecretStoreReadiness for MemorySecretStore {
    async fn probe_readiness(&self) -> Result<(), CoreError> {
        Ok(())
    }
}

fn secret_unavailable() -> CoreError {
    CoreError::new(
        CoreErrorCode::SecretUnavailable,
        "secret reference is unavailable",
        false,
    )
}
