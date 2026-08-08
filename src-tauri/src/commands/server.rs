use std::{
    collections::{HashMap, HashSet, VecDeque},
    str::FromStr,
    time::{Duration, Instant},
};

use opspilot_audit::{AuditEvent, AuditWriter};
use opspilot_domain::{
    AuthType, CoreError, CoreErrorCode, Id, ServerEnvironment, ServerGroup, ServerInput,
    ServerSummary, ServerTag,
};
use opspilot_persistence::ServerRepository;
use opspilot_secrets::{KeyringSecretStore, SecretKind, SecretStore, SecretValue};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, WebviewWindow};

use super::CoreServices;

const IMPORT_TTL: Duration = Duration::from_secs(15 * 60);
const MAX_IMPORTS_PER_SESSION: usize = 10;
const MAX_ROWS_PER_SESSION: usize = 10_000;
const ALLOWED_IMPORT_FIELDS: [&str; 8] = [
    "name",
    "host",
    "port",
    "username",
    "environment",
    "authType",
    "groupId",
    "tagIds",
];

type ParsedImportRow = Result<Map<String, Value>, CoreError>;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ImportFormat {
    Csv,
    Json,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ImportRowStatus {
    Valid,
    Duplicate,
    Error,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportServerCandidate {
    name: String,
    host: String,
    port: u16,
    username: String,
    environment: ServerEnvironment,
    auth_type: AuthType,
    #[serde(skip_serializing_if = "Option::is_none")]
    group_id: Option<Id>,
    tag_ids: Vec<Id>,
}

impl ImportServerCandidate {
    fn from_input(input: &ServerInput) -> Self {
        Self {
            name: input.name().to_owned(),
            host: input.host().as_str().to_owned(),
            port: input.port().get(),
            username: input.username().to_owned(),
            environment: input.environment(),
            auth_type: input.auth_type(),
            group_id: input.group_id(),
            tag_ids: input.tag_ids().to_vec(),
        }
    }

    fn to_input(&self) -> Result<ServerInput, CoreError> {
        ServerInput::try_new(
            &self.name,
            &self.host,
            u32::from(self.port),
            &self.username,
            self.environment,
            self.auth_type,
            self.group_id,
            self.tag_ids.clone(),
        )
    }

    fn identity(&self) -> (String, u16, String) {
        (self.host.clone(), self.port, self.username.clone())
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportPreviewRow {
    row_id: Id,
    status: ImportRowStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    server: Option<ImportServerCandidate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportPreview {
    import_id: Id,
    source_sha256: String,
    rows: Vec<ImportPreviewRow>,
}

#[derive(Clone, Debug)]
struct StoredImport {
    import_id: Id,
    source_sha256: String,
    integrity_sha256: String,
    rows: Vec<ImportPreviewRow>,
    created_at: Instant,
}

#[derive(Debug, Default)]
pub(crate) struct ImportPreviewStore {
    sessions: HashMap<String, VecDeque<StoredImport>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ServerMutationInput {
    name: String,
    host: String,
    port: u32,
    username: String,
    environment: ServerEnvironment,
    auth_type: AuthType,
    group_id: Option<Id>,
    tag_ids: Vec<Id>,
}

impl ServerMutationInput {
    fn into_domain(self) -> Result<ServerInput, CoreError> {
        ServerInput::try_new(
            &self.name,
            &self.host,
            self.port,
            &self.username,
            self.environment,
            self.auth_type,
            self.group_id,
            self.tag_ids,
        )
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ServerDeleteRequest {
    server_id: Id,
    confirmed: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ServerCredentialSetRequest {
    server_id: Id,
    secret: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImportPreviewRequest {
    format: ImportFormat,
    source: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImportApplyRequest {
    import_id: Id,
    row_ids: Vec<Id>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportApplyResult {
    servers: Vec<ServerSummary>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GroupMutationInput {
    name: String,
    sort_order: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TagMutationInput {
    name: String,
}

pub(crate) async fn create_server(
    repository: &ServerRepository,
    audit: &AuditWriter,
    input: ServerInput,
) -> Result<ServerSummary, CoreError> {
    let result = repository.create(input).await;
    let server_id = result.as_ref().ok().map(|server| server.id);
    let audit_result =
        audit_server_outcome(audit, "server.create", server_id, &result, SERVER_FIELDS).await;
    complete_with_audit(result, audit_result)
}

pub(crate) async fn update_server(
    repository: &ServerRepository,
    audit: &AuditWriter,
    server_id: Id,
    input: ServerInput,
) -> Result<ServerSummary, CoreError> {
    let result = repository.update(server_id, input).await;
    let audit_result = audit_server_outcome(
        audit,
        "server.update",
        Some(server_id),
        &result,
        SERVER_FIELDS,
    )
    .await;
    complete_with_audit(result, audit_result)
}

pub(crate) async fn delete_server<S>(
    repository: &ServerRepository,
    audit: &AuditWriter,
    secret_store: &S,
    server_id: Id,
    confirmed: bool,
) -> Result<(), CoreError>
where
    S: SecretStore,
{
    if !confirmed {
        return Err(CoreError::new(
            CoreErrorCode::Cancelled,
            "server deletion requires explicit confirmation",
            false,
        ));
    }

    let result = async {
        let secret_ref = repository.deletion_secret_ref(server_id).await?;
        if let Some(secret_ref) = &secret_ref {
            secret_store.delete(secret_ref).await?;
        }
        repository.delete(server_id, secret_ref.as_ref()).await
    }
    .await;
    let audit_result = audit_server_outcome(
        audit,
        "server.delete",
        Some(server_id),
        &result,
        &["server", "secret"],
    )
    .await;
    complete_with_audit(result, audit_result)
}

pub(crate) async fn set_server_credential<S>(
    repository: &ServerRepository,
    audit: &AuditWriter,
    secret_store: &S,
    request: ServerCredentialSetRequest,
) -> Result<(), CoreError>
where
    S: SecretStore,
{
    if request.secret.is_empty() || request.secret.len() > 64 * 1024 {
        return Err(CoreError::new(
            CoreErrorCode::Validation,
            "server credential must contain 1 byte to 64 KiB",
            false,
        ));
    }
    let server = repository.get(request.server_id).await?;
    let (kind, persisted_kind) = match server.auth_type {
        AuthType::Password => (SecretKind::Password, "password"),
        AuthType::PrivateKey => (SecretKind::PrivateKey, "private_key"),
        AuthType::Certificate => (SecretKind::Certificate, "certificate"),
        AuthType::SshAgent => {
            return Err(CoreError::new(
                CoreErrorCode::Validation,
                "SSH agent authentication does not accept a stored credential",
                false,
            ));
        }
    };
    let previous = repository.connection_secret_ref(server.id).await?;
    let replacement = secret_store
        .put(kind, server.id, SecretValue::new(request.secret))
        .await?;
    if let Some(previous) = &previous
        && let Err(error) = secret_store.delete(previous).await
    {
        let _ = secret_store.delete(&replacement).await;
        return Err(error);
    }
    if let Err(error) = repository
        .replace_connection_secret_ref(server.id, previous.as_ref(), &replacement, persisted_kind)
        .await
    {
        let _ = secret_store.delete(&replacement).await;
        return Err(error);
    }
    audit
        .append(
            AuditEvent::new(
                "server.credential_set",
                "server",
                "success",
                serde_json::json!({ "authType": server.auth_type }),
            )
            .with_server_id(server.id.to_string()),
        )
        .await
}

const SERVER_FIELDS: &[&str] = &[
    "authType",
    "environment",
    "groupId",
    "host",
    "name",
    "port",
    "tagIds",
    "username",
];

async fn audit_server_outcome<T>(
    audit: &AuditWriter,
    action: &str,
    server_id: Option<Id>,
    result: &Result<T, CoreError>,
    fields: &[&str],
) -> Result<(), CoreError> {
    let outcome = if result.is_ok() { "success" } else { "failure" };
    let mut event = AuditEvent::new(
        action,
        "server",
        outcome,
        serde_json::json!({
            "serverId": server_id.map(|id| id.to_string()),
            "fields": fields,
            "result": outcome,
        }),
    );
    if let Some(server_id) = server_id {
        event = event
            .with_resource_id(server_id.to_string())
            .with_server_id(server_id.to_string());
    }
    audit.append(event).await
}

fn complete_with_audit<T>(
    operation: Result<T, CoreError>,
    audit: Result<(), CoreError>,
) -> Result<T, CoreError> {
    match operation {
        Ok(value) => audit.map(|()| value),
        Err(error) => Err(error),
    }
}

pub(crate) async fn preview_import_at(
    repository: &ServerRepository,
    store: &mut ImportPreviewStore,
    session_id: &str,
    format: ImportFormat,
    source: &str,
    now: Instant,
) -> Result<ImportPreview, CoreError> {
    let raw_rows = parse_source(format, source)?;
    if raw_rows.len() > MAX_ROWS_PER_SESSION {
        return Err(validation_error(
            "server import exceeds the 10000 row limit",
        ));
    }

    let existing = repository
        .list()
        .await?
        .into_iter()
        .map(|server| (server.host, server.port, server.username))
        .collect::<HashSet<_>>();
    let group_ids = repository
        .list_groups()
        .await?
        .into_iter()
        .map(|group| group.id)
        .collect::<HashSet<_>>();
    let tag_ids = repository
        .list_tags()
        .await?
        .into_iter()
        .map(|tag| tag.id)
        .collect::<HashSet<_>>();
    let mut identities = existing.clone();
    let mut rows = Vec::with_capacity(raw_rows.len());

    for raw_row in raw_rows {
        let row_id = Id::new();
        match raw_row.and_then(parse_import_row) {
            Ok(input) => {
                let candidate = ImportServerCandidate::from_input(&input);
                if candidate
                    .group_id
                    .is_some_and(|id| !group_ids.contains(&id))
                    || candidate.tag_ids.iter().any(|id| !tag_ids.contains(id))
                {
                    rows.push(ImportPreviewRow {
                        row_id,
                        status: ImportRowStatus::Error,
                        server: None,
                        error: Some("server references an unknown group or tag".to_owned()),
                    });
                    continue;
                }
                let identity = candidate.identity();
                let duplicate = identities.contains(&identity);
                identities.insert(identity);
                rows.push(ImportPreviewRow {
                    row_id,
                    status: if duplicate {
                        ImportRowStatus::Duplicate
                    } else {
                        ImportRowStatus::Valid
                    },
                    server: Some(candidate),
                    error: None,
                });
            }
            Err(error) => rows.push(ImportPreviewRow {
                row_id,
                status: ImportRowStatus::Error,
                server: None,
                error: Some(error.message().to_owned()),
            }),
        }
    }

    let preview = ImportPreview {
        import_id: Id::new(),
        source_sha256: sha256(source.as_bytes()),
        rows,
    };
    let integrity_sha256 = import_integrity_digest(&preview.source_sha256, &preview.rows)?;
    store.insert(
        session_id,
        StoredImport {
            import_id: preview.import_id,
            source_sha256: preview.source_sha256.clone(),
            integrity_sha256,
            rows: preview.rows.clone(),
            created_at: now,
        },
        now,
    );
    Ok(preview)
}

pub(crate) async fn apply_import_at(
    repository: &ServerRepository,
    store: &mut ImportPreviewStore,
    session_id: &str,
    import_id: Id,
    selected_row_ids: &[Id],
    now: Instant,
) -> Result<Vec<ServerSummary>, CoreError> {
    if selected_row_ids.is_empty() {
        return Err(validation_error("at least one import row must be selected"));
    }
    let selected = selected_row_ids.iter().copied().collect::<HashSet<_>>();
    if selected.len() != selected_row_ids.len() {
        return Err(validation_error("selected import row ids must be unique"));
    }

    store.remove_expired(session_id, now);
    let session = store
        .sessions
        .get(session_id)
        .ok_or_else(import_not_found)?;
    let entry = session
        .iter()
        .find(|entry| entry.import_id == import_id)
        .ok_or_else(import_not_found)?;
    if entry.source_sha256.len() != 64
        || import_integrity_digest(&entry.source_sha256, &entry.rows)? != entry.integrity_sha256
    {
        return Err(CoreError::new(
            CoreErrorCode::Conflict,
            "server import preview failed its integrity check",
            false,
        ));
    }

    let mut inputs = Vec::with_capacity(selected.len());
    for row_id in selected_row_ids {
        let row = entry
            .rows
            .iter()
            .find(|row| row.row_id == *row_id)
            .ok_or_else(|| validation_error("selected import row does not exist"))?;
        if row.status != ImportRowStatus::Valid {
            return Err(validation_error("only valid import rows can be applied"));
        }
        inputs.push(
            row.server
                .as_ref()
                .ok_or_else(|| validation_error("valid import row has no server candidate"))?
                .to_input()?,
        );
    }

    let created = repository.create_many(inputs).await?;
    if let Some(session) = store.sessions.get_mut(session_id) {
        session.retain(|entry| entry.import_id != import_id);
        if session.is_empty() {
            store.sessions.remove(session_id);
        }
    }
    Ok(created)
}

pub(crate) async fn apply_import_with_audit(
    repository: &ServerRepository,
    store: &mut ImportPreviewStore,
    audit: &AuditWriter,
    session_id: &str,
    import_id: Id,
    selected_row_ids: &[Id],
    now: Instant,
) -> Result<Vec<ServerSummary>, CoreError> {
    let result = apply_import_at(
        repository,
        store,
        session_id,
        import_id,
        selected_row_ids,
        now,
    )
    .await;
    match &result {
        Ok(servers) => {
            for server in servers {
                let audit_result: Result<(), CoreError> = Ok(());
                audit_server_outcome(
                    audit,
                    "server.import_apply",
                    Some(server.id),
                    &audit_result,
                    SERVER_FIELDS,
                )
                .await?;
            }
        }
        Err(error) => {
            let audit_result: Result<(), CoreError> = Err(error.clone());
            let _ = audit_server_outcome(
                audit,
                "server.import_apply",
                None,
                &audit_result,
                SERVER_FIELDS,
            )
            .await;
        }
    }
    result
}

impl ImportPreviewStore {
    pub(crate) fn clear_session(&mut self, session_id: &str) {
        self.sessions.remove(session_id);
    }

    fn insert(&mut self, session_id: &str, entry: StoredImport, now: Instant) {
        self.remove_expired(session_id, now);
        let session = self.sessions.entry(session_id.to_owned()).or_default();
        while session.len() >= MAX_IMPORTS_PER_SESSION
            || session.iter().map(|entry| entry.rows.len()).sum::<usize>() + entry.rows.len()
                > MAX_ROWS_PER_SESSION
        {
            if session.pop_front().is_none() {
                break;
            }
        }
        session.push_back(entry);
    }

    fn remove_expired(&mut self, session_id: &str, now: Instant) {
        if let Some(session) = self.sessions.get_mut(session_id) {
            session.retain(|entry| now.duration_since(entry.created_at) <= IMPORT_TTL);
            if session.is_empty() {
                self.sessions.remove(session_id);
            }
        }
    }
}

fn parse_source(format: ImportFormat, source: &str) -> Result<Vec<ParsedImportRow>, CoreError> {
    if source.is_empty() {
        return Err(validation_error("server import source must not be empty"));
    }
    match format {
        ImportFormat::Json => {
            let values: Vec<Value> = serde_json::from_str(source).map_err(|error| {
                validation_error(format!("invalid server import JSON: {error}"))
            })?;
            Ok(values
                .into_iter()
                .map(|value| match value {
                    Value::Object(fields) => sanitize_fields(fields),
                    _ => Err(validation_error(
                        "each server import JSON row must be an object",
                    )),
                })
                .collect())
        }
        ImportFormat::Csv => {
            let mut reader = csv::ReaderBuilder::new()
                .trim(csv::Trim::All)
                .from_reader(source.as_bytes());
            let headers = reader
                .headers()
                .map_err(|error| validation_error(format!("invalid server import CSV: {error}")))?
                .clone();
            let contains_secret_column = headers.iter().any(is_secret_field);
            let mut rows = Vec::new();
            for record in reader.records() {
                let record = match record {
                    Ok(record) => record,
                    Err(error) => {
                        rows.push(Err(validation_error(format!(
                            "invalid server import CSV row: {error}"
                        ))));
                        continue;
                    }
                };
                if contains_secret_column {
                    rows.push(Err(secret_column_error()));
                    continue;
                }
                let mut fields = Map::new();
                for (field, value) in headers.iter().zip(record.iter()) {
                    if !ALLOWED_IMPORT_FIELDS.contains(&field) {
                        continue;
                    }
                    let value = match field {
                        "port" => value
                            .parse::<u64>()
                            .map(Value::from)
                            .unwrap_or_else(|_| Value::String(value.to_owned())),
                        "tagIds" => Value::Array(
                            value
                                .split(';')
                                .filter(|value| !value.is_empty())
                                .map(|value| Value::String(value.to_owned()))
                                .collect(),
                        ),
                        "groupId" if value.is_empty() => Value::Null,
                        _ => Value::String(value.to_owned()),
                    };
                    fields.insert(field.to_owned(), value);
                }
                rows.push(Ok(fields));
            }
            Ok(rows)
        }
    }
}

fn sanitize_fields(mut fields: Map<String, Value>) -> Result<Map<String, Value>, CoreError> {
    if fields.keys().any(|field| is_secret_field(field)) {
        return Err(secret_column_error());
    }
    fields.retain(|field, _| ALLOWED_IMPORT_FIELDS.contains(&field.as_str()));
    Ok(fields)
}

fn is_secret_field(field: &str) -> bool {
    let normalized = field
        .chars()
        .filter(|character| !matches!(character, '_' | '-'))
        .flat_map(char::to_lowercase)
        .collect::<String>();
    matches!(
        normalized.as_str(),
        "password" | "privatekey" | "passphrase" | "secret" | "token" | "apikey"
    )
}

fn secret_column_error() -> CoreError {
    validation_error(
        "secret columns are not accepted; configure credentials through the secure input",
    )
}

fn parse_import_row(fields: Map<String, Value>) -> Result<ServerInput, CoreError> {
    let required_string = |field: &str| -> Result<&str, CoreError> {
        fields
            .get(field)
            .and_then(Value::as_str)
            .ok_or_else(|| validation_error(format!("server import row requires {field}")))
    };
    let port = fields
        .get("port")
        .and_then(Value::as_u64)
        .and_then(|port| u32::try_from(port).ok())
        .ok_or_else(|| validation_error("server import row requires an integer port"))?;
    let environment = serde_json::from_value::<ServerEnvironment>(
        fields
            .get("environment")
            .cloned()
            .ok_or_else(|| validation_error("server import row requires environment"))?,
    )
    .map_err(|_| validation_error("server import row has an invalid environment"))?;
    let auth_type = serde_json::from_value::<AuthType>(
        fields
            .get("authType")
            .cloned()
            .ok_or_else(|| validation_error("server import row requires authType"))?,
    )
    .map_err(|_| validation_error("server import row has an invalid authType"))?;
    let group_id = fields
        .get("groupId")
        .and_then(Value::as_str)
        .map(parse_id)
        .transpose()?;
    let tag_ids = fields
        .get("tagIds")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .ok_or_else(|| validation_error("tagIds must contain UUID strings"))
                        .and_then(parse_id)
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?
        .unwrap_or_default();

    ServerInput::try_new(
        required_string("name")?,
        required_string("host")?,
        port,
        required_string("username")?,
        environment,
        auth_type,
        group_id,
        tag_ids,
    )
}

fn parse_id(value: &str) -> Result<Id, CoreError> {
    Id::from_str(value).map_err(|_| validation_error("server import contains an invalid UUID"))
}

fn import_integrity_digest(
    source_sha256: &str,
    rows: &[ImportPreviewRow],
) -> Result<String, CoreError> {
    let rows = serde_json::to_vec(rows)
        .map_err(|error| CoreError::new(CoreErrorCode::Internal, error.to_string(), false))?;
    let mut digest = Sha256::new();
    digest.update(source_sha256.as_bytes());
    digest.update(rows);
    Ok(format!("{:x}", digest.finalize()))
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn import_not_found() -> CoreError {
    CoreError::new(
        CoreErrorCode::NotFound,
        "server import preview was not found or has expired",
        false,
    )
}

fn validation_error(message: impl Into<String>) -> CoreError {
    CoreError::new(CoreErrorCode::Validation, message, false)
}

fn services(app: &AppHandle) -> CoreServices<KeyringSecretStore> {
    app.state::<CoreServices<KeyringSecretStore>>()
        .inner()
        .clone()
}

#[tauri::command]
pub(crate) async fn server_list(app: AppHandle) -> Result<Vec<ServerSummary>, CoreError> {
    let services = services(&app);
    ServerRepository::new(services.database).list().await
}

#[tauri::command]
pub(crate) async fn server_create(
    app: AppHandle,
    input: ServerMutationInput,
) -> Result<ServerSummary, CoreError> {
    let services = services(&app);
    create_server(
        &ServerRepository::new(services.database),
        &services.audit_writer,
        input.into_domain()?,
    )
    .await
}

#[tauri::command]
pub(crate) async fn server_update(
    app: AppHandle,
    server_id: Id,
    input: ServerMutationInput,
) -> Result<ServerSummary, CoreError> {
    let services = services(&app);
    update_server(
        &ServerRepository::new(services.database),
        &services.audit_writer,
        server_id,
        input.into_domain()?,
    )
    .await
}

#[tauri::command]
pub(crate) async fn server_delete(
    app: AppHandle,
    request: ServerDeleteRequest,
) -> Result<(), CoreError> {
    let services = services(&app);
    delete_server(
        &ServerRepository::new(services.database),
        &services.audit_writer,
        services.secret_store.as_ref(),
        request.server_id,
        request.confirmed,
    )
    .await
}

#[tauri::command]
pub(crate) async fn server_credential_set(
    app: AppHandle,
    request: ServerCredentialSetRequest,
) -> Result<(), CoreError> {
    let services = services(&app);
    set_server_credential(
        &ServerRepository::new(services.database),
        &services.audit_writer,
        services.secret_store.as_ref(),
        request,
    )
    .await
}

#[tauri::command]
pub(crate) async fn server_group_list(app: AppHandle) -> Result<Vec<ServerGroup>, CoreError> {
    let services = services(&app);
    ServerRepository::new(services.database).list_groups().await
}

#[tauri::command]
pub(crate) async fn server_group_create(
    app: AppHandle,
    input: GroupMutationInput,
) -> Result<ServerGroup, CoreError> {
    let services = services(&app);
    ServerRepository::new(services.database)
        .create_group(&input.name, input.sort_order)
        .await
}

#[tauri::command]
pub(crate) async fn server_group_update(
    app: AppHandle,
    group_id: Id,
    input: GroupMutationInput,
) -> Result<ServerGroup, CoreError> {
    let services = services(&app);
    ServerRepository::new(services.database)
        .update_group(group_id, &input.name, input.sort_order)
        .await
}

#[tauri::command]
pub(crate) async fn server_group_delete(app: AppHandle, group_id: Id) -> Result<(), CoreError> {
    let services = services(&app);
    ServerRepository::new(services.database)
        .delete_group(group_id)
        .await
}

#[tauri::command]
pub(crate) async fn server_tag_list(app: AppHandle) -> Result<Vec<ServerTag>, CoreError> {
    let services = services(&app);
    ServerRepository::new(services.database).list_tags().await
}

#[tauri::command]
pub(crate) async fn server_tag_create(
    app: AppHandle,
    input: TagMutationInput,
) -> Result<ServerTag, CoreError> {
    let services = services(&app);
    ServerRepository::new(services.database)
        .create_tag(&input.name)
        .await
}

#[tauri::command]
pub(crate) async fn server_tag_update(
    app: AppHandle,
    tag_id: Id,
    input: TagMutationInput,
) -> Result<ServerTag, CoreError> {
    let services = services(&app);
    ServerRepository::new(services.database)
        .update_tag(tag_id, &input.name)
        .await
}

#[tauri::command]
pub(crate) async fn server_tag_delete(app: AppHandle, tag_id: Id) -> Result<(), CoreError> {
    let services = services(&app);
    ServerRepository::new(services.database)
        .delete_tag(tag_id)
        .await
}

#[tauri::command]
pub(crate) async fn server_import_preview(
    app: AppHandle,
    window: WebviewWindow,
    request: ImportPreviewRequest,
) -> Result<ImportPreview, CoreError> {
    let services = services(&app);
    let repository = ServerRepository::new(services.database);
    let mut previews = services.import_previews.lock().await;
    preview_import_at(
        &repository,
        &mut previews,
        window.label(),
        request.format,
        &request.source,
        Instant::now(),
    )
    .await
}

#[tauri::command]
pub(crate) async fn server_import_apply(
    app: AppHandle,
    window: WebviewWindow,
    request: ImportApplyRequest,
) -> Result<ImportApplyResult, CoreError> {
    let services = services(&app);
    let repository = ServerRepository::new(services.database);
    let result = {
        let mut previews = services.import_previews.lock().await;
        apply_import_with_audit(
            &repository,
            &mut previews,
            &services.audit_writer,
            window.label(),
            request.import_id,
            &request.row_ids,
            Instant::now(),
        )
        .await
    };

    result.map(|servers| ImportApplyResult { servers })
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        time::{Duration, Instant},
    };

    use async_trait::async_trait;
    use opspilot_audit::{AuditWriter, Redactor};
    use opspilot_domain::{AuthType, CoreError, CoreErrorCode, Id, ServerEnvironment, ServerInput};
    use opspilot_persistence::{Database, ServerRepository};
    use opspilot_secrets::{MemorySecretStore, SecretKind, SecretRef, SecretStore, SecretValue};
    use tempfile::tempdir;

    use super::{
        ImportApplyResult, ImportFormat, ImportPreviewStore, ImportRowStatus,
        ServerCredentialSetRequest, ServerMutationInput, apply_import_at, apply_import_with_audit,
        create_server, delete_server, preview_import_at, set_server_credential,
    };

    fn server_input(name: &str, host: &str) -> ServerInput {
        ServerInput::try_new(
            name,
            host,
            22,
            "deploy",
            ServerEnvironment::Production,
            AuthType::SshAgent,
            None,
            Vec::new(),
        )
        .expect("fixture should be valid")
    }

    fn password_server_input(name: &str, host: &str) -> ServerInput {
        ServerInput::try_new(
            name,
            host,
            22,
            "deploy",
            ServerEnvironment::Production,
            AuthType::Password,
            None,
            Vec::new(),
        )
        .expect("fixture should be valid")
    }

    struct UnavailableDeleteSecretStore;

    #[async_trait]
    impl SecretStore for UnavailableDeleteSecretStore {
        async fn put(
            &self,
            _kind: SecretKind,
            _owner_id: Id,
            _value: SecretValue,
        ) -> Result<SecretRef, CoreError> {
            Err(secret_store_unavailable())
        }

        async fn get(&self, _secret_ref: &SecretRef) -> Result<SecretValue, CoreError> {
            Err(secret_store_unavailable())
        }

        async fn delete(&self, _secret_ref: &SecretRef) -> Result<(), CoreError> {
            Err(secret_store_unavailable())
        }
    }

    fn secret_store_unavailable() -> CoreError {
        CoreError::new(
            CoreErrorCode::SecretUnavailable,
            "credential backend is unavailable",
            false,
        )
    }

    #[test]
    fn import_apply_result_matches_the_typescript_object_contract() {
        let result = ImportApplyResult {
            servers: Vec::new(),
        };

        assert_eq!(
            serde_json::to_value(result).unwrap(),
            serde_json::json!({
                "servers": []
            })
        );
    }

    #[test]
    fn server_mutation_input_requires_the_same_fields_as_typescript() {
        let missing_tag_ids = serde_json::json!({
            "name": "Server",
            "host": "server.example.com",
            "port": 22,
            "username": "deploy",
            "environment": "production",
            "authType": "ssh_agent"
        });

        assert!(serde_json::from_value::<ServerMutationInput>(missing_tag_ids).is_err());
    }

    #[tokio::test]
    async fn credential_is_kept_in_secret_store_and_only_its_reference_is_persisted() {
        let directory = tempdir().expect("temporary directory should be created");
        let database_path = directory.path().join("credential.sqlite3");
        let database = Database::open(&database_path)
            .await
            .expect("database should open");
        let repository = ServerRepository::new(database.clone());
        let audit = AuditWriter::new(database.clone(), Redactor::new(["fixture-password"]));
        let secrets = MemorySecretStore::default();
        let server = repository
            .create(password_server_input(
                "Password server",
                "password.example.com",
            ))
            .await
            .expect("server should be created");

        set_server_credential(
            &repository,
            &audit,
            &secrets,
            ServerCredentialSetRequest {
                server_id: server.id,
                secret: "fixture-password".to_owned(),
            },
        )
        .await
        .expect("credential should be stored");

        let secret_ref = repository
            .connection_secret_ref(server.id)
            .await
            .expect("credential reference should be readable")
            .expect("credential reference should exist");
        assert_eq!(
            secrets
                .get(&secret_ref)
                .await
                .expect("secret should remain available")
                .expose(),
            "fixture-password"
        );

        database.pool().close().await;
        drop(database);
        for entry in fs::read_dir(directory.path()).expect("database directory should be readable")
        {
            let path = entry.expect("database entry should be readable").path();
            if path.is_file() {
                let bytes = fs::read(path).expect("database file should be readable");
                assert!(
                    !bytes
                        .windows(b"fixture-password".len())
                        .any(|candidate| candidate == b"fixture-password")
                );
            }
        }
    }

    #[tokio::test]
    async fn csv_preview_is_redacted_read_only_and_apply_is_session_bound_one_time() {
        let database = Database::open(":memory:")
            .await
            .expect("in-memory database should open");
        let repository = ServerRepository::new(database);
        repository
            .create(server_input("Existing", "existing.example.com"))
            .await
            .expect("duplicate fixture should be created");
        let source = concat!(
            "name,host,port,username,environment,authType\n",
            "New API,new.example.com,22,deploy,production,ssh_agent\n",
            "Existing,EXISTING.example.com,22,deploy,production,ssh_agent\n",
            "Bad Port,bad.example.com,0,deploy,staging,password\n",
        );
        let now = Instant::now();
        let mut store = ImportPreviewStore::default();

        let preview = preview_import_at(
            &repository,
            &mut store,
            "main-window",
            ImportFormat::Csv,
            source,
            now,
        )
        .await
        .expect("preview should parse every CSV row");

        assert_eq!(
            preview
                .rows
                .iter()
                .map(|row| row.status)
                .collect::<Vec<_>>(),
            vec![
                ImportRowStatus::Valid,
                ImportRowStatus::Duplicate,
                ImportRowStatus::Error,
            ]
        );
        assert_eq!(preview.source_sha256.len(), 64);
        assert_eq!(repository.list().await.unwrap().len(), 1);

        let secret_source = concat!(
            "name,host,port,username,environment,authType,password\n",
            "Secret row,secret-row.example.com,22,deploy,production,password,DO_NOT_KEEP\n",
        );
        let secret_preview = preview_import_at(
            &repository,
            &mut store,
            "main-window",
            ImportFormat::Csv,
            secret_source,
            now,
        )
        .await
        .expect("secret columns should be rejected per row, not abort the preview");
        assert_eq!(secret_preview.rows[0].status, ImportRowStatus::Error);
        assert!(
            !serde_json::to_string(&secret_preview)
                .unwrap()
                .contains("DO_NOT_KEEP")
        );

        let valid_row_id = preview.rows[0].row_id;
        let wrong_session = apply_import_at(
            &repository,
            &mut store,
            "other-window",
            preview.import_id,
            &[valid_row_id],
            now,
        )
        .await
        .expect_err("another desktop session must not consume the preview");
        assert_eq!(wrong_session.code(), CoreErrorCode::NotFound);

        let applied = apply_import_at(
            &repository,
            &mut store,
            "main-window",
            preview.import_id,
            &[valid_row_id],
            now,
        )
        .await
        .expect("selected valid rows should be imported atomically");
        assert_eq!(applied.len(), 1);
        assert_eq!(applied[0].host, "new.example.com");
        assert_eq!(repository.list().await.unwrap().len(), 2);

        let reused = apply_import_at(
            &repository,
            &mut store,
            "main-window",
            preview.import_id,
            &[valid_row_id],
            now,
        )
        .await
        .expect_err("successful apply must consume the import id");
        assert_eq!(reused.code(), CoreErrorCode::NotFound);
    }

    #[tokio::test]
    async fn json_preview_expires_and_rejects_non_valid_rows() {
        let database = Database::open(":memory:")
            .await
            .expect("in-memory database should open");
        let repository = ServerRepository::new(database);
        let source = serde_json::json!([
            {
                "name": "JSON server",
                "host": "json.example.com",
                "port": 22,
                "username": "deploy",
                "environment": "staging",
                "authType": "ssh_agent"
            },
            {
                "name": "Invalid JSON row",
                "host": "https://not-a-host.example.com",
                "port": 22,
                "username": "deploy",
                "environment": "other",
                "authType": "ssh_agent"
            }
        ])
        .to_string();
        let now = Instant::now();
        let mut store = ImportPreviewStore::default();
        let preview = preview_import_at(
            &repository,
            &mut store,
            "main-window",
            ImportFormat::Json,
            &source,
            now,
        )
        .await
        .expect("structured JSON should produce a preview");
        assert_eq!(preview.rows[0].status, ImportRowStatus::Valid);
        assert_eq!(preview.rows[1].status, ImportRowStatus::Error);
        assert!(
            !serde_json::to_string(&preview)
                .unwrap()
                .contains("privateKey")
        );

        let secret_source = serde_json::json!([{
            "name": "Secret JSON row",
            "host": "secret-json.example.com",
            "port": 22,
            "username": "deploy",
            "environment": "production",
            "authType": "private_key",
            "privateKey": "MUST_NOT_BE_RETAINED"
        }])
        .to_string();
        let secret_preview = preview_import_at(
            &repository,
            &mut store,
            "main-window",
            ImportFormat::Json,
            &secret_source,
            now,
        )
        .await
        .expect("secret JSON fields should become a rejected preview row");
        assert_eq!(secret_preview.rows[0].status, ImportRowStatus::Error);
        assert!(
            !serde_json::to_string(&secret_preview)
                .unwrap()
                .contains("MUST_NOT_BE_RETAINED")
        );

        let invalid_selection = apply_import_at(
            &repository,
            &mut store,
            "main-window",
            preview.import_id,
            &[preview.rows[1].row_id],
            now,
        )
        .await
        .expect_err("error rows must never be imported");
        assert_eq!(invalid_selection.code(), CoreErrorCode::Validation);

        let expired = apply_import_at(
            &repository,
            &mut store,
            "main-window",
            preview.import_id,
            &[preview.rows[0].row_id],
            now + Duration::from_secs(15 * 60 + 1),
        )
        .await
        .expect_err("preview must expire after fifteen minutes");
        assert_eq!(expired.code(), CoreErrorCode::NotFound);
        assert!(repository.list().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn command_mutations_audit_only_redacted_outcomes_and_never_false_success() {
        let database = Database::open(":memory:")
            .await
            .expect("in-memory database should open");
        let repository = ServerRepository::new(database.clone());
        let audit = AuditWriter::new(database.clone(), Redactor::default());
        let secret_store = UnavailableDeleteSecretStore;

        let created = create_server(
            &repository,
            &audit,
            server_input("Audit host", "audit-sensitive.example.com"),
        )
        .await
        .expect("server create should succeed and be audited");
        let not_confirmed = delete_server(&repository, &audit, &secret_store, created.id, false)
            .await
            .expect_err("delete must require explicit confirmation");
        assert_eq!(not_confirmed.code(), CoreErrorCode::Cancelled);
        assert_eq!(repository.get(created.id).await.unwrap().id, created.id);
        let secret_ref = SecretRef::from_persisted("internal-secret-account")
            .expect("fixture reference should be valid");
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
            .expect("server should reference secret metadata");

        let error = delete_server(&repository, &audit, &secret_store, created.id, true)
            .await
            .expect_err("unavailable credential backend must make delete report failure");
        assert_eq!(error.code(), CoreErrorCode::SecretUnavailable);
        assert_eq!(repository.get(created.id).await.unwrap().id, created.id);
        let metadata_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM secret_refs WHERE ref = ?")
                .bind(secret_ref.as_str())
                .fetch_one(database.pool())
                .await
                .expect("secret metadata count should be readable");
        assert_eq!(metadata_count, 1);

        let events = sqlx::query_as::<_, (String, String, String)>(
            "SELECT action, result, redacted_payload FROM audit_logs ORDER BY created_at, rowid",
        )
        .fetch_all(database.pool())
        .await
        .expect("audit events should be readable");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].0, "server.create");
        assert_eq!(events[0].1, "success");
        assert_eq!(events[1].0, "server.delete");
        assert_eq!(events[1].1, "failure");
        assert!(
            !events
                .iter()
                .any(|event| { event.0 == "server.delete" && event.1 == "success" })
        );
        let audit_json = serde_json::to_string(&events).unwrap();
        assert!(!audit_json.contains("audit-sensitive.example.com"));
        assert!(!audit_json.contains("deploy"));
        assert!(!audit_json.contains("internal-secret-account"));
    }

    #[tokio::test]
    async fn database_delete_failure_is_retryable_after_credential_cleanup() {
        let database = Database::open(":memory:")
            .await
            .expect("in-memory database should open");
        let repository = ServerRepository::new(database.clone());
        let audit = AuditWriter::new(database.clone(), Redactor::default());
        let secret_store = MemorySecretStore::default();
        let created = create_server(
            &repository,
            &audit,
            server_input("Retry delete", "retry-delete.example.com"),
        )
        .await
        .expect("server create should succeed");
        let secret_ref = secret_store
            .put(
                SecretKind::Password,
                created.id,
                SecretValue::new("retry-delete-secret"),
            )
            .await
            .expect("credential fixture should be stored");
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
            .expect("server should reference secret metadata");
        sqlx::query(
            "CREATE TRIGGER fail_server_delete
             BEFORE DELETE ON servers
             BEGIN
                 SELECT RAISE(ABORT, 'delete fixture');
             END",
        )
        .execute(database.pool())
        .await
        .expect("delete failure trigger should be created");

        let first_error = delete_server(&repository, &audit, &secret_store, created.id, true)
            .await
            .expect_err("database failure must be reported after credential cleanup");
        assert_eq!(first_error.code(), CoreErrorCode::Internal);
        assert_eq!(repository.get(created.id).await.unwrap().id, created.id);
        assert_eq!(
            secret_store
                .get(&secret_ref)
                .await
                .expect_err("credential cleanup should finish before database deletion")
                .code(),
            CoreErrorCode::SecretUnavailable
        );
        let metadata_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM secret_refs WHERE ref = ?")
                .bind(secret_ref.as_str())
                .fetch_one(database.pool())
                .await
                .expect("secret metadata count should be readable");
        assert_eq!(metadata_count, 1);

        sqlx::query("DROP TRIGGER fail_server_delete")
            .execute(database.pool())
            .await
            .expect("delete failure trigger should be removed");
        delete_server(&repository, &audit, &secret_store, created.id, true)
            .await
            .expect("idempotent credential cleanup should allow deletion retry");

        assert_eq!(
            repository.get(created.id).await.unwrap_err().code(),
            CoreErrorCode::NotFound
        );
        let metadata_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM secret_refs WHERE ref = ?")
                .bind(secret_ref.as_str())
                .fetch_one(database.pool())
                .await
                .expect("secret metadata count should be readable");
        assert_eq!(metadata_count, 0);
        let outcomes: Vec<String> = sqlx::query_scalar(
            "SELECT result FROM audit_logs WHERE action = 'server.delete' ORDER BY created_at, rowid",
        )
        .fetch_all(database.pool())
        .await
        .expect("delete audit outcomes should be readable");
        assert_eq!(outcomes, vec!["failure", "success"]);
    }

    #[tokio::test]
    async fn preview_cache_is_lru_bounded_and_session_close_clears_it() {
        let database = Database::open(":memory:")
            .await
            .expect("in-memory database should open");
        let repository = ServerRepository::new(database);
        let now = Instant::now();
        let mut store = ImportPreviewStore::default();
        let mut previews = Vec::new();

        for index in 0..11 {
            let source = serde_json::json!([{
                "name": format!("Server {index}"),
                "host": format!("server-{index}.example.com"),
                "port": 22,
                "username": "deploy",
                "environment": "development",
                "authType": "ssh_agent"
            }])
            .to_string();
            previews.push(
                preview_import_at(
                    &repository,
                    &mut store,
                    "main-window",
                    ImportFormat::Json,
                    &source,
                    now,
                )
                .await
                .expect("bounded preview should be created"),
            );
        }

        let evicted = apply_import_at(
            &repository,
            &mut store,
            "main-window",
            previews[0].import_id,
            &[previews[0].rows[0].row_id],
            now,
        )
        .await
        .expect_err("the eleventh import should evict the least recently inserted preview");
        assert_eq!(evicted.code(), CoreErrorCode::NotFound);

        store.clear_session("main-window");
        let cleared = apply_import_at(
            &repository,
            &mut store,
            "main-window",
            previews[10].import_id,
            &[previews[10].rows[0].row_id],
            now,
        )
        .await
        .expect_err("closing a desktop session must invalidate all of its previews");
        assert_eq!(cleared.code(), CoreErrorCode::NotFound);
    }

    #[tokio::test]
    async fn preview_rejects_more_than_ten_thousand_rows() {
        let database = Database::open(":memory:")
            .await
            .expect("in-memory database should open");
        let repository = ServerRepository::new(database);
        let row = serde_json::json!({
            "name": "Oversized",
            "host": "oversized.example.com",
            "port": 22,
            "username": "deploy",
            "environment": "other",
            "authType": "ssh_agent"
        });
        let source = serde_json::to_string(&vec![row; 10_001]).unwrap();
        let mut store = ImportPreviewStore::default();

        let error = preview_import_at(
            &repository,
            &mut store,
            "main-window",
            ImportFormat::Json,
            &source,
            Instant::now(),
        )
        .await
        .expect_err("imports over the row limit must be rejected before caching");

        assert_eq!(error.code(), CoreErrorCode::Validation);
    }

    #[tokio::test]
    async fn import_apply_writes_one_redacted_success_audit_per_created_server() {
        let database = Database::open(":memory:")
            .await
            .expect("in-memory database should open");
        let repository = ServerRepository::new(database.clone());
        let audit = AuditWriter::new(database.clone(), Redactor::default());
        let source = serde_json::json!([{
            "name": "Audited import",
            "host": "import-audit-sensitive.example.com",
            "port": 22,
            "username": "sensitive-user",
            "environment": "production",
            "authType": "ssh_agent"
        }])
        .to_string();
        let now = Instant::now();
        let mut store = ImportPreviewStore::default();
        let preview = preview_import_at(
            &repository,
            &mut store,
            "main-window",
            ImportFormat::Json,
            &source,
            now,
        )
        .await
        .expect("preview should succeed");

        let created = apply_import_with_audit(
            &repository,
            &mut store,
            &audit,
            "main-window",
            preview.import_id,
            &[preview.rows[0].row_id],
            now,
        )
        .await
        .expect("apply should succeed and be audited");

        assert_eq!(created.len(), 1);
        let (action, result, payload): (String, String, String) =
            sqlx::query_as("SELECT action, result, redacted_payload FROM audit_logs")
                .fetch_one(database.pool())
                .await
                .expect("import audit should be persisted");
        assert_eq!(action, "server.import_apply");
        assert_eq!(result, "success");
        assert!(!payload.contains("import-audit-sensitive.example.com"));
        assert!(!payload.contains("sensitive-user"));
    }

    #[tokio::test]
    async fn apply_revalidates_the_source_digest_binding() {
        let database = Database::open(":memory:")
            .await
            .expect("in-memory database should open");
        let repository = ServerRepository::new(database);
        let source = serde_json::json!([{
            "name": "Digest bound",
            "host": "digest.example.com",
            "port": 22,
            "username": "deploy",
            "environment": "staging",
            "authType": "ssh_agent"
        }])
        .to_string();
        let now = Instant::now();
        let mut store = ImportPreviewStore::default();
        let preview = preview_import_at(
            &repository,
            &mut store,
            "main-window",
            ImportFormat::Json,
            &source,
            now,
        )
        .await
        .expect("preview should succeed");
        store
            .sessions
            .get_mut("main-window")
            .unwrap()
            .front_mut()
            .unwrap()
            .source_sha256 = "b".repeat(64);

        let error = apply_import_at(
            &repository,
            &mut store,
            "main-window",
            preview.import_id,
            &[preview.rows[0].row_id],
            now,
        )
        .await
        .expect_err("a changed source digest must invalidate the cached preview");

        assert_eq!(error.code(), CoreErrorCode::Conflict);
        assert!(repository.list().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn successful_mutation_reports_an_audit_write_failure() {
        let database = Database::open(":memory:")
            .await
            .expect("in-memory database should open");
        let repository = ServerRepository::new(database.clone());
        let audit = AuditWriter::new(database.clone(), Redactor::default());
        sqlx::query("DROP TABLE audit_logs")
            .execute(database.pool())
            .await
            .expect("test should make audit persistence unavailable");

        let error = create_server(
            &repository,
            &audit,
            server_input("Audit unavailable", "audit-unavailable.example.com"),
        )
        .await
        .expect_err("a successful mutation must not hide its audit write failure");

        assert_eq!(error.code(), CoreErrorCode::Internal);
        assert_eq!(repository.list().await.unwrap().len(), 1);
    }
}
