use opspilot_domain::{AuthType, ServerInput};
use opspilot_persistence::{Database, GroupRepository, ServerRepository};

#[tokio::test]
async fn catalog_survives_reopening_the_database_file() {
    let directory = tempfile::tempdir().expect("temporary directory should be created");
    let path = directory.path().join("harbor.sqlite3");
    let (server_id, group_id) = {
        let database = Database::open(&path)
            .await
            .expect("file database should open");
        let groups = GroupRepository::new(database.clone());
        let servers = ServerRepository::new(database.clone());
        let group = groups
            .create("生产", 3)
            .await
            .expect("group should be created");
        let input = ServerInput::try_new(
            "prod-web-01",
            "prod.example.com",
            22,
            "deploy",
            AuthType::Key,
            "secret-ref-fixture",
            Some(group.id),
            true,
        )
        .expect("valid server input should be accepted");
        let server = servers
            .create(&input, 1_700_000_000)
            .await
            .expect("server should be created");
        servers
            .mark_connected(server.id, 1_700_000_100)
            .await
            .expect("connection time should be recorded");
        database.pool().close().await;
        (server.id, group.id)
    };

    let reopened = Database::open(&path)
        .await
        .expect("file database should reopen");
    let groups = GroupRepository::new(reopened.clone())
        .list()
        .await
        .expect("groups should be restored");
    let servers = ServerRepository::new(reopened)
        .list()
        .await
        .expect("servers should be restored");

    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].id, group_id);
    assert_eq!(servers.len(), 1);
    assert_eq!(servers[0].id, server_id);
    assert_eq!(servers[0].group_id, Some(group_id));
    assert!(servers[0].favorite);
    assert_eq!(servers[0].last_connected_at, Some(1_700_000_100));
}
