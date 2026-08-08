use opspilot_domain::{AgentRunStatus, AuthType, ServerEnvironment, ServerInput};
use opspilot_persistence::{AgentRepository, Database, ServerRepository};

#[tokio::test]
async fn persists_only_summaries_and_recovers_without_replaying() {
    let database = Database::open(":memory:").await.unwrap();
    let server = ServerRepository::new(database.clone())
        .create(
            ServerInput::try_new(
                "Test",
                "example.com",
                22,
                "deploy",
                ServerEnvironment::Staging,
                AuthType::SshAgent,
                None,
                vec![],
            )
            .unwrap(),
        )
        .await
        .unwrap();
    let repository = AgentRepository::new(database.clone());
    let thread = repository
        .create_thread("Disk investigation")
        .await
        .unwrap();
    let run = repository
        .create_run(thread.id, server.id, None, "inspect disk usage")
        .await
        .unwrap();
    assert_eq!(run.status, AgentRunStatus::Planning);

    assert_eq!(repository.recover_incomplete().await.unwrap(), 1);
    let recovered = repository.get_run(run.id).await.unwrap();
    assert_eq!(recovered.status, AgentRunStatus::RecoveryRequired);
    let event_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM agent_run_events WHERE run_id = ?")
            .bind(run.id.to_string())
            .fetch_one(database.pool())
            .await
            .unwrap();
    assert_eq!(event_count, 2);
}
