use std::str::FromStr;

use opspilot_domain::{CoreError, CoreErrorCode, Id};
use opspilot_secrets::{
    KeyringSecretStore, MemorySecretStore, SecretKind, SecretRef, SecretStore, SecretValue,
};
use uuid::{Uuid, Version};

const OWNER_ID: &str = "018f6f3e-568d-7efc-8c68-f813c8f8f96a";
const FIXTURE_SECRET: &str = "credential-fixture-value";

#[test]
fn secret_value_debug_is_always_redacted() {
    let value = SecretValue::new(FIXTURE_SECRET);

    assert_eq!(format!("{value:?}"), "[REDACTED]");
}

#[test]
fn persisted_secret_refs_round_trip_without_exposing_an_empty_account() {
    let secret_ref = SecretRef::from_persisted("legacy-secret-ref")
        .expect("non-empty persisted ref should be accepted");
    assert_eq!(secret_ref.as_str(), "legacy-secret-ref");

    for invalid in ["", "   ", "line\nbreak"] {
        let error = SecretRef::from_persisted(invalid)
            .expect_err("blank or control-character refs should be rejected");
        assert_eq!(error.code(), CoreErrorCode::Validation);
    }
}

#[tokio::test]
async fn memory_store_satisfies_secret_store_contract() {
    exercise_store_contract(&MemorySecretStore::default())
        .await
        .expect("memory store contract should pass");
}

#[tokio::test]
#[ignore = "requires explicit access to the operating-system credential store"]
async fn system_keyring_satisfies_secret_store_contract() {
    exercise_store_contract(&KeyringSecretStore::new())
        .await
        .expect("system keyring contract should pass");
}

async fn exercise_store_contract(store: &impl SecretStore) -> Result<(), CoreError> {
    let owner_id = Id::from_str(OWNER_ID).expect("owner ID fixture should be valid");
    let secret_ref = store
        .put(
            SecretKind::Password,
            owner_id,
            SecretValue::new(FIXTURE_SECRET),
        )
        .await?;
    let parsed_ref = Uuid::parse_str(secret_ref.as_str());
    let differs_from_owner = secret_ref.as_str() != OWNER_ID;
    let fetched = store.get(&secret_ref).await;
    let deleted = store.delete(&secret_ref).await;
    let fetched = fetched?;
    deleted?;

    let parsed_ref = parsed_ref.expect("secret ref should be a UUID");
    assert_eq!(parsed_ref.get_version(), Some(Version::Random));
    assert!(differs_from_owner);
    assert!(fetched.expose() == FIXTURE_SECRET);

    let missing = store
        .get(&secret_ref)
        .await
        .expect_err("deleted secret should no longer be readable");
    assert_eq!(missing.code(), CoreErrorCode::SecretUnavailable);
    store
        .delete(&secret_ref)
        .await
        .expect("deleting an already absent secret must be idempotent");

    Ok(())
}
