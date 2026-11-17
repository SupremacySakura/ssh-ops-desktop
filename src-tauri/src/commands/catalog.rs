use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use opspilot_domain::{
    AuthType, CoreError, CoreErrorCode, Id, Server, ServerInput as DomainServerInput,
};
use opspilot_persistence::{GroupRepository, ServerRepository};
use opspilot_secrets::{KeyringSecretStore, SecretKind, SecretRef, SecretStore, SecretValue};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::CoreServices;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ServerInput {
    pub(crate) name: String,
    pub(crate) host: String,
    pub(crate) port: u32,
    pub(crate) user: String,
    pub(crate) auth_type: AuthType,
    #[serde(default)]
    pub(crate) group_id: Option<Id>,
    pub(crate) favorite: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ServerCredentialInput {
    pub(crate) credential: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GroupInput {
    pub(crate) name: String,
    pub(crate) sort_order: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServerSaveOutcome {
    pub(crate) server: Server,
    pub(crate) warning: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServerDeleteOutcome {
    pub(crate) warning: Option<String>,
}

pub(crate) async fn list_servers<S>(services: &CoreServices<S>) -> Result<Vec<Server>, CoreError> {
    ServerRepository::new(services.database.clone())
        .list()
        .await
}

pub(crate) async fn list_groups<S>(
    services: &CoreServices<S>,
) -> Result<Vec<opspilot_domain::ServerGroup>, CoreError> {
    GroupRepository::new(services.database.clone()).list().await
}

pub(crate) async fn create_group<S>(
    services: &CoreServices<S>,
    input: GroupInput,
) -> Result<opspilot_domain::ServerGroup, CoreError> {
    GroupRepository::new(services.database.clone())
        .create(&input.name, input.sort_order)
        .await
}

pub(crate) async fn update_group<S>(
    services: &CoreServices<S>,
    id: Id,
    input: GroupInput,
) -> Result<opspilot_domain::ServerGroup, CoreError> {
    GroupRepository::new(services.database.clone())
        .update(id, &input.name, input.sort_order)
        .await
}

pub(crate) async fn delete_group<S>(services: &CoreServices<S>, id: Id) -> Result<(), CoreError> {
    GroupRepository::new(services.database.clone())
        .delete(id)
        .await
}

pub(crate) async fn create_server<S>(
    services: &CoreServices<S>,
    input: ServerInput,
    credential: ServerCredentialInput,
) -> Result<Server, CoreError>
where
    S: SecretStore,
{
    validate_group(services, input.group_id).await?;
    let created_at = unix_timestamp()?;
    let credential = credential.into_secret_value()?;
    let secret_ref = services
        .secret_store
        .put(secret_kind(input.auth_type), Id::new(), credential)
        .await?;
    let record = match input.into_domain(Some(secret_ref.as_str())) {
        Ok(record) => record,
        Err(error) => {
            let _ = services.secret_store.delete(&secret_ref).await;
            return Err(error);
        }
    };
    let created = ServerRepository::new(services.database.clone())
        .create(&record, created_at)
        .await;
    if created.is_err() {
        let _ = services.secret_store.delete(&secret_ref).await;
    }

    created
}

pub(crate) async fn update_server<S>(
    services: &CoreServices<S>,
    id: Id,
    input: ServerInput,
    credential: Option<ServerCredentialInput>,
) -> Result<ServerSaveOutcome, CoreError>
where
    S: SecretStore,
{
    validate_group(services, input.group_id).await?;
    let repository = ServerRepository::new(services.database.clone());
    let existing = repository.get(id).await?;
    let replacement_ref = match credential {
        Some(credential) => Some(
            services
                .secret_store
                .put(
                    secret_kind(input.auth_type),
                    Id::new(),
                    credential.into_secret_value()?,
                )
                .await?,
        ),
        None if input.auth_type != existing.auth_type => {
            return Err(CoreError::new(
                CoreErrorCode::Validation,
                "更改认证方式时必须提供新凭据",
                false,
            ));
        }
        None => None,
    };
    let secret_ref = replacement_ref
        .as_ref()
        .map(SecretRef::as_str)
        .or(existing.secret_ref.as_deref());
    let record = match input.into_domain(secret_ref) {
        Ok(record) => record,
        Err(error) => {
            if let Some(secret_ref) = &replacement_ref {
                let _ = services.secret_store.delete(secret_ref).await;
            }
            return Err(error);
        }
    };
    let updated = repository.update(id, &record).await;
    match updated {
        Ok(server) => {
            let previous_ref = replacement_ref
                .as_ref()
                .and_then(|_| existing.secret_ref.clone());
            let warning = cleanup_previous_secret(
                &services.secret_store,
                previous_ref,
                "服务器已保存，但旧凭据未能从系统凭据库清理；请稍后在凭据设置中重试。",
            )
            .await;
            Ok(ServerSaveOutcome { server, warning })
        }
        Err(error) => {
            if let Some(secret_ref) = &replacement_ref {
                let _ = services.secret_store.delete(secret_ref).await;
            }
            Err(error)
        }
    }
}

pub(crate) async fn delete_server<S>(
    services: &CoreServices<S>,
    id: Id,
) -> Result<ServerDeleteOutcome, CoreError>
where
    S: SecretStore,
{
    let repository = ServerRepository::new(services.database.clone());
    let server = repository.get(id).await?;
    repository.delete(id).await?;
    let warning = cleanup_previous_secret(
        &services.secret_store,
        server.secret_ref,
        "服务器已删除，但凭据未能从系统凭据库清理；请稍后手动检查系统凭据。",
    )
    .await;
    Ok(ServerDeleteOutcome { warning })
}

pub(crate) async fn set_server_credential<S>(
    services: &CoreServices<S>,
    id: Id,
    credential: ServerCredentialInput,
) -> Result<ServerSaveOutcome, CoreError>
where
    S: SecretStore,
{
    let repository = ServerRepository::new(services.database.clone());
    let existing = repository.get(id).await?;
    let replacement_ref = services
        .secret_store
        .put(
            secret_kind(existing.auth_type),
            Id::new(),
            credential.into_secret_value()?,
        )
        .await?;
    let record = match DomainServerInput::try_new(
        &existing.name,
        &existing.host,
        u32::from(existing.port),
        &existing.user,
        existing.auth_type,
        Some(replacement_ref.as_str()),
        existing.group_id,
        existing.favorite,
    ) {
        Ok(record) => record,
        Err(error) => {
            let _ = services.secret_store.delete(&replacement_ref).await;
            return Err(error);
        }
    };
    let updated = repository.update(id, &record).await;
    match updated {
        Ok(server) => {
            let warning = cleanup_previous_secret(
                &services.secret_store,
                existing.secret_ref.clone(),
                "凭据已保存，但旧凭据未能从系统凭据库清理；请稍后重试。",
            )
            .await;
            Ok(ServerSaveOutcome { server, warning })
        }
        Err(error) => {
            let _ = services.secret_store.delete(&replacement_ref).await;
            Err(error)
        }
    }
}

#[tauri::command]
pub(crate) async fn server_list(app: AppHandle) -> Result<Vec<Server>, CoreError> {
    list_servers(&core_services(&app)).await
}

#[tauri::command]
pub(crate) async fn server_create(
    app: AppHandle,
    input: ServerInput,
    credential: ServerCredentialInput,
) -> Result<Server, CoreError> {
    create_server(&core_services(&app), input, credential).await
}

#[tauri::command]
pub(crate) async fn server_update(
    app: AppHandle,
    id: Id,
    input: ServerInput,
    credential: Option<ServerCredentialInput>,
) -> Result<ServerSaveOutcome, CoreError> {
    update_server(&core_services(&app), id, input, credential).await
}

#[tauri::command]
pub(crate) async fn server_delete(
    app: AppHandle,
    id: Id,
) -> Result<ServerDeleteOutcome, CoreError> {
    delete_server(&core_services(&app), id).await
}

#[tauri::command]
pub(crate) async fn server_credential_set(
    app: AppHandle,
    id: Id,
    input: ServerCredentialInput,
) -> Result<ServerSaveOutcome, CoreError> {
    set_server_credential(&core_services(&app), id, input).await
}

#[tauri::command]
pub(crate) async fn server_group_list(
    app: AppHandle,
) -> Result<Vec<opspilot_domain::ServerGroup>, CoreError> {
    list_groups(&core_services(&app)).await
}

#[tauri::command]
pub(crate) async fn server_group_create(
    app: AppHandle,
    input: GroupInput,
) -> Result<opspilot_domain::ServerGroup, CoreError> {
    create_group(&core_services(&app), input).await
}

#[tauri::command]
pub(crate) async fn server_group_update(
    app: AppHandle,
    id: Id,
    input: GroupInput,
) -> Result<opspilot_domain::ServerGroup, CoreError> {
    update_group(&core_services(&app), id, input).await
}

#[tauri::command]
pub(crate) async fn server_group_delete(app: AppHandle, id: Id) -> Result<(), CoreError> {
    delete_group(&core_services(&app), id).await
}

fn core_services(app: &AppHandle) -> CoreServices<KeyringSecretStore> {
    app.state::<CoreServices<KeyringSecretStore>>()
        .inner()
        .clone()
}

impl ServerInput {
    fn into_domain(self, secret_ref: Option<&str>) -> Result<DomainServerInput, CoreError> {
        DomainServerInput::try_new(
            &self.name,
            &self.host,
            self.port,
            &self.user,
            self.auth_type,
            secret_ref,
            self.group_id,
            self.favorite,
        )
    }
}

impl ServerCredentialInput {
    fn into_secret_value(self) -> Result<SecretValue, CoreError> {
        if self.credential.is_empty() {
            return Err(CoreError::new(
                CoreErrorCode::Validation,
                "密码或私钥不能为空",
                false,
            ));
        }

        Ok(SecretValue::new(self.credential))
    }
}

async fn validate_group<S>(
    services: &CoreServices<S>,
    group_id: Option<Id>,
) -> Result<(), CoreError> {
    if let Some(group_id) = group_id {
        GroupRepository::new(services.database.clone())
            .get(group_id)
            .await?;
    }

    Ok(())
}

fn secret_kind(auth_type: AuthType) -> SecretKind {
    match auth_type {
        AuthType::Password => SecretKind::Password,
        AuthType::Key => SecretKind::PrivateKey,
    }
}

async fn cleanup_previous_secret<S>(
    store: &Arc<S>,
    persisted_ref: Option<String>,
    warning: &str,
) -> Option<String>
where
    S: SecretStore,
{
    let persisted_ref = persisted_ref?;
    let Ok(secret_ref) = SecretRef::from_persisted(persisted_ref) else {
        return Some(warning.to_owned());
    };
    store
        .delete(&secret_ref)
        .await
        .err()
        .map(|_| warning.to_owned())
}

fn unix_timestamp() -> Result<i64, CoreError> {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_error| {
            CoreError::new(
                CoreErrorCode::Internal,
                "系统时间无效，无法保存服务器",
                false,
            )
        })?
        .as_secs();
    i64::try_from(seconds).map_err(|_error| {
        CoreError::new(
            CoreErrorCode::Internal,
            "系统时间超出支持范围，无法保存服务器",
            false,
        )
    })
}

#[cfg(test)]
mod tests {
    use async_trait::async_trait;
    use opspilot_domain::{AuthType, CoreErrorCode, ServerInput as DomainServerInput};
    use opspilot_persistence::Database;
    use opspilot_secrets::{MemorySecretStore, SecretKind, SecretRef, SecretStore, SecretValue};

    use super::super::CoreServices;
    use super::{
        GroupInput, ServerCredentialInput, ServerInput, create_group, create_server, delete_group,
        delete_server, list_groups, list_servers, set_server_credential, update_group,
        update_server,
    };

    const CREDENTIAL_FIXTURE: &str = "credential-fixture-value";
    const ROTATED_CREDENTIAL_FIXTURE: &str = "rotated-credential-fixture";

    #[derive(Default)]
    struct FailingDeleteStore {
        inner: MemorySecretStore,
    }

    #[async_trait]
    impl SecretStore for FailingDeleteStore {
        async fn put(
            &self,
            kind: SecretKind,
            owner_id: opspilot_domain::Id,
            value: SecretValue,
        ) -> Result<SecretRef, opspilot_domain::CoreError> {
            self.inner.put(kind, owner_id, value).await
        }

        async fn get(
            &self,
            secret_ref: &SecretRef,
        ) -> Result<SecretValue, opspilot_domain::CoreError> {
            self.inner.get(secret_ref).await
        }

        async fn delete(&self, _secret_ref: &SecretRef) -> Result<(), opspilot_domain::CoreError> {
            Err(opspilot_domain::CoreError::new(
                CoreErrorCode::SecretUnavailable,
                "fixture credential deletion failed",
                true,
            ))
        }
    }

    #[test]
    fn catalog_ipc_contracts_use_the_frontend_camel_case_shape() {
        let input: ServerInput = serde_json::from_value(serde_json::json!({
            "name": "prod-web-01",
            "host": "prod.example.com",
            "port": 22,
            "user": "deploy",
            "authType": "password",
            "groupId": null,
            "favorite": true
        }))
        .expect("frontend server input should deserialize");
        assert_eq!(input.auth_type, AuthType::Password);
        assert_eq!(input.group_id, None);

        let server = opspilot_domain::Server {
            id: opspilot_domain::Id::new(),
            name: "prod-web-01".to_owned(),
            host: "prod.example.com".to_owned(),
            port: 22,
            user: "deploy".to_owned(),
            auth_type: AuthType::Key,
            secret_ref: Some("secret-ref-fixture".to_owned()),
            group_id: None,
            favorite: false,
            last_connected_at: None,
            created_at: 1_700_000_000,
        };
        let output = serde_json::to_value(server).expect("server output should serialize");

        assert_eq!(output["authType"], "key");
        assert_eq!(output["secretRef"], "secret-ref-fixture");
        assert!(output.get("auth_type").is_none());
        assert!(output.get("lastConnectedAt").is_none());

        let pending = serde_json::to_value(opspilot_domain::Server {
            id: opspilot_domain::Id::new(),
            name: "imported".to_owned(),
            host: "imported.example.com".to_owned(),
            port: 22,
            user: "deploy".to_owned(),
            auth_type: AuthType::Key,
            secret_ref: None,
            group_id: None,
            favorite: false,
            last_connected_at: None,
            created_at: 1_700_000_000,
        })
        .expect("pending server output should serialize");
        assert!(pending["secretRef"].is_null());
    }

    #[tokio::test]
    async fn creating_a_server_keeps_its_credential_out_of_sqlite() {
        let database = Database::open(":memory:")
            .await
            .expect("in-memory database should open");
        let services = CoreServices::new(database, MemorySecretStore::default());

        let created = create_server(
            &services,
            ServerInput {
                name: "prod-web-01".to_owned(),
                host: "prod.example.com".to_owned(),
                port: 22,
                user: "deploy".to_owned(),
                auth_type: AuthType::Key,
                group_id: None,
                favorite: true,
            },
            ServerCredentialInput {
                credential: CREDENTIAL_FIXTURE.to_owned(),
            },
        )
        .await
        .expect("server should be created");

        assert_eq!(created.name, "prod-web-01");
        assert_eq!(created.host, "prod.example.com");
        assert_eq!(created.auth_type, AuthType::Key);
        assert!(created.favorite);
        assert!(created.created_at > 1_700_000_000);

        let stored_ref = SecretRef::from_persisted(
            created
                .secret_ref
                .clone()
                .expect("created server should have a credential reference"),
        )
        .expect("persisted secret reference should be valid");
        let stored_credential = services
            .secret_store
            .get(&stored_ref)
            .await
            .expect("credential should be readable from the secret store");
        assert_eq!(stored_credential.expose(), CREDENTIAL_FIXTURE);

        let persisted_ref: String =
            sqlx::query_scalar("SELECT secret_ref FROM servers WHERE id = ?")
                .bind(created.id.to_string())
                .fetch_one(services.database.pool())
                .await
                .expect("server row should be readable");
        assert_eq!(Some(persisted_ref.as_str()), created.secret_ref.as_deref());
        assert_ne!(persisted_ref, CREDENTIAL_FIXTURE);

        let listed = list_servers(&services)
            .await
            .expect("created server should be listed");
        assert_eq!(listed, vec![created]);
    }

    #[tokio::test]
    async fn editing_without_a_new_credential_preserves_the_existing_secret() {
        let database = Database::open(":memory:")
            .await
            .expect("in-memory database should open");
        let services = CoreServices::new(database, MemorySecretStore::default());
        let created = create_server(&services, server_input("prod-web-01"), credential_input())
            .await
            .expect("server should be created");

        let updated = update_server(
            &services,
            created.id,
            ServerInput {
                name: "prod-web-01-renamed".to_owned(),
                favorite: false,
                ..server_input("prod-web-01")
            },
            None,
        )
        .await
        .expect("server metadata should be updated");

        assert_eq!(updated.warning, None);
        assert_eq!(updated.server.name, "prod-web-01-renamed");
        assert!(!updated.server.favorite);
        assert_eq!(updated.server.secret_ref, created.secret_ref);
        let stored_ref = SecretRef::from_persisted(
            updated
                .server
                .secret_ref
                .clone()
                .expect("updated server should retain its credential reference"),
        )
        .expect("persisted reference should be valid");
        let stored = services
            .secret_store
            .get(&stored_ref)
            .await
            .expect("existing credential should remain readable");
        assert_eq!(stored.expose(), CREDENTIAL_FIXTURE);
    }

    #[tokio::test]
    async fn editing_with_a_new_credential_rotates_the_secret_reference() {
        let database = Database::open(":memory:")
            .await
            .expect("in-memory database should open");
        let services = CoreServices::new(database, MemorySecretStore::default());
        let created = create_server(&services, server_input("prod-web-01"), credential_input())
            .await
            .expect("server should be created");
        let previous_ref = SecretRef::from_persisted(
            created
                .secret_ref
                .clone()
                .expect("created server should have a credential reference"),
        )
        .expect("persisted reference should be valid");

        let updated = update_server(
            &services,
            created.id,
            server_input("prod-web-01"),
            Some(ServerCredentialInput {
                credential: ROTATED_CREDENTIAL_FIXTURE.to_owned(),
            }),
        )
        .await
        .expect("credential should be rotated");

        assert_eq!(updated.warning, None);
        assert_ne!(updated.server.secret_ref, created.secret_ref);
        let rotated_ref = SecretRef::from_persisted(
            updated
                .server
                .secret_ref
                .clone()
                .expect("rotated server should have a credential reference"),
        )
        .expect("rotated reference should be valid");
        assert_eq!(
            services
                .secret_store
                .get(&rotated_ref)
                .await
                .expect("rotated credential should be readable")
                .expose(),
            ROTATED_CREDENTIAL_FIXTURE
        );
        assert_eq!(
            services
                .secret_store
                .get(&previous_ref)
                .await
                .unwrap_err()
                .code(),
            CoreErrorCode::SecretUnavailable
        );
    }

    #[tokio::test]
    async fn deleting_a_server_also_removes_its_credential() {
        let database = Database::open(":memory:")
            .await
            .expect("in-memory database should open");
        let services = CoreServices::new(database, MemorySecretStore::default());
        let created = create_server(&services, server_input("retired"), credential_input())
            .await
            .expect("server should be created");
        let secret_ref = SecretRef::from_persisted(
            created
                .secret_ref
                .clone()
                .expect("created server should have a credential reference"),
        )
        .expect("persisted reference should be valid");

        let outcome = delete_server(&services, created.id)
            .await
            .expect("server should be deleted");
        assert_eq!(outcome.warning, None);

        assert!(
            list_servers(&services)
                .await
                .expect("servers should be listed")
                .is_empty()
        );
        assert_eq!(
            services
                .secret_store
                .get(&secret_ref)
                .await
                .unwrap_err()
                .code(),
            CoreErrorCode::SecretUnavailable
        );
    }

    #[tokio::test]
    async fn failed_credential_cleanup_reports_a_warning_after_the_database_delete() {
        let database = Database::open(":memory:")
            .await
            .expect("in-memory database should open");
        let services = CoreServices::new(database, FailingDeleteStore::default());
        let created = create_server(&services, server_input("retired"), credential_input())
            .await
            .expect("server should be created");
        let secret_ref = SecretRef::from_persisted(
            created
                .secret_ref
                .clone()
                .expect("created server should have a credential reference"),
        )
        .expect("persisted reference should be valid");

        let outcome = delete_server(&services, created.id)
            .await
            .expect("the database is authoritative and the row must be deleted");

        assert!(outcome.warning.is_some());
        assert!(
            list_servers(&services)
                .await
                .expect("servers should be listed")
                .is_empty()
        );
        assert!(services.secret_store.get(&secret_ref).await.is_ok());
    }

    #[tokio::test]
    async fn database_delete_failure_leaves_the_credential_untouched() {
        let database = Database::open(":memory:")
            .await
            .expect("in-memory database should open");
        let services = CoreServices::new(database, MemorySecretStore::default());
        let created = create_server(&services, server_input("retired"), credential_input())
            .await
            .expect("server should be created");
        let secret_ref = SecretRef::from_persisted(
            created
                .secret_ref
                .clone()
                .expect("created server should have a credential reference"),
        )
        .expect("persisted reference should be valid");
        sqlx::query("CREATE TRIGGER reject_server_delete BEFORE DELETE ON servers BEGIN SELECT RAISE(ABORT, 'blocked'); END")
            .execute(services.database.pool())
            .await
            .expect("delete trigger should be installed");

        let error = delete_server(&services, created.id)
            .await
            .expect_err("a database delete failure must fail the command");

        assert_eq!(error.code(), CoreErrorCode::Internal);
        assert_eq!(
            list_servers(&services)
                .await
                .expect("server should remain after a failed database delete"),
            vec![created]
        );
        assert!(services.secret_store.get(&secret_ref).await.is_ok());
    }

    #[tokio::test]
    async fn credential_rotation_warns_when_the_old_secret_cannot_be_deleted() {
        let database = Database::open(":memory:")
            .await
            .expect("in-memory database should open");
        let services = CoreServices::new(database, FailingDeleteStore::default());
        let created = create_server(&services, server_input("prod-web-01"), credential_input())
            .await
            .expect("server should be created");

        let updated = update_server(
            &services,
            created.id,
            server_input("prod-web-01"),
            Some(ServerCredentialInput {
                credential: ROTATED_CREDENTIAL_FIXTURE.to_owned(),
            }),
        )
        .await
        .expect("the database update must still succeed");

        assert!(updated.warning.is_some());
        assert_ne!(updated.server.secret_ref, created.secret_ref);
        assert_eq!(
            list_servers(&services)
                .await
                .expect("servers should be listed"),
            vec![updated.server]
        );

        let replaced = set_server_credential(
            &services,
            created.id,
            ServerCredentialInput {
                credential: CREDENTIAL_FIXTURE.to_owned(),
            },
        )
        .await
        .expect("setting a credential must still succeed");
        assert!(replaced.warning.is_some());
    }

    #[tokio::test]
    async fn setting_a_credential_replaces_only_the_secret_reference() {
        let database = Database::open(":memory:")
            .await
            .expect("in-memory database should open");
        let services = CoreServices::new(database, MemorySecretStore::default());
        let created = create_server(&services, server_input("prod-web-01"), credential_input())
            .await
            .expect("server should be created");
        let previous_ref = SecretRef::from_persisted(
            created
                .secret_ref
                .clone()
                .expect("created server should have a credential reference"),
        )
        .expect("persisted reference should be valid");

        let updated = set_server_credential(
            &services,
            created.id,
            ServerCredentialInput {
                credential: ROTATED_CREDENTIAL_FIXTURE.to_owned(),
            },
        )
        .await
        .expect("credential should be replaced");

        assert_eq!(updated.warning, None);
        assert_eq!(updated.server.id, created.id);
        assert_eq!(updated.server.name, created.name);
        assert_eq!(updated.server.created_at, created.created_at);
        assert_ne!(updated.server.secret_ref, created.secret_ref);
        assert_eq!(
            services
                .secret_store
                .get(&previous_ref)
                .await
                .unwrap_err()
                .code(),
            CoreErrorCode::SecretUnavailable
        );
    }

    #[tokio::test]
    async fn imported_pending_server_can_be_edited_then_gain_a_credential() {
        let database = Database::open(":memory:")
            .await
            .expect("in-memory database should open");
        let services = CoreServices::new(database, MemorySecretStore::default());
        let pending = opspilot_persistence::ServerRepository::new(services.database.clone())
            .create(
                &DomainServerInput::try_new(
                    "imported",
                    "imported.example.com",
                    22,
                    "deploy",
                    AuthType::Key,
                    None,
                    None,
                    false,
                )
                .expect("pending input should be valid"),
                1_700_000_000,
            )
            .await
            .expect("pending server should be created");

        let edited = update_server(
            &services,
            pending.id,
            ServerInput {
                name: "imported-renamed".to_owned(),
                ..server_input("imported")
            },
            None,
        )
        .await
        .expect("pending server metadata should be editable");
        assert_eq!(edited.server.name, "imported-renamed");
        assert_eq!(edited.server.secret_ref, None);

        let configured = set_server_credential(
            &services,
            pending.id,
            ServerCredentialInput {
                credential: CREDENTIAL_FIXTURE.to_owned(),
            },
        )
        .await
        .expect("pending server should accept a credential");
        assert!(configured.server.secret_ref.is_some());

        delete_server(&services, pending.id)
            .await
            .expect("configured imported server should be deletable");
        assert!(
            list_servers(&services)
                .await
                .expect("servers should be listed")
                .is_empty()
        );
    }

    #[tokio::test]
    async fn deleting_a_pending_server_does_not_touch_the_secret_store() {
        let database = Database::open(":memory:")
            .await
            .expect("in-memory database should open");
        let services = CoreServices::new(database, FailingDeleteStore::default());
        let pending = opspilot_persistence::ServerRepository::new(services.database.clone())
            .create(
                &DomainServerInput::try_new(
                    "imported",
                    "imported.example.com",
                    22,
                    "deploy",
                    AuthType::Key,
                    None,
                    None,
                    false,
                )
                .expect("pending input should be valid"),
                1_700_000_000,
            )
            .await
            .expect("pending server should be created");

        delete_server(&services, pending.id)
            .await
            .expect("pending server should be deleted without credential cleanup");
        assert!(
            list_servers(&services)
                .await
                .expect("servers should be listed")
                .is_empty()
        );
    }

    #[tokio::test]
    async fn groups_are_created_in_manual_order_and_keep_server_membership() {
        let database = Database::open(":memory:")
            .await
            .expect("in-memory database should open");
        let services = CoreServices::new(database, MemorySecretStore::default());
        let production = create_group(
            &services,
            GroupInput {
                name: "生产".to_owned(),
                sort_order: 20,
            },
        )
        .await
        .expect("production group should be created");
        let testing = create_group(
            &services,
            GroupInput {
                name: "测试".to_owned(),
                sort_order: 10,
            },
        )
        .await
        .expect("testing group should be created");
        let mut input = server_input("prod-web-01");
        input.group_id = Some(production.id);
        let server = create_server(&services, input, credential_input())
            .await
            .expect("grouped server should be created");

        assert_eq!(
            list_groups(&services)
                .await
                .expect("groups should be listed"),
            vec![testing, production.clone()]
        );
        assert_eq!(server.group_id, Some(production.id));
    }

    #[tokio::test]
    async fn groups_can_be_renamed_and_reordered() {
        let database = Database::open(":memory:")
            .await
            .expect("in-memory database should open");
        let services = CoreServices::new(database, MemorySecretStore::default());
        let group = create_group(
            &services,
            GroupInput {
                name: "生产".to_owned(),
                sort_order: 20,
            },
        )
        .await
        .expect("group should be created");

        let updated = update_group(
            &services,
            group.id,
            GroupInput {
                name: "核心生产".to_owned(),
                sort_order: 5,
            },
        )
        .await
        .expect("group should be updated");

        assert_eq!(updated.id, group.id);
        assert_eq!(updated.name, "核心生产");
        assert_eq!(updated.sort_order, 5);
        assert_eq!(
            list_groups(&services)
                .await
                .expect("groups should be listed"),
            vec![updated]
        );
    }

    #[tokio::test]
    async fn deleting_a_group_keeps_its_servers_ungrouped() {
        let database = Database::open(":memory:")
            .await
            .expect("in-memory database should open");
        let services = CoreServices::new(database, MemorySecretStore::default());
        let group = create_group(
            &services,
            GroupInput {
                name: "生产".to_owned(),
                sort_order: 20,
            },
        )
        .await
        .expect("group should be created");
        let mut input = server_input("prod-web-01");
        input.group_id = Some(group.id);
        let server = create_server(&services, input, credential_input())
            .await
            .expect("grouped server should be created");
        let secret_ref = SecretRef::from_persisted(
            server
                .secret_ref
                .clone()
                .expect("grouped server should have a credential reference"),
        )
        .expect("persisted reference should be valid");

        delete_group(&services, group.id)
            .await
            .expect("group should be deleted");

        let remaining = list_servers(&services)
            .await
            .expect("servers should be listed");
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].group_id, None);
        assert!(
            list_groups(&services)
                .await
                .expect("groups should be listed")
                .is_empty()
        );
        assert!(services.secret_store.get(&secret_ref).await.is_ok());
    }

    #[tokio::test]
    async fn changing_auth_type_without_a_credential_fails_closed() {
        let database = Database::open(":memory:")
            .await
            .expect("in-memory database should open");
        let services = CoreServices::new(database, MemorySecretStore::default());
        let created = create_server(&services, server_input("prod-web-01"), credential_input())
            .await
            .expect("server should be created");
        let original_ref = SecretRef::from_persisted(
            created
                .secret_ref
                .clone()
                .expect("created server should have a credential reference"),
        )
        .expect("persisted reference should be valid");
        let mut changed = server_input("prod-web-01");
        changed.auth_type = AuthType::Password;

        let error = update_server(&services, created.id, changed, None)
            .await
            .expect_err("auth changes without a replacement credential must fail");

        assert_eq!(error.code(), CoreErrorCode::Validation);
        assert!(error.message().contains("必须提供新凭据"));
        assert_eq!(
            list_servers(&services)
                .await
                .expect("servers should be listed"),
            vec![created]
        );
        assert!(services.secret_store.get(&original_ref).await.is_ok());
    }

    #[tokio::test]
    async fn duplicate_server_identity_returns_an_actionable_conflict() {
        let database = Database::open(":memory:")
            .await
            .expect("in-memory database should open");
        let services = CoreServices::new(database, MemorySecretStore::default());
        let created = create_server(&services, server_input("prod-web-01"), credential_input())
            .await
            .expect("server should be created");

        let error = create_server(&services, server_input("prod-web-copy"), credential_input())
            .await
            .expect_err("duplicate host, port, and user must be rejected");

        assert_eq!(error.code(), CoreErrorCode::Conflict);
        assert!(error.message().contains("主机、端口和用户名"));
        assert_eq!(
            list_servers(&services)
                .await
                .expect("servers should be listed"),
            vec![created]
        );
    }

    #[tokio::test]
    async fn duplicate_group_name_returns_an_actionable_conflict() {
        let database = Database::open(":memory:")
            .await
            .expect("in-memory database should open");
        let services = CoreServices::new(database, MemorySecretStore::default());
        create_group(
            &services,
            GroupInput {
                name: "生产".to_owned(),
                sort_order: 1,
            },
        )
        .await
        .expect("initial group should be created");

        let error = create_group(
            &services,
            GroupInput {
                name: "生产".to_owned(),
                sort_order: 2,
            },
        )
        .await
        .expect_err("duplicate group names must be rejected");

        assert_eq!(error.code(), CoreErrorCode::Conflict);
        assert!(error.message().contains("分组名称"));
    }

    fn server_input(name: &str) -> ServerInput {
        ServerInput {
            name: name.to_owned(),
            host: "prod.example.com".to_owned(),
            port: 22,
            user: "deploy".to_owned(),
            auth_type: AuthType::Key,
            group_id: None,
            favorite: true,
        }
    }

    fn credential_input() -> ServerCredentialInput {
        ServerCredentialInput {
            credential: CREDENTIAL_FIXTURE.to_owned(),
        }
    }
}
