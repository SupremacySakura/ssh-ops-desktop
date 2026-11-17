use opspilot_domain::{AuthType, CoreErrorCode, ServerInput};
use opspilot_persistence::{Database, GroupRepository, ServerRepository};

#[tokio::test]
async fn groups_round_trip_in_manual_sort_order() {
    let database = Database::open(":memory:")
        .await
        .expect("in-memory database should open");
    let repository = GroupRepository::new(database);

    let production = repository
        .create("生产", 20)
        .await
        .expect("production group should be created");
    let testing = repository
        .create("测试", 10)
        .await
        .expect("testing group should be created");
    let listed = repository.list().await.expect("groups should be listed");

    assert_eq!(listed, vec![testing.clone(), production.clone()]);
    assert_eq!(
        repository
            .get(production.id)
            .await
            .expect("created group should be readable"),
        production
    );
}

#[tokio::test]
async fn groups_can_be_renamed_and_reordered() {
    let database = Database::open(":memory:")
        .await
        .expect("in-memory database should open");
    let repository = GroupRepository::new(database);
    let group = repository
        .create("生产", 20)
        .await
        .expect("group should be created");

    let updated = repository
        .update(group.id, "核心生产", 5)
        .await
        .expect("group should be updated");

    assert_eq!(updated.id, group.id);
    assert_eq!(updated.name, "核心生产");
    assert_eq!(updated.sort_order, 5);
    assert_eq!(
        repository.list().await.expect("groups should be listed"),
        vec![updated]
    );
}

#[tokio::test]
async fn deleting_a_group_moves_its_servers_to_ungrouped() {
    let database = Database::open(":memory:")
        .await
        .expect("in-memory database should open");
    let groups = GroupRepository::new(database.clone());
    let servers = ServerRepository::new(database);
    let group = groups
        .create("生产", 20)
        .await
        .expect("group should be created");
    let input = ServerInput::try_new(
        "prod-web-01",
        "prod.example.com",
        22,
        "deploy",
        AuthType::Key,
        Some("secret-ref-fixture"),
        Some(group.id),
        false,
    )
    .expect("valid server input should be accepted");
    let server = servers
        .create(&input, 1_700_000_000)
        .await
        .expect("grouped server should be created");

    groups
        .delete(group.id)
        .await
        .expect("group should be deleted");

    let ungrouped = servers
        .get(server.id)
        .await
        .expect("server should remain after its group is deleted");
    assert_eq!(ungrouped.group_id, None);
    assert_eq!(
        groups.get(group.id).await.unwrap_err().code(),
        CoreErrorCode::NotFound
    );
}
