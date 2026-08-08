use opspilot_domain::{Id, TaskStatus};
use opspilot_persistence::{Database, TaskRepository};

#[tokio::test]
async fn status_and_event_are_persisted_atomically_with_monotonic_sequences() {
    let database = Database::open(":memory:").await.unwrap();
    let task_id = seed_task(&database, "running").await;
    let repository = TaskRepository::new(database.clone());

    let first = repository
        .transition(
            task_id,
            TaskStatus::Failed,
            40,
            Some("apply"),
            Some("REMOTE_COMMAND"),
        )
        .await
        .unwrap();
    assert_eq!(first.sequence, 1);
    let events = repository.events_since(task_id, 0, 100).await.unwrap();
    assert_eq!(events.events, [first]);
    assert!(!events.has_more);
    assert_eq!(events.oldest_available_sequence, Some(1));

    let state: (String, i64) = sqlx::query_as("SELECT status, sequence FROM tasks WHERE id = ?")
        .bind(task_id.to_string())
        .fetch_one(database.pool())
        .await
        .unwrap();
    assert_eq!(state, ("failed".to_owned(), 1));
}

#[tokio::test]
async fn startup_recovery_marks_running_and_rolling_back_tasks_interrupted() {
    let database = Database::open(":memory:").await.unwrap();
    let running = seed_task(&database, "running").await;
    let rolling = seed_task(&database, "rolling_back").await;
    let repository = TaskRepository::new(database);
    assert_eq!(repository.recover_interrupted().await.unwrap(), 2);
    assert_eq!(
        repository.get_status(running).await.unwrap(),
        TaskStatus::Interrupted
    );
    assert_eq!(
        repository.get_status(rolling).await.unwrap(),
        TaskStatus::Interrupted
    );
}

#[tokio::test]
async fn lists_only_the_latest_event_for_each_task() {
    let database = Database::open(":memory:").await.unwrap();
    let first_task = seed_task(&database, "pending").await;
    let second_task = seed_task(&database, "pending").await;
    let repository = TaskRepository::new(database);

    repository
        .transition(first_task, TaskStatus::Running, 30, Some("prepare"), None)
        .await
        .unwrap();
    repository
        .transition(
            first_task,
            TaskStatus::Succeeded,
            100,
            Some("complete"),
            None,
        )
        .await
        .unwrap();
    repository
        .transition(
            second_task,
            TaskStatus::Failed,
            10,
            Some("connect"),
            Some("SSH_CONNECT"),
        )
        .await
        .unwrap();

    let events = repository.list_latest(100).await.unwrap();
    assert_eq!(events.len(), 2);
    assert!(events.iter().any(|event| {
        event.task_id == first_task
            && event.sequence == 2
            && event.status == TaskStatus::Succeeded
            && event.progress == 100
    }));
    assert!(events.iter().any(|event| {
        event.task_id == second_task
            && event.sequence == 1
            && event.status == TaskStatus::Failed
            && event.error_code.as_deref() == Some("SSH_CONNECT")
    }));
}

async fn seed_task(database: &Database, status: &str) -> Id {
    let tool_call_id = Id::new();
    let task_id = Id::new();
    sqlx::query(
        "INSERT INTO tool_calls (
            id, run_id, server_id, name, schema_version, args_json, args_digest,
            actor_type, actor_id, state, created_at
         ) VALUES (?, ?, ?, 'fixture.read', 1, '{}', ?, 'manual', 'fixture', 'prepared',
                   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
    )
    .bind(tool_call_id.to_string())
    .bind(Id::new().to_string())
    .bind(Id::new().to_string())
    .bind("a".repeat(64))
    .execute(database.pool())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO tasks (id, tool_call_id, args_digest, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
    )
    .bind(task_id.to_string())
    .bind(tool_call_id.to_string())
    .bind("a".repeat(64))
    .bind(status)
    .execute(database.pool())
    .await
    .unwrap();
    task_id
}
