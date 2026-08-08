use opspilot_domain::{AuthType, ServerEnvironment, ServerInput};
use opspilot_persistence::{Database, ServerRepository};
use opspilot_secrets::SecretRef;

#[tokio::test]
async fn replaces_only_the_expected_server_owned_credential_reference() {
    let database = Database::open(":memory:").await.unwrap();
    let repository = ServerRepository::new(database);
    let server = repository
        .create(
            ServerInput::try_new(
                "web-01",
                "example.com",
                22,
                "deploy",
                ServerEnvironment::Production,
                AuthType::Password,
                None,
                vec![],
            )
            .unwrap(),
        )
        .await
        .unwrap();
    let first = SecretRef::from_persisted("fixture-first").unwrap();
    repository
        .replace_connection_secret_ref(server.id, None, &first, "password")
        .await
        .unwrap();
    assert_eq!(
        repository.connection_secret_ref(server.id).await.unwrap(),
        Some(first.clone()),
    );

    let second = SecretRef::from_persisted("fixture-second").unwrap();
    repository
        .replace_connection_secret_ref(server.id, Some(&first), &second, "password")
        .await
        .unwrap();
    assert_eq!(
        repository.connection_secret_ref(server.id).await.unwrap(),
        Some(second),
    );
}
