use std::{fmt, path::PathBuf};

use opspilot_domain::{CoreError, CoreErrorCode};
use opspilot_secrets::{SecretRef, SecretStore, SecretValue};

#[derive(Clone, Debug)]
pub enum AuthRequest {
    Password {
        secret_ref: SecretRef,
    },
    PrivateKey {
        path: PathBuf,
        passphrase_ref: Option<SecretRef>,
    },
    SshAgent,
    Certificate {
        certificate_path: PathBuf,
        private_key_path: PathBuf,
        passphrase_ref: Option<SecretRef>,
        expected_principal: String,
    },
}

pub enum ResolvedAuth {
    Password(SecretValue),
    PrivateKey {
        path: PathBuf,
        passphrase: Option<SecretValue>,
    },
    SshAgent,
    Certificate {
        certificate_path: PathBuf,
        private_key_path: PathBuf,
        passphrase: Option<SecretValue>,
        expected_principal: String,
    },
}

impl fmt::Debug for ResolvedAuth {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let kind = match self {
            Self::Password(_) => "Password([REDACTED])",
            Self::PrivateKey { .. } => "PrivateKey([REDACTED])",
            Self::SshAgent => "SshAgent",
            Self::Certificate { .. } => "Certificate([REDACTED])",
        };
        formatter.write_str(kind)
    }
}

pub struct AuthResolver<'a, S> {
    store: &'a S,
}

impl<'a, S> AuthResolver<'a, S>
where
    S: SecretStore,
{
    pub fn new(store: &'a S) -> Self {
        Self { store }
    }

    pub async fn resolve(&self, request: AuthRequest) -> Result<ResolvedAuth, CoreError> {
        match request {
            AuthRequest::Password { secret_ref } => {
                Ok(ResolvedAuth::Password(self.store.get(&secret_ref).await?))
            }
            AuthRequest::PrivateKey {
                path,
                passphrase_ref,
            } => {
                validate_private_key_path(&path)?;
                let passphrase = self.resolve_optional(passphrase_ref.as_ref()).await?;
                Ok(ResolvedAuth::PrivateKey { path, passphrase })
            }
            AuthRequest::SshAgent => Ok(ResolvedAuth::SshAgent),
            AuthRequest::Certificate {
                certificate_path,
                private_key_path,
                passphrase_ref,
                expected_principal,
            } => {
                validate_certificate_path(&certificate_path)?;
                validate_private_key_path(&private_key_path)?;
                let expected_principal = expected_principal.trim();
                if expected_principal.is_empty() || expected_principal.chars().any(char::is_control)
                {
                    return Err(validation("certificate principal is invalid"));
                }
                let passphrase = self.resolve_optional(passphrase_ref.as_ref()).await?;
                Ok(ResolvedAuth::Certificate {
                    certificate_path,
                    private_key_path,
                    passphrase,
                    expected_principal: expected_principal.to_owned(),
                })
            }
        }
    }

    async fn resolve_optional(
        &self,
        secret_ref: Option<&SecretRef>,
    ) -> Result<Option<SecretValue>, CoreError> {
        match secret_ref {
            Some(secret_ref) => self.store.get(secret_ref).await.map(Some),
            None => Ok(None),
        }
    }
}

fn validate_certificate_path(path: &PathBuf) -> Result<(), CoreError> {
    let metadata = std::fs::metadata(path).map_err(|_| {
        CoreError::new(
            CoreErrorCode::SshAuthentication,
            "SSH certificate file is unavailable",
            false,
        )
    })?;
    if !metadata.is_file() {
        return Err(validation(
            "SSH certificate path must reference a regular file",
        ));
    }
    Ok(())
}

fn validate_private_key_path(path: &PathBuf) -> Result<(), CoreError> {
    let metadata = std::fs::metadata(path).map_err(|_| {
        CoreError::new(
            CoreErrorCode::SshAuthentication,
            "SSH private key file is unavailable",
            false,
        )
    })?;
    if !metadata.is_file() {
        return Err(validation(
            "SSH private key path must reference a regular file",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        if metadata.permissions().mode() & 0o002 != 0 {
            return Err(CoreError::new(
                CoreErrorCode::RemotePermission,
                "SSH private key file must not be world-writable",
                false,
            ));
        }
    }
    Ok(())
}

fn validation(message: &str) -> CoreError {
    CoreError::new(CoreErrorCode::Validation, message, false)
}
