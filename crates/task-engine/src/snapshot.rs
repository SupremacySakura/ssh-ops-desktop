use async_trait::async_trait;
use opspilot_domain::{CoreError, CoreErrorCode};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SnapshotRef {
    id: String,
    checksum: String,
}

impl SnapshotRef {
    pub fn try_new(id: &str, checksum: String) -> Result<Self, CoreError> {
        let id = id.trim();
        if id.is_empty() || id.chars().any(char::is_control) {
            return Err(validation("snapshot identifier is invalid"));
        }
        if checksum.len() != 64 || !checksum.chars().all(|value| value.is_ascii_hexdigit()) {
            return Err(validation("snapshot checksum must be a SHA-256 digest"));
        }
        Ok(Self {
            id: id.to_owned(),
            checksum: checksum.to_lowercase(),
        })
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn checksum(&self) -> &str {
        &self.checksum
    }
}

#[async_trait]
pub trait Snapshotter: Send + Sync {
    async fn create(&self) -> Result<SnapshotRef, CoreError>;
    async fn restore(&self, snapshot: &SnapshotRef) -> Result<(), CoreError>;
}

fn validation(message: &str) -> CoreError {
    CoreError::new(CoreErrorCode::Validation, message, false)
}
