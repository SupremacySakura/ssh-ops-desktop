#![forbid(unsafe_code)]

//! System credential boundary for OpsPilot.

use std::fmt;

use async_trait::async_trait;
use opspilot_domain::{CoreError, Id};
use uuid::Uuid;
use zeroize::Zeroizing;

mod keyring_store;
mod memory_store;

pub use keyring_store::KeyringSecretStore;
pub use memory_store::MemorySecretStore;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SecretKind {
    Password,
    PrivateKey,
    Passphrase,
    ModelApiKey,
    Certificate,
}

impl SecretKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Password => "password",
            Self::PrivateKey => "private_key",
            Self::Passphrase => "passphrase",
            Self::ModelApiKey => "model_api_key",
            Self::Certificate => "certificate",
        }
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct SecretRef(String);

impl SecretRef {
    pub fn from_persisted(value: impl Into<String>) -> Result<Self, CoreError> {
        let value = value.into();
        if value.trim().is_empty() || value.chars().any(char::is_control) {
            return Err(CoreError::new(
                opspilot_domain::CoreErrorCode::Validation,
                "secret reference must be non-empty and contain no control characters",
                false,
            ));
        }

        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn random() -> Self {
        Self(Uuid::new_v4().to_string())
    }
}

pub struct SecretValue(Zeroizing<String>);

impl SecretValue {
    pub fn new(value: impl Into<String>) -> Self {
        Self(Zeroizing::new(value.into()))
    }

    pub fn expose(&self) -> &str {
        self.0.as_str()
    }

    fn into_inner(self) -> Zeroizing<String> {
        self.0
    }
}

impl fmt::Debug for SecretValue {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("[REDACTED]")
    }
}

#[async_trait]
pub trait SecretStore: Send + Sync {
    async fn put(
        &self,
        kind: SecretKind,
        owner_id: Id,
        value: SecretValue,
    ) -> Result<SecretRef, CoreError>;

    async fn get(&self, secret_ref: &SecretRef) -> Result<SecretValue, CoreError>;

    async fn delete(&self, secret_ref: &SecretRef) -> Result<(), CoreError>;
}
