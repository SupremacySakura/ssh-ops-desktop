use opspilot_domain::{AuthType, CoreErrorCode, Id, ServerEnvironment, ServerInput, ServerPort};
use opspilot_persistence::{Database, ServerRepository};
use opspilot_secrets::SecretRef;

fn server_input(name: &str, host: &str, port: u32, username: &str) -> ServerInput {
    ServerInput::try_new(
        name,
        host,
        port,
        username,
        ServerEnvironment::Production,
        AuthType::SshAgent,
        None,
        Vec::new(),
    )
    .expect("fixture should be valid")
}

fn server_input_with_relations(
    name: &str,
    host: &str,
    group_id: Option<Id>,
    tag_ids: Vec<Id>,
) -> ServerInput {
    ServerInput::try_new(
        name,
        host,
        22,
        "deploy",
        ServerEnvironment::Staging,
        AuthType::PrivateKey,
        group_id,
        tag_ids,
    )
    .expect("fixture should be valid")
}

#[tokio::test]
async fn rejects_duplicate_normalized_server_identity_and_invalid_port() {
    let database = Database::open(":memory:")
        .await
        .expect("in-memory database should open");
    let repository = ServerRepository::new(database);

    repository
        .create(server_input(
            "Production API",
            " EXAMPLE.com ",
            22,
            " deploy ",
        ))
        .await
        .expect("first identity should be created");

    let duplicate = repository
        .create(server_input(
            "Duplicate display name is allowed",
            "example.COM",
            22,
            "deploy",
        ))
        .await
        .expect_err("normalized connection identities must be unique");

    assert_eq!(duplicate.code(), CoreErrorCode::Conflict);
    assert_eq!(
        ServerPort::try_from(0).unwrap_err().code(),
        CoreErrorCode::Validation
    );
    assert_eq!(
        ServerPort::try_from(65_536).unwrap_err().code(),
        CoreErrorCode::Validation
    );
}

#[tokio::test]
async fn manages_server_group_and_tag_crud_with_foreign_key_cleanup() {
    let database = Database::open(":memory:")
        .await
        .expect("in-memory database should open");
    let repository = ServerRepository::new(database.clone());
    let primary_group = repository
        .create_group("  Primary  ", 10)
        .await
        .expect("group should be created");
    let archived_group = repository
        .create_group("Archived", 20)
        .await
        .expect("second group should be created");
    let edge_tag = repository
        .create_tag("  edge  ")
        .await
        .expect("tag should be created");
    let linux_tag = repository
        .create_tag("linux")
        .await
        .expect("second tag should be created");

    assert_eq!(primary_group.name, "Primary");
    assert_eq!(edge_tag.name, "edge");
    assert_eq!(repository.list_groups().await.unwrap().len(), 2);
    assert_eq!(repository.list_tags().await.unwrap().len(), 2);

    let created = repository
        .create(server_input_with_relations(
            "Staging API",
            "staging.example.com",
            Some(primary_group.id),
            vec![edge_tag.id],
        ))
        .await
        .expect("related server should be created transactionally");
    assert_eq!(repository.get(created.id).await.unwrap(), created);
    assert_eq!(repository.list().await.unwrap(), vec![created.clone()]);

    let updated_group = repository
        .update_group(archived_group.id, "  Secondary  ", 5)
        .await
        .expect("group should be updated");
    let updated_tag = repository
        .update_tag(linux_tag.id, "  unix  ")
        .await
        .expect("tag should be updated");
    assert_eq!(updated_group.name, "Secondary");
    assert_eq!(updated_tag.name, "unix");

    let updated = repository
        .update(
            created.id,
            server_input_with_relations(
                "Renamed API",
                "renamed.example.com",
                Some(updated_group.id),
                vec![edge_tag.id, updated_tag.id],
            ),
        )
        .await
        .expect("server and tag replacement should share one transaction");
    assert_eq!(updated.name, "Renamed API");
    assert_eq!(updated.tag_ids, vec![edge_tag.id, updated_tag.id]);

    repository
        .delete_group(updated_group.id)
        .await
        .expect("group should be deletable");
    assert_eq!(repository.get(created.id).await.unwrap().group_id, None);

    repository
        .delete(created.id, None)
        .await
        .expect("server should be deletable");
    let relation_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM server_tags WHERE server_id = ?")
            .bind(created.id.to_string())
            .fetch_one(database.pool())
            .await
            .expect("tag relation count should be readable");
    assert_eq!(relation_count, 0);
    assert_eq!(
        repository.get(created.id).await.unwrap_err().code(),
        CoreErrorCode::NotFound
    );

    repository
        .delete_tag(edge_tag.id)
        .await
        .expect("unused tag should be deletable");
}

#[tokio::test]
async fn rolls_back_server_create_when_a_tag_does_not_exist() {
    let database = Database::open(":memory:")
        .await
        .expect("in-memory database should open");
    let repository = ServerRepository::new(database);

    let error = repository
        .create(server_input_with_relations(
            "Invalid relation",
            "rollback.example.com",
            None,
            vec![Id::new()],
        ))
        .await
        .expect_err("unknown tag should reject the complete transaction");

    assert_eq!(error.code(), CoreErrorCode::Validation);
    assert!(error.message().contains("unknown group or tag"));
    assert!(repository.list().await.unwrap().is_empty());
}

