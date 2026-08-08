use std::str::FromStr;

use opspilot_domain::{CoreError, CoreErrorCode, Id};
use opspilot_secrets::SecretRef;
use serde::{Deserialize, Serialize};

use crate::Database;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModelProfileInput {
    pub id: Option<Id>,
    pub name: String,
    pub base_url: String,
    pub model: String,
    pub timeout_ms: u32,
    pub is_default: bool,
}

impl ModelProfileInput {
    pub fn try_new(
        id: Option<Id>,
        name: &str,
        base_url: &str,
        model: &str,
        timeout_ms: u32,
        is_default: bool,
    ) -> Result<Self, CoreError> {
        if !(1_000..=300_000).contains(&timeout_ms) {
            return Err(validation(
                "model timeout must be between 1 and 300 seconds",
            ));
        }
        Ok(Self {
            id,
            name: safe_text(name, "model profile name", 128)?,
            base_url: validate_base_url(base_url)?,
            model: safe_text(model, "model name", 256)?,
            timeout_ms,
            is_default,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelProfileSummary {
    pub id: Id,
    pub name: String,
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub timeout_ms: u32,
    pub has_api_key: bool,
    pub is_default: bool,
}

#[derive(Clone, Debug)]
pub struct ModelProfileRepository {
    database: Database,
}

impl ModelProfileRepository {
    pub fn new(database: Database) -> Self {
        Self { database }
    }

    pub async fn list(&self) -> Result<Vec<ModelProfileSummary>, CoreError> {
        let rows = sqlx::query_as::<_, ModelProfileRow>(
            "SELECT id, name, provider, base_url, model, timeout_ms,
                    api_key_secret_ref, is_default
             FROM model_profiles ORDER BY is_default DESC, lower(name), id",
        )
        .fetch_all(self.database.pool())
        .await
        .map_err(|error| persistence_error("list model profiles", error))?;
        rows.into_iter()
            .map(ModelProfileRow::into_summary)
            .collect()
    }

    pub async fn get(&self, id: Id) -> Result<ModelProfileSummary, CoreError> {
        self.row(id).await?.into_summary()
    }

    pub async fn secret_ref(&self, id: Id) -> Result<Option<SecretRef>, CoreError> {
        self.row(id)
            .await?
            .api_key_secret_ref
            .map(SecretRef::from_persisted)
            .transpose()
    }

    pub async fn save(
        &self,
        input: ModelProfileInput,
        replacement_secret: Option<&SecretRef>,
        clear_api_key: bool,
    ) -> Result<(ModelProfileSummary, Option<SecretRef>), CoreError> {
        if replacement_secret.is_some() && clear_api_key {
            return Err(validation(
                "API key replacement and clearing are mutually exclusive",
            ));
        }
        let id = input.id.unwrap_or_default();
        let existing = sqlx::query_scalar::<_, Option<String>>(
            "SELECT api_key_secret_ref FROM model_profiles WHERE id = ?",
        )
        .bind(id.to_string())
        .fetch_optional(self.database.pool())
        .await
        .map_err(|error| persistence_error("read existing model profile", error))?;
        let old_ref = existing
            .flatten()
            .map(SecretRef::from_persisted)
            .transpose()?;
        let chosen_ref = if let Some(secret) = replacement_secret {
            Some(secret.clone())
        } else if clear_api_key {
            None
        } else {
            old_ref.clone()
        };

        let mut transaction = self
            .database
            .pool()
            .begin()
            .await
            .map_err(|error| persistence_error("begin model profile save", error))?;
        if input.is_default {
            sqlx::query("UPDATE model_profiles SET is_default = 0 WHERE is_default = 1")
                .execute(&mut *transaction)
                .await
                .map_err(|error| persistence_error("clear default model profile", error))?;
        }
        if input.id.is_some() {
            sqlx::query("UPDATE model_profiles SET api_key_secret_ref = NULL WHERE id = ?")
                .bind(id.to_string())
                .execute(&mut *transaction)
                .await
                .map_err(|error| persistence_error("detach model API key reference", error))?;
        }
        if let Some(old) = &old_ref {
            sqlx::query("DELETE FROM secret_refs WHERE ref = ?")
                .bind(old.as_str())
                .execute(&mut *transaction)
                .await
                .map_err(|error| persistence_error("replace model API key reference", error))?;
        }
        if let Some(secret) = &chosen_ref {
            sqlx::query(
                "INSERT INTO secret_refs (ref, kind, owner_type, owner_id, created_at, updated_at)
                 VALUES (?, 'model_api_key', 'model_profile', ?,
                         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
            )
            .bind(secret.as_str())
            .bind(id.to_string())
            .execute(&mut *transaction)
            .await
            .map_err(|error| persistence_error("persist model API key reference", error))?;
        }
        sqlx::query(
            "INSERT INTO model_profiles (
                id, name, provider, base_url, model, timeout_ms, api_key_secret_ref,
                is_default, created_at, updated_at
             ) VALUES (?, ?, 'openai-compatible', ?, ?, ?, ?, ?,
                       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name, base_url = excluded.base_url, model = excluded.model,
                timeout_ms = excluded.timeout_ms, api_key_secret_ref = excluded.api_key_secret_ref,
                is_default = excluded.is_default,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
        )
        .bind(id.to_string())
        .bind(&input.name)
        .bind(&input.base_url)
        .bind(&input.model)
        .bind(i64::from(input.timeout_ms))
        .bind(chosen_ref.as_ref().map(SecretRef::as_str))
        .bind(input.is_default)
        .execute(&mut *transaction)
        .await
        .map_err(|error| persistence_error("save model profile", error))?;
        transaction
            .commit()
            .await
            .map_err(|error| persistence_error("commit model profile save", error))?;
        Ok((
            self.get(id).await?,
            old_ref.filter(|old| Some(old) != chosen_ref.as_ref()),
        ))
    }

    pub async fn delete(&self, id: Id) -> Result<Option<SecretRef>, CoreError> {
        let secret = self.secret_ref(id).await?;
        let mut transaction = self
            .database
            .pool()
            .begin()
            .await
            .map_err(|error| persistence_error("begin model profile deletion", error))?;
        let deleted = sqlx::query("DELETE FROM model_profiles WHERE id = ?")
            .bind(id.to_string())
            .execute(&mut *transaction)
            .await
            .map_err(|error| persistence_error("delete model profile", error))?;
        if deleted.rows_affected() != 1 {
            return Err(CoreError::new(
                CoreErrorCode::NotFound,
                "model profile was not found",
                false,
            ));
        }
        if let Some(secret) = &secret {
            sqlx::query("DELETE FROM secret_refs WHERE ref = ?")
                .bind(secret.as_str())
                .execute(&mut *transaction)
                .await
                .map_err(|error| persistence_error("delete model API key reference", error))?;
        }
        transaction
            .commit()
            .await
            .map_err(|error| persistence_error("commit model profile deletion", error))?;
        Ok(secret)
    }

    async fn row(&self, id: Id) -> Result<ModelProfileRow, CoreError> {
        sqlx::query_as(
            "SELECT id, name, provider, base_url, model, timeout_ms,
                    api_key_secret_ref, is_default FROM model_profiles WHERE id = ?",
        )
        .bind(id.to_string())
        .fetch_optional(self.database.pool())
        .await
        .map_err(|error| persistence_error("get model profile", error))?
        .ok_or_else(|| {
            CoreError::new(
                CoreErrorCode::NotFound,
                "model profile was not found",
                false,
            )
        })
    }
}

#[derive(sqlx::FromRow)]
struct ModelProfileRow {
    id: String,
    name: String,
    provider: String,
    base_url: String,
    model: String,
    timeout_ms: i64,
    api_key_secret_ref: Option<String>,
    is_default: bool,
}

impl ModelProfileRow {
    fn into_summary(self) -> Result<ModelProfileSummary, CoreError> {
        Ok(ModelProfileSummary {
            id: Id::from_str(&self.id).map_err(|_| invariant("model profile id is invalid"))?,
            name: self.name,
            provider: self.provider,
            base_url: self.base_url,
            model: self.model,
            timeout_ms: u32::try_from(self.timeout_ms)
                .map_err(|_| invariant("model timeout is invalid"))?,
            has_api_key: self.api_key_secret_ref.is_some(),
            is_default: self.is_default,
        })
    }
}

fn validate_base_url(value: &str) -> Result<String, CoreError> {
    let value = safe_text(value, "model base URL", 2048)?;
    if value.contains('#') {
        return Err(validation("model base URL must not contain a fragment"));
    }
    let (secure, authority_and_path) = if let Some(rest) = value.strip_prefix("https://") {
        (true, rest)
    } else if let Some(rest) = value.strip_prefix("http://") {
        (false, rest)
    } else {
        return Err(validation("model base URL must use HTTP(S)"));
    };
    let authority = authority_and_path.split('/').next().unwrap_or_default();
    if authority.is_empty() || authority.contains('@') {
        return Err(validation("model base URL must not contain credentials"));
    }
    let host = authority
        .rsplit_once(':')
        .map_or(authority, |(host, _)| host);
    let loopback = matches!(host, "localhost" | "127.0.0.1" | "[::1]");
    if !secure && !loopback {
        return Err(validation("non-loopback model endpoints must use HTTPS"));
    }
    Ok(value)
}

fn safe_text(value: &str, field: &str, max: usize) -> Result<String, CoreError> {
    let value = value.trim();
    if value.is_empty() || value.len() > max || value.chars().any(char::is_control) {
        return Err(validation(&format!("{field} is invalid")));
    }
    Ok(value.to_owned())
}
fn validation(message: &str) -> CoreError {
    CoreError::new(CoreErrorCode::Validation, message, false)
}
fn invariant(message: &str) -> CoreError {
    CoreError::new(CoreErrorCode::Internal, message, false)
}
fn persistence_error(context: &str, error: impl std::fmt::Display) -> CoreError {
    CoreError::new(
        CoreErrorCode::Internal,
        format!("failed to {context}: {error}"),
        false,
    )
}
