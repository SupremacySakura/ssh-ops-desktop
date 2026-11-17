use opspilot_domain::{AuthType, CoreErrorCode, ServerInput};
use opspilot_persistence::{Database, ServerRepository};

#[tokio::test]
async fn server_round_trips_through_the_repository() {
    let database = Database::open(":memory:")
        .await
        .expect("in-memory database should open");
    let repository = ServerRepository::new(database);
    let input = ServerInput::try_new(
        "prod-web-01",
        "prod.example.com",
        22,
        "deploy",
        AuthType::Key,
        "secret-ref-fixture",
        None,
        true,
    )
    .expect("valid server input should be accepted");

    let created = repository
        .create(&input, 1_700_000_000)
        .await
        .expect("server should be created");
    let fetched = repository
        .get(created.id)
        .await
        .expect("created server should be readable");
    let listed = repository.list().await.expect("servers should be listed");

    assert_eq!(fetched, created);
    assert_eq!(listed, vec![created.clone()]);
    assert_eq!(created.name, "prod-web-01");
    assert_eq!(created.host, "prod.example.com");
    assert_eq!(created.port, 22);
    assert_eq!(created.user, "deploy");
    assert_eq!(created.auth_type, AuthType::Key);
    assert_eq!(created.secret_ref, "secret-ref-fixture");
    assert!(created.favorite);
    assert_eq!(created.created_at, 1_700_000_000);
}

#[tokio::test]
async fn server_identity_is_unique_across_the_catalog() {
    let database = Database::open(":memory:")
        .await
        .expect("in-memory database should open");
    let repository = ServerRepository::new(database);
    let input = ServerInput::try_new(
        "prod-web-01",
        "prod.example.com",
        22,
        "deploy",
        AuthType::Key,
        "secret-ref-fixture",
        None,
        false,
    )
    .expect("valid server input should be accepted");
    repository
        .create(&input, 1_700_000_000)
        .await
        .expect("initial server should be created");

    let duplicate = repository
        .create(&input, 1_700_000_001)
        .await
        .expect_err("duplicate server identity must be rejected");

    assert_eq!(duplicate.code(), CoreErrorCode::Conflict);
    assert!(duplicate.message().contains("主机、端口和用户名"));
    assert!(!duplicate.message().contains("secret-ref-fixture"));
}

#[tokio::test]
async fn server_update_changes_the_editable_namplate_without_resetting_history() {
    let database = Database::open(":memory:")
        .await
        .expect("in-memory database should open");
    let repository = ServerRepository::new(database);
    let original = repository
        .create(
            &ServerInput::try_new(
                "prod-web-01",
                "prod.example.com",
                22,
                "deploy",
                AuthType::Key,
                "secret-ref-fixture",
                None,
                false,
            )
            .expect("valid server input should be accepted"),
            1_700_000_000,
        )
        .await
        .expect("server should be created");
    let updated_input = ServerInput::try_new(
        "prod-web-02",
        "web-02.example.com",
        2222,
        "ops",
        AuthType::Password,
        "next-secret-ref-fixture",
        None,
        true,
    )
    .expect("valid update input should be accepted");

    let updated = repository
        .update(original.id, &updated_input)
        .await
        .expect("server should be updated");

    assert_eq!(updated.id, original.id);
    assert_eq!(updated.name, "prod-web-02");
    assert_eq!(updated.host, "web-02.example.com");
    assert_eq!(updated.port, 2222);
    assert_eq!(updated.user, "ops");
    assert_eq!(updated.auth_type, AuthType::Password);
    assert_eq!(updated.secret_ref, "next-secret-ref-fixture");
    assert!(updated.favorite);
    assert_eq!(updated.created_at, original.created_at);
    assert_eq!(updated.last_connected_at, original.last_connected_at);
}

#[tokio::test]
async fn catalog_places_favorites_first_then_recent_connections() {
    let database = Database::open(":memory:")
        .await
        .expect("in-memory database should open");
    let repository = ServerRepository::new(database);
    let recent = repository
        .create(&server_input("recent", "recent.example.com", false), 100)
        .await
        .expect("recent server should be created");
    let older = repository
        .create(&server_input("older", "older.example.com", false), 100)
        .await
        .expect("older server should be created");
    let favorite = repository
        .create(
            &server_input("favorite", "favorite.example.com", false),
            100,
        )
        .await
        .expect("favorite server should be created");

    repository
        .mark_connected(older.id, 200)
        .await
        .expect("older server should record a connection");
    repository
        .mark_connected(recent.id, 300)
        .await
        .expect("recent server should record a connection");
    let favorite = repository
        .set_favorite(favorite.id, true)
        .await
        .expect("favorite state should be updated");

    let listed = repository.list().await.expect("servers should be listed");

    assert_eq!(
        listed
            .into_iter()
            .map(|server| server.id)
            .collect::<Vec<_>>(),
        vec![favorite.id, recent.id, older.id]
    );
}

#[tokio::test]
async fn deleting_a_server_removes_it_from_the_catalog() {
    let database = Database::open(":memory:")
        .await
        .expect("in-memory database should open");
    let repository = ServerRepository::new(database);
    let server = repository
        .create(&server_input("retired", "retired.example.com", false), 100)
        .await
        .expect("server should be created");

    repository
        .delete(server.id)
        .await
        .expect("server should be deleted");

    assert!(
        repository
            .list()
            .await
            .expect("servers should be listed")
            .is_empty()
    );
    assert_eq!(
        repository.get(server.id).await.unwrap_err().code(),
        CoreErrorCode::NotFound
    );
}

fn server_input(name: &str, host: &str, favorite: bool) -> ServerInput {
    ServerInput::try_new(
        name,
        host,
        22,
        "deploy",
        AuthType::Key,
        "secret-ref-fixture",
        None,
        favorite,
    )
    .expect("valid server input should be accepted")
}
