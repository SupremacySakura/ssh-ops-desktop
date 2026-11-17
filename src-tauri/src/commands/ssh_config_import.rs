use std::{
    collections::HashSet,
    env,
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use opspilot_domain::{AuthType, CoreError, CoreErrorCode, Id, Server, ServerInput};
use opspilot_persistence::ServerRepository;
use opspilot_secrets::KeyringSecretStore;
use opspilot_ssh_core::{SshConfigEntry, SshConfigImporter, read_ssh_config};
use serde::{Deserialize, Serialize};
use tauri::Manager;

use super::CoreServices;

const PREVIEW_TTL: Duration = Duration::from_secs(15 * 60);
const MAX_PREVIEWS: usize = 10;
const MAX_SELECTED_ROWS: usize = 500;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SshConfigImportApplyInput {
    pub(crate) preview_id: Id,
    pub(crate) selected_row_ids: Vec<Id>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SshConfigImportWarning {
    pub(crate) line: usize,
    pub(crate) message: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SshConfigImportStatus {
    Ready,
    Existing,
    DuplicateInBatch,
    Unsupported,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SshConfigImportItem {
    pub(crate) id: Id,
    pub(crate) alias: String,
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) identity_file: Option<String>,
    pub(crate) status: SshConfigImportStatus,
    pub(crate) unsupported_directives: Vec<String>,
    pub(crate) warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SshConfigImportPreview {
    pub(crate) preview_id: Id,
    pub(crate) source_path: String,
    pub(crate) items: Vec<SshConfigImportItem>,
    pub(crate) warnings: Vec<SshConfigImportWarning>,
    pub(crate) warning_count: usize,
    pub(crate) existing_count: usize,
    pub(crate) importable_count: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SshConfigImportResult {
    pub(crate) imported_count: usize,
    pub(crate) skipped_count: usize,
    pub(crate) servers: Vec<Server>,
}

#[derive(Clone, Debug)]
pub(crate) struct PreviewRecord {
    window_label: String,
    source_path: PathBuf,
    sha256: String,
    created_at: Instant,
    rows: Vec<PreviewRowRecord>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PreviewRowRecord {
    id: Id,
    alias: String,
    host: String,
    port: u16,
    username: String,
    importable: bool,
}

#[derive(Debug, Default)]
pub(crate) struct SshConfigPreviewRegistry {
    previews: std::collections::HashMap<Id, PreviewRecord>,
}

impl SshConfigPreviewRegistry {
    fn insert(&mut self, record: PreviewRecord) -> Id {
        self.evict_expired();
        if self.previews.len() >= MAX_PREVIEWS
            && let Some(oldest) = self
                .previews
                .iter()
                .min_by_key(|(_, record)| record.created_at)
                .map(|(id, _)| *id)
        {
            self.previews.remove(&oldest);
        }
        let id = Id::new();
        self.previews.insert(id, record);
        id
    }

    fn get(&mut self, id: Id, window_label: &str) -> Result<PreviewRecord, CoreError> {
        self.evict_expired();
        self.previews
            .get(&id)
            .filter(|record| record.window_label == window_label)
            .cloned()
            .ok_or_else(|| {
                CoreError::new(
                    CoreErrorCode::NotFound,
                    "SSH Config 导入预览不存在或已过期，请重新预览",
                    false,
                )
            })
    }

    fn evict_expired(&mut self) {
        let now = Instant::now();
        self.previews
            .retain(|_, record| now.duration_since(record.created_at) < PREVIEW_TTL);
    }
}

pub(crate) async fn preview_ssh_config<S>(
    services: &CoreServices<S>,
    window_label: &str,
) -> Result<SshConfigImportPreview, CoreError> {
    let source_path = configured_ssh_config_path(services)?;
    let document = read_ssh_config(&source_path)?;
    let parsed = SshConfigImporter::parse(&document.source)?;
    let existing = ServerRepository::new(services.database.clone())
        .list()
        .await?
        .into_iter()
        .map(|server| identity_key(&server.host, server.port, &server.user))
        .collect::<HashSet<_>>();

    let mut seen_batch = HashSet::new();
    let mut items = Vec::with_capacity(parsed.entries.len());
    let mut rows = Vec::with_capacity(parsed.entries.len());
    for entry in parsed.entries {
        let identity = identity_key(&entry.host, entry.port, &entry.username);
        let status = if existing.contains(&identity) {
            SshConfigImportStatus::Existing
        } else if !entry.importable {
            SshConfigImportStatus::Unsupported
        } else if !seen_batch.insert(identity) {
            SshConfigImportStatus::DuplicateInBatch
        } else {
            SshConfigImportStatus::Ready
        };
        let id = Id::new();
        rows.push(PreviewRowRecord {
            id,
            alias: entry.alias.clone(),
            host: entry.host.clone(),
            port: entry.port,
            username: entry.username.clone(),
            importable: entry.importable,
        });
        items.push(SshConfigImportItem {
            id,
            alias: entry.alias,
            host: entry.host,
            port: entry.port,
            username: entry.username,
            identity_file: entry.identity_file,
            status,
            unsupported_directives: entry.unsupported_directives,
            warnings: entry
                .warnings
                .into_iter()
                .map(|warning| format!("第 {} 行：{}", warning.line, warning.message))
                .collect(),
        });
    }

    let existing_count = items
        .iter()
        .filter(|item| item.status == SshConfigImportStatus::Existing)
        .count();
    let importable_count = items
        .iter()
        .filter(|item| item.status == SshConfigImportStatus::Ready)
        .count();
    let warnings = parsed
        .warnings
        .into_iter()
        .map(|warning| SshConfigImportWarning {
            line: warning.line,
            message: warning.message,
        })
        .collect::<Vec<_>>();
    let source_label = source_label(&source_path);
    let preview_id = {
        let mut registry = services.ssh_config_previews.lock().map_err(|_| {
            CoreError::new(
                CoreErrorCode::Internal,
                "SSH Config 导入预览状态不可用，请重试",
                true,
            )
        })?;
        registry.insert(PreviewRecord {
            window_label: window_label.to_owned(),
            source_path,
            sha256: document.sha256,
            created_at: Instant::now(),
            rows,
        })
    };

    Ok(SshConfigImportPreview {
        preview_id,
        source_path: source_label,
        items,
        warning_count: warnings.len(),
        warnings,
        existing_count,
        importable_count,
    })
}

pub(crate) async fn apply_ssh_config_import<S>(
    services: &CoreServices<S>,
    window_label: &str,
    input: SshConfigImportApplyInput,
) -> Result<SshConfigImportResult, CoreError> {
    if input.selected_row_ids.is_empty() {
        return Err(validation("请选择至少一台服务器"));
    }
    if input.selected_row_ids.len() > MAX_SELECTED_ROWS {
        return Err(validation("一次最多导入 500 台服务器"));
    }

    let record = {
        let mut registry = services.ssh_config_previews.lock().map_err(|_| {
            CoreError::new(
                CoreErrorCode::Internal,
                "SSH Config 导入预览状态不可用，请重试",
                true,
            )
        })?;
        registry.get(input.preview_id, window_label)?
    };

    let document = read_ssh_config(&record.source_path)
        .map_err(|_| conflict("SSH Config 已不可读或已在预览后更改，请重新预览"))?;
    if document.sha256 != record.sha256 {
        return Err(conflict("SSH Config 已在预览后更改，请重新预览后再导入"));
    }
    let parsed = SshConfigImporter::parse(&document.source)
        .map_err(|_| conflict("SSH Config 内容已变化，请重新预览"))?;

    let mut selected_ids = HashSet::new();
    let mut selected_rows = Vec::new();
    for row_id in input.selected_row_ids {
        if !selected_ids.insert(row_id) {
            continue;
        }
        let row = record
            .rows
            .iter()
            .find(|row| row.id == row_id)
            .ok_or_else(|| validation("所选条目不属于当前 SSH Config 预览，请重新预览"))?;
        if !row.importable {
            return Err(validation(
                "所选 SSH Config 条目包含暂不支持的连接语义，无法导入",
            ));
        }
        if !parsed
            .entries
            .iter()
            .any(|entry| matches_preview_row(entry, row))
        {
            return Err(conflict("SSH Config 内容与预览不一致，请重新预览后再导入"));
        }
        selected_rows.push(row.clone());
    }

    let mut inputs = Vec::with_capacity(selected_rows.len());
    for row in &selected_rows {
        inputs.push(ServerInput::try_new(
            &row.alias,
            &row.host,
            u32::from(row.port),
            &row.username,
            AuthType::Key,
            None,
            None,
            false,
        )?);
    }
    let batch = ServerRepository::new(services.database.clone())
        .create_many_skip_duplicates(&inputs, unix_timestamp()?)
        .await?;

    Ok(SshConfigImportResult {
        imported_count: batch.created.len(),
        skipped_count: selected_rows.len().saturating_sub(batch.created.len()),
        servers: batch.created,
    })
}

#[tauri::command]
pub(crate) async fn ssh_config_import_preview(
    window: tauri::Window,
) -> Result<SshConfigImportPreview, CoreError> {
    preview_ssh_config(&core_services(&window), window.label()).await
}

#[tauri::command]
pub(crate) async fn ssh_config_import_apply(
    window: tauri::Window,
    input: SshConfigImportApplyInput,
) -> Result<SshConfigImportResult, CoreError> {
    apply_ssh_config_import(&core_services(&window), window.label(), input).await
}

fn matches_preview_row(entry: &SshConfigEntry, row: &PreviewRowRecord) -> bool {
    entry.importable
        && entry.alias == row.alias
        && entry.host == row.host
        && entry.port == row.port
        && entry.username == row.username
}

fn configured_ssh_config_path<S>(services: &CoreServices<S>) -> Result<PathBuf, CoreError> {
    services
        .ssh_config_path
        .clone()
        .map_or_else(default_ssh_config_path, Ok)
}

fn default_ssh_config_path() -> Result<PathBuf, CoreError> {
    let home = env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .or_else(|| env::var_os("USERPROFILE").filter(|value| !value.is_empty()))
        .map(PathBuf::from)
        .ok_or_else(|| {
            CoreError::new(
                CoreErrorCode::Internal,
                "无法确定用户主目录，不能读取 ~/.ssh/config",
                false,
            )
        })?;
    Ok(home.join(".ssh").join("config"))
}

fn source_label(path: &Path) -> String {
    if default_ssh_config_path().is_ok_and(|default_path| default_path.as_path() == path) {
        "~/.ssh/config".to_owned()
    } else {
        path.display().to_string()
    }
}

fn identity_key(host: &str, port: u16, user: &str) -> String {
    format!("{}\0{port}\0{user}", host.to_ascii_lowercase())
}

fn unix_timestamp() -> Result<i64, CoreError> {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| {
            CoreError::new(
                CoreErrorCode::Internal,
                format!("system clock is before the Unix epoch: {error}"),
                false,
            )
        })?
        .as_secs();
    i64::try_from(seconds).map_err(|error| {
        CoreError::new(
            CoreErrorCode::Internal,
            format!("system time is outside the supported range: {error}"),
            false,
        )
    })
}

fn core_services(window: &tauri::Window) -> CoreServices<KeyringSecretStore> {
    window
        .state::<CoreServices<KeyringSecretStore>>()
        .inner()
        .clone()
}

fn validation(message: impl Into<String>) -> CoreError {
    CoreError::new(CoreErrorCode::Validation, message, false)
}

fn conflict(message: impl Into<String>) -> CoreError {
    CoreError::new(CoreErrorCode::Conflict, message, false)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use opspilot_domain::{AuthType, CoreErrorCode, Id, ServerInput};
    use opspilot_persistence::{Database, ServerRepository};
    use opspilot_secrets::MemorySecretStore;
    use serde_json::json;

    use super::super::CoreServices;
    use super::{
        SshConfigImportApplyInput, SshConfigImportStatus, apply_ssh_config_import,
        preview_ssh_config,
    };

    #[tokio::test]
    async fn preview_marks_existing_batch_duplicate_and_unsupported_rows() {
        let directory = tempfile::tempdir().expect("temporary directory should open");
        let config_path = directory.path().join("config");
        write_config(
            &config_path,
            "Host existing\n\
               HostName existing.example.com\n\
               User deploy\n\
             Host new-a\n\
               HostName new-a.example.com\n\
               User deploy\n\
               Port 2222\n\
             Host new-a-copy\n\
               HostName new-a.example.com\n\
               User deploy\n\
               Port 2222\n\
             Host proxied\n\
               HostName proxied.example.com\n\
               User deploy\n\
               ProxyJump bastion\n",
        );
        let services = test_services(&config_path).await;
        seed_server(&services, "existing.example.com", "deploy").await;

        let preview = preview_ssh_config(&services, "main")
            .await
            .expect("preview should be built");

        assert_eq!(preview.items.len(), 4);
        assert_eq!(preview.existing_count, 1);
        assert_eq!(preview.importable_count, 1);
        assert_eq!(preview.items[0].status, SshConfigImportStatus::Existing);
        assert_eq!(preview.items[1].status, SshConfigImportStatus::Ready);
        assert_eq!(
            preview.items[2].status,
            SshConfigImportStatus::DuplicateInBatch
        );
        assert_eq!(preview.items[3].status, SshConfigImportStatus::Unsupported);
        assert!(
            preview.items[3]
                .warnings
                .iter()
                .any(|warning| warning.contains("ProxyJump"))
        );
        assert!(preview.warning_count >= 1);
    }

    #[tokio::test]
    async fn preview_fails_closed_when_a_global_proxy_default_cannot_be_applied() {
        let directory = tempfile::tempdir().expect("temporary directory should open");
        let config_path = directory.path().join("config");
        write_config(
            &config_path,
            "Host *\n\
               ProxyJump bastion\n\
             Host direct\n\
               HostName direct.example.com\n\
               User deploy\n",
        );
        let services = test_services(&config_path).await;

        let preview = preview_ssh_config(&services, "main")
            .await
            .expect("global proxy defaults should be surfaced in the preview");

        assert_eq!(preview.items.len(), 1);
        assert_eq!(preview.items[0].status, SshConfigImportStatus::Unsupported);
        assert_eq!(preview.importable_count, 0);
        assert!(
            preview.items[0]
                .warnings
                .iter()
                .any(|warning| warning.contains("文件级配置"))
        );
    }

    #[tokio::test]
    async fn apply_persists_only_selected_pending_servers_and_can_be_replayed_safely() {
        let directory = tempfile::tempdir().expect("temporary directory should open");
        let config_path = directory.path().join("config");
        write_config(
            &config_path,
            "Host alpha\n\
               HostName alpha.example.com\n\
               User deploy\n\
             Host beta\n\
               HostName beta.example.com\n\
               User deploy\n\
               Port 2202\n",
        );
        let services = test_services(&config_path).await;
        let preview = preview_ssh_config(&services, "main")
            .await
            .expect("preview should be built");
        let alpha = preview
            .items
            .iter()
            .find(|item| item.alias == "alpha")
            .expect("alpha should be previewed");
        let input = SshConfigImportApplyInput {
            preview_id: preview.preview_id,
            selected_row_ids: vec![alpha.id],
        };

        let first = apply_ssh_config_import(&services, "main", input.clone())
            .await
            .expect("selected row should import");
        assert_eq!(first.imported_count, 1);
        assert_eq!(first.skipped_count, 0);
        assert_eq!(first.servers[0].name, "alpha");
        assert_eq!(first.servers[0].secret_ref, None);

        let servers = ServerRepository::new(services.database.clone())
            .list()
            .await
            .expect("servers should be listed");
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].host, "alpha.example.com");
        assert_eq!(servers[0].secret_ref, None);
        let trusted_hosts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM known_host_keys")
            .fetch_one(services.database.pool())
            .await
            .expect("known host count should be readable");
        assert_eq!(trusted_hosts, 0);

        let replay = apply_ssh_config_import(&services, "main", input)
            .await
            .expect("replaying the same preview should be safe");
        assert_eq!(replay.imported_count, 0);
        assert_eq!(replay.skipped_count, 1);
        assert_eq!(
            ServerRepository::new(services.database.clone())
                .list()
                .await
                .expect("servers should still be listed")
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn apply_rejects_a_changed_source_before_writing_any_rows() {
        let directory = tempfile::tempdir().expect("temporary directory should open");
        let config_path = directory.path().join("config");
        write_config(
            &config_path,
            "Host alpha\n  HostName alpha.example.com\n  User deploy\n",
        );
        let services = test_services(&config_path).await;
        let preview = preview_ssh_config(&services, "main")
            .await
            .expect("preview should be built");
        write_config(
            &config_path,
            "Host alpha\n  HostName changed.example.com\n  User deploy\n",
        );

        let error = apply_ssh_config_import(
            &services,
            "main",
            SshConfigImportApplyInput {
                preview_id: preview.preview_id,
                selected_row_ids: vec![preview.items[0].id],
            },
        )
        .await
        .expect_err("a changed SSH config must invalidate the preview");

        assert_eq!(error.code(), CoreErrorCode::Conflict);
        assert!(error.message().contains("更改"));
        assert!(
            ServerRepository::new(services.database.clone())
                .list()
                .await
                .expect("servers should be listed")
                .is_empty()
        );
    }

    #[tokio::test]
    async fn apply_rejects_unsupported_rows_and_previews_from_another_window() {
        let directory = tempfile::tempdir().expect("temporary directory should open");
        let config_path = directory.path().join("config");
        write_config(
            &config_path,
            "Host proxied\n\
               HostName proxied.example.com\n\
               User deploy\n\
               ProxyCommand ssh jump\n\
             Host direct\n\
               HostName direct.example.com\n\
               User deploy\n",
        );
        let services = test_services(&config_path).await;
        let preview = preview_ssh_config(&services, "main")
            .await
            .expect("preview should be built");
        let proxied = preview
            .items
            .iter()
            .find(|item| item.alias == "proxied")
            .expect("proxied should be previewed");

        let unsupported = apply_ssh_config_import(
            &services,
            "main",
            SshConfigImportApplyInput {
                preview_id: preview.preview_id,
                selected_row_ids: vec![proxied.id],
            },
        )
        .await
        .expect_err("unsupported semantics must not be silently dropped");
        assert_eq!(unsupported.code(), CoreErrorCode::Validation);

        let wrong_window = apply_ssh_config_import(
            &services,
            "other-window",
            SshConfigImportApplyInput {
                preview_id: preview.preview_id,
                selected_row_ids: vec![preview.items[1].id],
            },
        )
        .await
        .expect_err("preview ids are scoped to the requesting window");
        assert_eq!(wrong_window.code(), CoreErrorCode::NotFound);
    }

    #[test]
    fn apply_request_cannot_smuggle_server_fields() {
        let result = serde_json::from_value::<SshConfigImportApplyInput>(json!({
            "previewId": Id::new(),
            "selectedRowIds": [Id::new()],
            "host": "attacker.example.com",
            "user": "root"
        }));

        assert!(result.is_err());
    }

    #[test]
    fn ssh_config_import_contract_uses_frontend_camel_case_fields() {
        let row_id = Id::new();
        let preview = super::SshConfigImportPreview {
            preview_id: Id::new(),
            source_path: "~/.ssh/config".to_owned(),
            items: vec![super::SshConfigImportItem {
                id: row_id,
                alias: "prod".to_owned(),
                host: "prod.example.com".to_owned(),
                port: 2222,
                username: "deploy".to_owned(),
                identity_file: None,
                status: SshConfigImportStatus::DuplicateInBatch,
                unsupported_directives: vec!["ProxyJump".to_owned()],
                warnings: vec!["第 4 行：ProxyJump 暂不支持。".to_owned()],
            }],
            warnings: vec![super::SshConfigImportWarning {
                line: 1,
                message: "通配 Host 已忽略。".to_owned(),
            }],
            warning_count: 1,
            existing_count: 0,
            importable_count: 0,
        };

        let value = serde_json::to_value(&preview).expect("preview should serialize");

        assert_eq!(value["previewId"], preview.preview_id.to_string());
        assert_eq!(value["warningCount"], 1);
        assert_eq!(value["items"][0]["id"], row_id.to_string());
        assert_eq!(value["items"][0]["identityFile"], serde_json::Value::Null);
        assert_eq!(value["items"][0]["status"], "duplicateInBatch");
        assert!(value.get("preview_id").is_none());
        assert!(value["items"][0].get("unsupported_directives").is_none());
    }

    #[test]
    fn preview_registry_expires_records_and_evicts_the_oldest_entry() {
        let mut registry = super::SshConfigPreviewRegistry::default();
        let now = std::time::Instant::now();
        let expired_id = registry.insert(super::PreviewRecord {
            window_label: "main".to_owned(),
            source_path: std::path::PathBuf::from("/tmp/config"),
            sha256: "digest".to_owned(),
            created_at: now - super::PREVIEW_TTL - std::time::Duration::from_secs(1),
            rows: Vec::new(),
        });
        assert_eq!(
            registry.get(expired_id, "main").unwrap_err().code(),
            CoreErrorCode::NotFound
        );

        let mut ids = Vec::new();
        for offset in (1..=super::MAX_PREVIEWS + 1).rev() {
            ids.push(registry.insert(super::PreviewRecord {
                window_label: "main".to_owned(),
                source_path: std::path::PathBuf::from("/tmp/config"),
                sha256: "digest".to_owned(),
                created_at: now - std::time::Duration::from_secs(offset as u64),
                rows: Vec::new(),
            }));
        }
        assert_eq!(
            registry.get(ids[0], "main").unwrap_err().code(),
            CoreErrorCode::NotFound
        );
        assert!(registry.get(ids[1], "main").is_ok());
    }

    async fn test_services(path: &std::path::Path) -> CoreServices<MemorySecretStore> {
        let database = Database::open(":memory:")
            .await
            .expect("in-memory database should open");
        CoreServices::new(database, MemorySecretStore::default())
            .with_ssh_config_path(path.to_path_buf())
    }

    async fn seed_server<S>(services: &CoreServices<S>, host: &str, user: &str) {
        let input = ServerInput::try_new(
            "existing",
            host,
            22,
            user,
            AuthType::Key,
            Some("existing-secret-ref"),
            None,
            false,
        )
        .expect("fixture server should be valid");
        ServerRepository::new(services.database.clone())
            .create(&input, 1_700_000_000)
            .await
            .expect("fixture server should be created");
    }

    fn write_config(path: &std::path::Path, source: &str) {
        fs::write(path, source).expect("fixture SSH config should be written");
    }
}
