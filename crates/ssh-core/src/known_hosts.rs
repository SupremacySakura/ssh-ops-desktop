use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, SystemTime},
};

use base64::{Engine as _, engine::general_purpose::STANDARD_NO_PAD};
use chrono::{DateTime, SecondsFormat, Utc};
use opspilot_domain::{CoreError, CoreErrorCode, Id};
use opspilot_persistence::Database;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostEndpoint {
    server_id: Id,
    host: String,
    port: u16,
}

impl HostEndpoint {
    pub fn try_new(server_id: Id, host: &str, port: u32) -> Result<Self, CoreError> {
        let host = host.trim().to_lowercase();
        if host.is_empty()
            || host.contains("://")
            || host.chars().any(char::is_control)
            || host.chars().any(char::is_whitespace)
        {
            return Err(validation(
                "SSH host must be a non-empty hostname without a URL scheme",
            ));
        }
        let port = u16::try_from(port)
            .ok()
            .filter(|port| *port > 0)
            .ok_or_else(|| validation("SSH port must be between 1 and 65535"))?;
        Ok(Self {
            server_id,
            host,
            port,
        })
    }

    pub fn server_id(&self) -> Id {
        self.server_id
    }

    pub fn host(&self) -> &str {
        &self.host
    }

    pub fn port(&self) -> u16 {
        self.port
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostPublicKey {
    algorithm: String,
    encoded: String,
    sha256: String,
}

impl HostPublicKey {
    pub fn try_new(algorithm: &str, encoded: &[u8]) -> Result<Self, CoreError> {
        let algorithm = algorithm.trim();
        if algorithm.is_empty() || algorithm.chars().any(char::is_control) || encoded.is_empty() {
            return Err(validation("SSH host public key is invalid"));
        }
        let digest = Sha256::digest(encoded);
        Ok(Self {
            algorithm: algorithm.to_owned(),
            encoded: STANDARD_NO_PAD.encode(encoded),
            sha256: format!("SHA256:{}", STANDARD_NO_PAD.encode(digest)),
        })
    }

    pub fn algorithm(&self) -> &str {
        &self.algorithm
    }

    pub fn sha256(&self) -> &str {
        &self.sha256
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HostKeyDecision {
    Trusted,
    Unknown {
        verification_id: Id,
        algorithm: String,
        sha256: String,
        expires_at: SystemTime,
    },
    Changed {
        verification_id: Id,
        expected_sha256: String,
        actual_sha256: String,
        expires_at: SystemTime,
    },
}

#[derive(Clone, Debug)]
struct PendingVerification {
    endpoint: HostEndpoint,
    key: HostPublicKey,
    expected_sha256: Option<String>,
    expires_at: SystemTime,
}

#[derive(Clone, Debug)]
pub struct HostKeyVerifier {
    database: Database,
    ttl: Duration,
    pending: Arc<Mutex<HashMap<Id, PendingVerification>>>,
}

impl HostKeyVerifier {
    pub fn new(database: Database, ttl: Duration) -> Self {
        Self {
            database,
            ttl,
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn verify(
        &self,
        endpoint: &HostEndpoint,
        key: &HostPublicKey,
    ) -> Result<HostKeyDecision, CoreError> {
        self.verify_at(endpoint, key, SystemTime::now()).await
    }

    pub async fn verify_at(
        &self,
        endpoint: &HostEndpoint,
        key: &HostPublicKey,
        now: SystemTime,
    ) -> Result<HostKeyDecision, CoreError> {
        let trusted: Option<(String,)> = sqlx::query_as(
            "SELECT sha256 FROM known_host_keys
             WHERE server_id = ? AND host = ? AND port = ?",
        )
        .bind(endpoint.server_id.to_string())
        .bind(&endpoint.host)
        .bind(i64::from(endpoint.port))
        .fetch_optional(self.database.pool())
        .await
        .map_err(|error| persistence_error("read trusted SSH host key", error))?;

        if let Some((expected_sha256,)) = trusted {
            return if expected_sha256 == key.sha256 {
                Ok(HostKeyDecision::Trusted)
            } else {
                let (verification_id, expires_at) = self
                    .insert_pending(endpoint, key, Some(expected_sha256.clone()), now)
                    .await?;
                Ok(HostKeyDecision::Changed {
                    verification_id,
                    expected_sha256,
                    actual_sha256: key.sha256.clone(),
                    expires_at,
                })
            };
        }

        let (verification_id, expires_at) = self.insert_pending(endpoint, key, None, now).await?;
        Ok(HostKeyDecision::Unknown {
            verification_id,
            algorithm: key.algorithm.clone(),
            sha256: key.sha256.clone(),
            expires_at,
        })
    }

    pub async fn trust(
        &self,
        verification_id: Id,
        endpoint: &HostEndpoint,
        key: &HostPublicKey,
    ) -> Result<(), CoreError> {
        self.trust_at(verification_id, endpoint, key, SystemTime::now())
            .await
    }

    pub async fn trust_pending(
        &self,
        verification_id: Id,
        endpoint: &HostEndpoint,
    ) -> Result<(), CoreError> {
        let key = self
            .pending
            .lock()
            .await
            .get(&verification_id)
            .map(|pending| pending.key.clone())
            .ok_or_else(|| {
                CoreError::new(
                    CoreErrorCode::NotFound,
                    "host-key verification was not found or was already consumed",
                    false,
                )
            })?;
        self.trust(verification_id, endpoint, &key).await
    }

    pub async fn trust_at(
        &self,
        verification_id: Id,
        endpoint: &HostEndpoint,
        key: &HostPublicKey,
        now: SystemTime,
    ) -> Result<(), CoreError> {
        let pending = self
            .pending
            .lock()
            .await
            .get(&verification_id)
            .cloned()
            .ok_or_else(|| {
                CoreError::new(
                    CoreErrorCode::NotFound,
                    "host-key verification was not found or was already consumed",
                    false,
                )
            })?;

        if now > pending.expires_at {
            self.pending.lock().await.remove(&verification_id);
            return Err(CoreError::new(
                CoreErrorCode::NotFound,
                "host-key verification expired",
                false,
            ));
        }
        if pending.endpoint != *endpoint || pending.key != *key {
            return Err(CoreError::new(
                CoreErrorCode::Conflict,
                "host-key verification does not match the connection target",
                false,
            ));
        }

        let trusted_at = DateTime::<Utc>::from(now).to_rfc3339_opts(SecondsFormat::Millis, true);
        let persisted = if let Some(expected_sha256) = &pending.expected_sha256 {
            sqlx::query_scalar::<_, String>(
                "UPDATE known_host_keys SET
                    algorithm = ?,
                    public_key_base64 = ?,
                    sha256 = ?,
                    trusted_at = ?
                 WHERE server_id = ? AND host = ? AND port = ? AND sha256 = ?
                 RETURNING sha256",
            )
            .bind(&key.algorithm)
            .bind(&key.encoded)
            .bind(&key.sha256)
            .bind(trusted_at)
            .bind(endpoint.server_id.to_string())
            .bind(&endpoint.host)
            .bind(i64::from(endpoint.port))
            .bind(expected_sha256)
            .fetch_optional(self.database.pool())
            .await
            .map_err(|error| persistence_error("replace explicitly trusted SSH host key", error))?
        } else {
            sqlx::query_scalar::<_, String>(
                "INSERT INTO known_host_keys (
                    server_id, host, port, algorithm, public_key_base64, sha256, trusted_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(server_id, host, port) DO NOTHING
                 RETURNING sha256",
            )
            .bind(endpoint.server_id.to_string())
            .bind(&endpoint.host)
            .bind(i64::from(endpoint.port))
            .bind(&key.algorithm)
            .bind(&key.encoded)
            .bind(&key.sha256)
            .bind(trusted_at)
            .fetch_optional(self.database.pool())
            .await
            .map_err(|error| persistence_error("persist trusted SSH host key", error))?
        };

        if persisted.is_none() {
            self.pending.lock().await.remove(&verification_id);
            let current: Option<(String,)> = sqlx::query_as(
                "SELECT sha256 FROM known_host_keys
                 WHERE server_id = ? AND host = ? AND port = ?",
            )
            .bind(endpoint.server_id.to_string())
            .bind(&endpoint.host)
            .bind(i64::from(endpoint.port))
            .fetch_optional(self.database.pool())
            .await
            .map_err(|error| persistence_error("re-read trusted SSH host key", error))?;
            return match current {
                Some((expected_sha256,)) if expected_sha256 != key.sha256 => Err(CoreError::new(
                    CoreErrorCode::SshHostKeyChanged,
                    "SSH host key changed; the trusted fingerprint cannot be replaced implicitly",
                    false,
                )),
                Some(_) => Err(CoreError::new(
                    CoreErrorCode::Internal,
                    "trusted SSH host key write did not complete",
                    false,
                )),
                None => Err(CoreError::new(
                    CoreErrorCode::Conflict,
                    "SSH host-key trust raced with a concurrent change",
                    true,
                )),
            };
        }
        self.pending.lock().await.remove(&verification_id);
        Ok(())
    }

    async fn insert_pending(
        &self,
        endpoint: &HostEndpoint,
        key: &HostPublicKey,
        expected_sha256: Option<String>,
        now: SystemTime,
    ) -> Result<(Id, SystemTime), CoreError> {
        let verification_id = Id::new();
        let expires_at = now.checked_add(self.ttl).ok_or_else(|| {
            CoreError::new(CoreErrorCode::Internal, "host-key expiry overflow", false)
        })?;
        let mut pending = self.pending.lock().await;
        pending.retain(|_, candidate| candidate.expires_at >= now);
        pending.insert(
            verification_id,
            PendingVerification {
                endpoint: endpoint.clone(),
                key: key.clone(),
                expected_sha256,
                expires_at,
            },
        );
        Ok((verification_id, expires_at))
    }
}

fn validation(message: &str) -> CoreError {
    CoreError::new(CoreErrorCode::Validation, message, false)
}

fn persistence_error(context: &str, error: impl std::fmt::Display) -> CoreError {
    CoreError::new(
        CoreErrorCode::Internal,
        format!("failed to {context}: {error}"),
        false,
    )
}
