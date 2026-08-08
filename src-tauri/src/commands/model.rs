use opspilot_domain::{CoreError, CoreErrorCode, Id};
use opspilot_persistence::{ModelProfileInput, ModelProfileRepository, ModelProfileSummary};
use opspilot_secrets::{SecretKind, SecretStore, SecretValue};
use serde::Deserialize;
use tauri::State;

use super::CoreServices;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ModelProfileSaveRequest {
    id: Option<Id>,
    name: String,
    provider: String,
    base_url: String,
    model: String,
    timeout_ms: u32,
    api_key: Option<String>,
    clear_api_key: Option<bool>,
    is_default: Option<bool>,
}

#[tauri::command]
pub(crate) async fn model_profile_list(
    services: State<'_, CoreServices>,
) -> Result<Vec<ModelProfileSummary>, CoreError> {
    ModelProfileRepository::new(services.database.clone())
        .list()
        .await
}

#[tauri::command]
pub(crate) async fn model_profile_save(
    services: State<'_, CoreServices>,
    request: ModelProfileSaveRequest,
) -> Result<ModelProfileSummary, CoreError> {
    save_model_profile(&services.database, services.secret_store.as_ref(), request).await
}

#[tauri::command]
pub(crate) async fn model_profile_delete(
    services: State<'_, CoreServices>,
    profile_id: Id,
) -> Result<(), CoreError> {
    let repository = ModelProfileRepository::new(services.database.clone());
    if let Some(secret) = repository.secret_ref(profile_id).await? {
        services.secret_store.delete(&secret).await?;
    }
    repository.delete(profile_id).await?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn model_profile_test_connection(
    services: State<'_, CoreServices>,
    profile_id: Id,
) -> Result<(), CoreError> {
    let repository = ModelProfileRepository::new(services.database.clone());
    let profile = repository.get(profile_id).await?;
    let secret = match repository.secret_ref(profile_id).await? {
        Some(secret_ref) => Some(services.secret_store.get(&secret_ref).await?),
        None => None,
    };
    let payload = serde_json::json!({
        "profile": {
            "baseUrl": profile.base_url,
            "model": profile.model,
            "timeoutMs": profile.timeout_ms,
        },
        "apiKey": secret.as_ref().map(|value| value.expose()),
    });
    let result = {
        let sidecar = services.agent_sidecar.lock().await;
        let sidecar = sidecar.as_ref().ok_or_else(|| {
            CoreError::new(
                CoreErrorCode::SidecarUnavailable,
                "Agent Sidecar is unavailable; model connection was not attempted",
                true,
            )
        })?;
        sidecar.request("model.test", payload).await
    };
    drop(secret);
    result.map(|_| ())
}

async fn save_model_profile<S: SecretStore>(
    database: &opspilot_persistence::Database,
    secrets: &S,
    request: ModelProfileSaveRequest,
) -> Result<ModelProfileSummary, CoreError> {
    if request.provider != "openai-compatible" {
        return Err(CoreError::new(
            CoreErrorCode::Validation,
            "only openai-compatible model profiles are supported",
            false,
        ));
    }
    let clear = request.clear_api_key.unwrap_or(false);
    if clear && request.api_key.is_some() {
        return Err(CoreError::new(
            CoreErrorCode::Validation,
            "apiKey and clearApiKey are mutually exclusive",
            false,
        ));
    }
    let repository = ModelProfileRepository::new(database.clone());
    let owner_id = request.id.unwrap_or_default();
    let input = ModelProfileInput::try_new(
        Some(owner_id),
        &request.name,
        &request.base_url,
        &request.model,
        request.timeout_ms,
        request.is_default.unwrap_or(false),
    )?;
    let previous = if request.id.is_some() {
        repository.secret_ref(owner_id).await?
    } else {
        None
    };
    if clear && let Some(secret) = &previous {
        secrets.delete(secret).await?;
    }
    let replacement = match request.api_key {
        Some(value) => {
            if value.is_empty() || value.len() > 64 * 1024 {
                return Err(CoreError::new(
                    CoreErrorCode::Validation,
                    "model API key must contain 1 byte to 64 KiB",
                    false,
                ));
            }
            Some(
                secrets
                    .put(SecretKind::ModelApiKey, owner_id, SecretValue::new(value))
                    .await?,
            )
        }
        None => None,
    };
    let saved = repository.save(input, replacement.as_ref(), clear).await;
    let (summary, replaced) = match saved {
        Ok(saved) => saved,
        Err(error) => {
            if let Some(secret) = &replacement {
                let _ = secrets.delete(secret).await;
            }
            return Err(error);
        }
    };
    if let Some(secret) = replaced {
        secrets.delete(&secret).await?;
    }
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use opspilot_persistence::Database;
    use opspilot_secrets::MemorySecretStore;

    use super::{ModelProfileSaveRequest, save_model_profile};

    #[tokio::test]
    async fn api_key_never_enters_sqlite_or_profile_summary() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("profiles.sqlite3");
        let database = Database::open(&path).await.unwrap();
        let secret_store = MemorySecretStore::default();
        let fixture_key = "mvp-fixture-model-key-do-not-persist";
        let summary = save_model_profile(
            &database,
            &secret_store,
            ModelProfileSaveRequest {
                id: None,
                name: "Local".to_owned(),
                provider: "openai-compatible".to_owned(),
                base_url: "http://127.0.0.1:11434/v1".to_owned(),
                model: "fixture".to_owned(),
                timeout_ms: 30_000,
                api_key: Some(fixture_key.to_owned()),
                clear_api_key: None,
                is_default: Some(true),
            },
        )
        .await
        .unwrap();
        assert!(summary.has_api_key);
        drop(database);
        let bytes = std::fs::read(path).unwrap();
        assert!(
            !bytes
                .windows(fixture_key.len())
                .any(|window| window == fixture_key.as_bytes())
        );
    }
}
