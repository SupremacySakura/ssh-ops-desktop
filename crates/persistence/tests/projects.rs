use opspilot_domain::{
    AuthType, DeployStrategy, ProjectInput, RuntimeType, ServerEnvironment, ServerInput,
};
use opspilot_persistence::{Database, ProjectRepository, ServerRepository};

#[tokio::test]
async fn project_repository_round_trips_validated_metadata_and_cascades_with_server() {
    let database = Database::open(":memory:").await.unwrap();
    let server = ServerRepository::new(database.clone())
        .create(
            ServerInput::try_new(
                "Dev",
                "dev.example.com",
                22,
                "deploy",
                ServerEnvironment::Development,
                AuthType::SshAgent,
                None,
                vec![],
            )
            .unwrap(),
        )
        .await
        .unwrap();
    let repository = ProjectRepository::new(database.clone());
    let project = repository
        .create(
            ProjectInput::try_new(
                server.id,
                "Web",
                "/srv/web",
                Some("git@example.com:team/web.git"),
                RuntimeType::NodeJs,
                DeployStrategy::ReleaseSymlink,
            )
            .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(repository.get(project.id).await.unwrap(), project);
    assert_eq!(
        repository.list_for_server(server.id).await.unwrap(),
        [project]
    );

    sqlx::query("DELETE FROM servers WHERE id = ?")
        .bind(server.id.to_string())
        .execute(database.pool())
        .await
        .unwrap();
    assert!(
        repository
            .list_for_server(server.id)
            .await
            .unwrap()
            .is_empty()
    );
}
