use opspilot_domain::Id;
use opspilot_persistence::{Database, ModelProfileInput, ModelProfileRepository};
use opspilot_secrets::SecretRef;

#[tokio::test]
async fn stores_only_secret_references_and_maintains_one_default() {
    let database = Database::open(":memory:").await.unwrap();
    let repository = ModelProfileRepository::new(database.clone());
    let first_ref = SecretRef::from_persisted("model-key-reference-1").unwrap();
    let (first, _) = repository
        .save(
            input(None, "Primary", "https://models.example.com/v1", true),
            Some(&first_ref),
            false,
        )
        .await
        .unwrap();
    let (second, _) = repository
        .save(
            input(None, "Local", "http://127.0.0.1:11434/v1", true),
            None,
            false,
        )
        .await
        .unwrap();
    let profiles = repository.list().await.unwrap();
    assert_eq!(
        profiles.iter().filter(|profile| profile.is_default).count(),
        1
    );
    assert!(
        profiles
            .iter()
            .find(|profile| profile.id == first.id)
            .unwrap()
            .has_api_key
    );
    assert!(
        profiles
            .iter()
            .find(|profile| profile.id == second.id)
            .unwrap()
            .is_default
    );

    let stored: String = sqlx::query_scalar("SELECT group_concat(ref, ',') FROM secret_refs")
        .fetch_one(database.pool())
        .await
        .unwrap();
    assert_eq!(stored, first_ref.as_str());
}

#[tokio::test]
async fn rejects_insecure_non_loopback_model_endpoints() {
    assert!(
        ModelProfileInput::try_new(
            Some(Id::new()),
            "Bad",
            "http://models.example.com/v1",
            "model",
            30_000,
            false,
        )
        .is_err()
    );
}

fn input(id: Option<Id>, name: &str, base_url: &str, is_default: bool) -> ModelProfileInput {
    ModelProfileInput::try_new(id, name, base_url, "example-model", 30_000, is_default).unwrap()
}