#[tokio::test]
async fn reports_tag_create_conflicts_as_tag_conflicts() {
    let database = Database::open(":memory:")
        .await
        .expect("in-memory database should open");
    let repository = ServerRepository::new(database);
    repository
        .create_tag("edge")
        .await
        .expect("first tag should be created");

    let error = repository
        .create_tag("edge")
        .await
        .expect_err("duplicate tag names must conflict");

    assert_eq!(error.code(), CoreErrorCode::Conflict);
    assert!(error.message().contains("server tag"));
    assert!(!error.message().contains("host, port, and username"));
}

#[tokio::test]
async fn reports_tag_update_conflicts_as_tag_conflicts() {
    let database = Database::open(":memory:")
        .await
        .expect("in-memory database should open");
    let repository = ServerRepository::new(database);
    repository
        .create_tag("edge")
        .await
        .expect("first tag should be created");
    let renamed = repository
        .create_tag("linux")
        .await
        .expect("second tag should be created");

    let error = repository
        .update_tag(renamed.id, "edge")
        .await
        .expect_err("renaming to an existing tag must conflict");

    assert_eq!(error.code(), CoreErrorCode::Conflict);
    assert!(error.message().contains("server tag"));
    assert!(!error.message().contains("host, port, and username"));
}

#[tokio::test]
async fn database_rejects_sharing_a_server_secret_reference() {
    let database = Database::open(":memory:")
        .await
        .expect("in-memory database should open");
    let repository = ServerRepository::new(database.clone());
    let first = repository
        .create(server_input(
            "First unique owner",
            "first-unique-owner.example.com",
            22,
            "deploy",
        ))
        .await
        .expect("first server should be created");
    let second = repository
        .create(server_input(
            "Second unique owner",
            "second-unique-owner.example.com",
            22,
            "deploy",
        ))
        .await
        .expect("second server should be created");
    let secret_ref = SecretRef::from_persisted("unique-delete-reference")
        .expect("fixture secret reference should be valid");
    sqlx::query(
        "INSERT INTO secret_refs (ref, kind, owner_type, owner_id, created_at, updated_at)
         VALUES (?, 'password', 'server', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
    )
    .bind(secret_ref.as_str())
    .bind(first.id.to_string())
    .execute(database.pool())
    .await
    .expect("secret metadata should be inserted");
    sqlx::query("UPDATE servers SET secret_ref = ? WHERE id = ?")
        .bind(secret_ref.as_str())
        .bind(first.id.to_string())
        .execute(database.pool())
        .await
        .expect("first server should own the credential reference");

    let error = sqlx::query("UPDATE servers SET secret_ref = ? WHERE id = ?")
        .bind(secret_ref.as_str())
        .bind(second.id.to_string())
        .execute(database.pool())
        .await
        .expect_err("database uniqueness must close the delete preparation race");

    assert!(
        error
            .as_database_error()
            .is_some_and(|error| error.is_unique_violation())
    );
    let second_ref: Option<String> =
        sqlx::query_scalar("SELECT secret_ref FROM servers WHERE id = ?")
            .bind(second.id.to_string())
            .fetch_one(database.pool())
            .await
            .expect("second server reference should be readable");
    assert_eq!(second_ref, None);
}

#[tokio::test]
async fn shared_secret_reference_delete_reports_a_credential_invariant_error() {
    let database = Database::open(":memory:")
        .await
        .expect("in-memory database should open");
    let repository = ServerRepository::new(database.clone());
    let first = repository
        .create(server_input(
            "First owner",
            "first-owner.example.com",
            22,
            "deploy",
        ))
        .await
        .expect("first server should be created");
    let second = repository
        .create(server_input(
            "Second owner",
            "second-owner.example.com",
            22,
            "deploy",
        ))
        .await
        .expect("second server should be created");
    let secret_ref = SecretRef::from_persisted("shared-delete-reference")
        .expect("fixture secret reference should be valid");
    sqlx::query(
        "INSERT INTO secret_refs (ref, kind, owner_type, owner_id, created_at, updated_at)
         VALUES (?, 'password', 'server', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
    )
    .bind(secret_ref.as_str())
    .bind(first.id.to_string())
    .execute(database.pool())
    .await
    .expect("secret metadata should be inserted");
    sqlx::query("DROP INDEX idx_servers_unique_secret_ref")
        .execute(database.pool())
        .await
        .expect("test should simulate a corrupted pre-0004 schema");
    sqlx::query("UPDATE servers SET secret_ref = ? WHERE id IN (?, ?)")
        .bind(secret_ref.as_str())
        .bind(first.id.to_string())
        .bind(second.id.to_string())
        .execute(database.pool())
        .await
        .expect("both servers should reference the corruption fixture");

    let error = repository
        .deletion_secret_ref(first.id)
        .await
        .expect_err("shared credential metadata must block deletion preparation");

    assert_eq!(error.code(), CoreErrorCode::Internal);
    assert!(error.message().contains("credential metadata"));
    assert!(!error.message().contains(secret_ref.as_str()));
    assert_eq!(repository.list().await.unwrap().len(), 2);
    let metadata_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM secret_refs WHERE ref = ?")
        .bind(secret_ref.as_str())
        .fetch_one(database.pool())
        .await
        .expect("secret metadata count should be readable");
    assert_eq!(metadata_count, 1);
}

#[tokio::test]
async fn delete_rejects_a_changed_secret_reference_without_modifying_the_server() {
    let database = Database::open(":memory:")
        .await
        .expect("in-memory database should open");
    let repository = ServerRepository::new(database);
    let created = repository
        .create(server_input(
            "Changed delete target",
            "changed-delete-target.example.com",
            22,
            "deploy",
        ))
        .await
        .expect("server should be created");
    let unexpected_ref = SecretRef::from_persisted("unexpected-delete-reference")
        .expect("fixture secret reference should be valid");

    let error = repository
        .delete(created.id, Some(&unexpected_ref))
        .await
        .expect_err("a changed deletion target must be retried");

    assert_eq!(error.code(), CoreErrorCode::Conflict);
    assert!(error.is_retryable());
    assert_eq!(repository.get(created.id).await.unwrap().id, created.id);
}

#[tokio::test]
async fn deletion_target_validates_persisted_secret_refs_before_any_delete() {
    let database = Database::open(":memory:")
        .await
        .expect("in-memory database should open");
    let repository = ServerRepository::new(database.clone());
    let created = repository
        .create(server_input(
            "Invalid delete target",
            "invalid-delete-target.example.com",
            22,
            "deploy",
        ))
        .await
        .expect("server should be created");
    let invalid_ref = "invalid\nsecret-reference";
    sqlx::query(
        "INSERT INTO secret_refs (ref, kind, owner_type, owner_id, created_at, updated_at)
         VALUES (?, 'password', 'server', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
    )
    .bind(invalid_ref)
    .bind(created.id.to_string())
    .execute(database.pool())
    .await
    .expect("invalid persisted reference fixture should be inserted");
    sqlx::query("UPDATE servers SET secret_ref = ? WHERE id = ?")
        .bind(invalid_ref)
        .bind(created.id.to_string())
        .execute(database.pool())
        .await
        .expect("server should reference the invalid fixture");

    let error = repository
        .deletion_secret_ref(created.id)
        .await
        .expect_err("invalid persisted references must stop deletion preparation");

    assert_eq!(error.code(), CoreErrorCode::Validation);
    assert_eq!(repository.get(created.id).await.unwrap().id, created.id);
    let metadata_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM secret_refs WHERE ref = ?")
        .bind(invalid_ref)
        .fetch_one(database.pool())
        .await
        .expect("secret metadata count should be readable");
    assert_eq!(metadata_count, 1);
}

#[tokio::test]
async fn delete_removes_secret_metadata_and_returns_only_the_opaque_reference() {
    let database = Database::open(":memory:")
        .await
        .expect("in-memory database should open");
    let repository = ServerRepository::new(database.clone());
    let created = repository
        .create(server_input(
            "Secret owner",
            "secret.example.com",
            22,
            "deploy",
        ))
        .await
        .expect("server should be created");
    let secret_ref = SecretRef::from_persisted("opaque-secret-reference")
        .expect("fixture secret reference should be valid");
    sqlx::query(
        "INSERT INTO secret_refs (ref, kind, owner_type, owner_id, created_at, updated_at)
         VALUES (?, 'password', 'server', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
    )
    .bind(secret_ref.as_str())
    .bind(created.id.to_string())
    .execute(database.pool())
    .await
    .expect("secret metadata should be inserted");
    sqlx::query("UPDATE servers SET secret_ref = ? WHERE id = ?")
        .bind(secret_ref.as_str())
        .bind(created.id.to_string())
        .execute(database.pool())
        .await
        .expect("server should reference the secret metadata");

    let deleted_secret_ref = repository
        .deletion_secret_ref(created.id)
        .await
        .expect("delete target should expose only the opaque reference");

    assert_eq!(deleted_secret_ref.as_ref(), Some(&secret_ref));
    repository
        .delete(created.id, deleted_secret_ref.as_ref())
        .await
        .expect("server and secret metadata should be deleted together");
    let metadata_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM secret_refs WHERE ref = ?")
        .bind(secret_ref.as_str())
        .fetch_one(database.pool())
        .await
        .expect("secret metadata count should be readable");
    assert_eq!(metadata_count, 0);
}

#[tokio::test]
async fn batch_create_is_atomic_when_any_identity_conflicts() {
    let database = Database::open(":memory:")
        .await
        .expect("in-memory database should open");
    let repository = ServerRepository::new(database);

    let error = repository
        .create_many(vec![
            server_input("First", "batch.example.com", 22, "deploy"),
            server_input("Duplicate", "BATCH.example.com", 22, "deploy"),
        ])
        .await
        .expect_err("a conflicting row should roll back the entire batch");

    assert_eq!(error.code(), CoreErrorCode::Conflict);
    assert!(repository.list().await.unwrap().is_empty());
}
