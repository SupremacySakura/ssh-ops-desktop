use opspilot_domain::{CoreError, Id};
use opspilot_persistence::{TaskEventPage, TaskRepository};
use tauri::State;

use super::CoreServices;

#[tauri::command]
pub(crate) async fn task_list(
    services: State<'_, CoreServices>,
    limit: Option<u32>,
) -> Result<Vec<opspilot_persistence::TaskEvent>, CoreError> {
    TaskRepository::new(services.database.clone())
        .list_latest(limit.unwrap_or(200))
        .await
}

#[tauri::command]
pub(crate) async fn audit_list(
    services: State<'_, CoreServices>,
    limit: Option<u32>,
) -> Result<Vec<opspilot_audit::AuditRecord>, CoreError> {
    opspilot_audit::AuditReader::new(services.database.clone())
        .list(limit.unwrap_or(200))
        .await
}

#[tauri::command]
pub(crate) async fn task_events_since(
    services: State<'_, CoreServices>,
    task_id: Id,
    after_sequence: u64,
    limit: Option<u32>,
) -> Result<TaskEventPage, CoreError> {
    TaskRepository::new(services.database.clone())
        .events_since(task_id, after_sequence, limit.unwrap_or(200))
        .await
}
