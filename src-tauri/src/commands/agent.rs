use opspilot_agent_bridge::{AgentContextBuilder, AgentRunScope, ToolRegistry};
use opspilot_audit::{AuditEvent, Redactor};
use opspilot_domain::{AgentRunStatus, CoreError, CoreErrorCode, Id, ToolCall};
use opspilot_persistence::{
    AgentRepository, AgentRunSummary, AgentThreadSummary, ModelProfileRepository,
};
use opspilot_remote_adapters::{RemoteExecutor, RemoteLinuxAdapter};
use opspilot_secrets::SecretStore;
use opspilot_ssh_core::ConnectionHandle;
use opspilot_task_engine::PrepareResult;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use super::CoreServices;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentAvailability {
    agent_available: bool,
    reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentRunCreateRequest {
    thread_id: Id,
    server_id: Id,
    model_profile_id: Option<Id>,
    connection: ConnectionHandle,
    input: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RequestedToolCall {
    name: String,
    args: Value,
}

#[tauri::command]
pub(crate) async fn agent_status(
    services: State<'_, CoreServices>,
) -> Result<AgentAvailability, CoreError> {
    let agent_available = services.agent_sidecar.lock().await.is_some();
    let reason = if agent_available {
        None
    } else {
        services.agent_unavailable_reason.lock().await.clone()
    };
    Ok(AgentAvailability {
        agent_available,
        reason,
    })
}

#[tauri::command]
pub(crate) async fn agent_catalog(
    services: State<'_, CoreServices>,
) -> Result<Vec<opspilot_agent_bridge::ToolDescriptor>, CoreError> {
    Ok(services.agent_tools.catalog().to_vec())
}

#[tauri::command]
pub(crate) async fn agent_thread_list(
    services: State<'_, CoreServices>,
) -> Result<Vec<AgentThreadSummary>, CoreError> {
    AgentRepository::new(services.database.clone())
        .list_threads()
        .await
}

#[tauri::command]
pub(crate) async fn agent_thread_create(
    services: State<'_, CoreServices>,
    title: String,
) -> Result<AgentThreadSummary, CoreError> {
    AgentRepository::new(services.database.clone())
        .create_thread(&title)
        .await
}

#[tauri::command]
pub(crate) async fn agent_run_start(
    app: AppHandle,
    services: State<'_, CoreServices>,
    request: AgentRunCreateRequest,
) -> Result<AgentRunSummary, CoreError> {
    if request.connection.server_id() != request.server_id {
        return Err(CoreError::new(
            CoreErrorCode::ToolScopeViolation,
            "Agent connection does not belong to the selected server",
            false,
        ));
    }
    let models = ModelProfileRepository::new(services.database.clone());
    let profile = models
        .get(request.model_profile_id.ok_or_else(|| {
            CoreError::new(
                CoreErrorCode::Validation,
                "Agent run requires a model profile",
                false,
            )
        })?)
        .await?;
    let secret = match models.secret_ref(profile.id).await? {
        Some(secret_ref) => Some(services.secret_store.get(&secret_ref).await?),
        None => None,
    };
    let repository = AgentRepository::new(services.database.clone());
    let run = repository
        .create_run(
            request.thread_id,
            request.server_id,
            Some(profile.id),
            &request.input,
        )
        .await?;
    let _ = app.emit(
        "agent:plan",
        serde_json::json!({
            "runId": run.id,
            "sequence": 1,
            "summary": "Read the scoped server overview, then explain the result",
            "steps": [{
                "id": Id::new(),
                "title": "Read the selected server overview",
                "rationale": "Ground the response in data returned by the Rust Core",
                "toolName": "server.overview",
                "expectedRisk": "L0"
            }],
        }),
    );
    repository
        .transition(
            run.id,
            AgentRunStatus::AwaitingTool,
            "reading scoped server overview",
            None,
        )
        .await?;
    let observation = read_server_overview(&services.agent_tools, run.id, request.server_id).await;
    let observation = match observation {
        Ok(value) => value,
        Err(error) => {
            let _ = repository
                .transition(
                    run.id,
                    AgentRunStatus::Failed,
                    "read-only tool failed",
                    None,
                )
                .await;
            return Err(error);
        }
    };
    let adapter = RemoteLinuxAdapter::new(RemoteExecutor::new(services.connection_manager.clone()));
    let (os, metrics, ports, system_services) = tokio::join!(
        adapter.probe(&request.connection),
        adapter.metrics(&request.connection),
        adapter.ports(&request.connection),
        adapter.services(&request.connection),
    );
    let mut unavailable = Vec::new();
    if os.is_err() {
        unavailable.push("os");
    }
    if metrics.is_err() {
        unavailable.push("metrics");
    }
    if ports.is_err() {
        unavailable.push("ports");
    }
    if system_services.is_err() {
        unavailable.push("services");
    }
    let observation = serde_json::json!({
        "server": observation,
        "os": os.ok(),
        "metrics": metrics.ok(),
        "ports": ports.ok().map(|items| items.into_iter().take(100).collect::<Vec<_>>()),
        "services": system_services.ok().map(|items| items.into_iter().take(100).collect::<Vec<_>>()),
        "unavailable": unavailable,
    });
    let context = AgentContextBuilder::new(Redactor::default()).build(observation)?;
    services.audit_writer.append(
        AuditEvent::new(
            "agent.observation",
            "server",
            "success",
            serde_json::json!({ "runId": run.id, "sources": ["server", "os", "metrics", "ports", "services"], "unavailable": unavailable }),
        ).with_server_id(request.server_id.to_string()),
    ).await?;
    let _ = app.emit(
        "agent:tool_result",
        serde_json::json!({
            "runId": run.id,
            "sequence": 2,
            "toolName": "server.overview",
            "result": context.value,
            "truncated": context.truncated,
        }),
    );
    repository
        .transition(
            run.id,
            AgentRunStatus::Summarizing,
            "model request started",
            None,
        )
        .await?;
    let payload = serde_json::json!({
        "runId": run.id,
        "input": request.input,
        "observations": [{ "toolName": "server.overview", "result": context.value, "truncated": context.truncated }],
        "catalog": services.agent_tools.catalog(),
        "profile": {
            "baseUrl": profile.base_url,
            "model": profile.model,
            "timeoutMs": profile.timeout_ms,
        },
        "apiKey": secret.as_ref().map(|value| value.expose()),
    });
    let unavailable_reason = services.agent_unavailable_reason.lock().await.clone();
    let result = {
        let sidecar = services.agent_sidecar.lock().await;
        let sidecar = sidecar.as_ref().ok_or_else(|| {
            CoreError::new(
                CoreErrorCode::SidecarUnavailable,
                unavailable_reason.unwrap_or_else(|| "Agent Sidecar is unavailable".to_owned()),
                true,
            )
        })?;
        sidecar.request("run.start", payload).await
    };
    drop(secret);
    match result {
        Ok(value) => {
            let summary = value
                .get("summary")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| {
                    CoreError::new(
                        CoreErrorCode::SidecarUnavailable,
                        "Agent response has no summary",
                        true,
                    )
                })?;
            let requested: Vec<RequestedToolCall> = match serde_json::from_value(
                value
                    .get("toolCalls")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!([])),
            ) {
                Ok(requested) => requested,
                Err(_) => {
                    let error = CoreError::new(
                        CoreErrorCode::SidecarUnavailable,
                        "Agent response contains invalid tool requests",
                        false,
                    );
                    let _ = repository
                        .transition(
                            run.id,
                            AgentRunStatus::Failed,
                            "invalid Agent tool request",
                            None,
                        )
                        .await;
                    return Err(error);
                }
            };
            for requested in requested {
                let tool_call_id = Id::new();
                let tool_name = requested.name.clone();
                let prepared = match services
                    .agent_tools
                    .request(
                        &AgentRunScope {
                            run_id: run.id,
                            server_id: request.server_id,
                            project_id: None,
                        },
                        ToolCall {
                            tool_call_id,
                            run_id: run.id,
                            server_id: request.server_id,
                            name: requested.name,
                            schema_version: 1,
                            args: requested.args,
                        },
                    )
                    .await
                {
                    Ok(prepared) => prepared,
                    Err(error) => {
                        let _ = repository
                            .transition(
                                run.id,
                                AgentRunStatus::Failed,
                                "Agent tool request failed validation",
                                None,
                            )
                            .await;
                        return Err(error);
                    }
                };
                match prepared {
                    PrepareResult::ReadCompleted { result, .. } => {
                        let context = AgentContextBuilder::new(Redactor::default())
                            .build(result.value().clone())?;
                        let _ = app.emit(
                            "agent:tool_result",
                            serde_json::json!({
                                "runId": run.id, "toolCallId": tool_call_id,
                                "toolName": tool_name, "result": context.value,
                                "truncated": context.truncated,
                            }),
                        );
                    }
                    PrepareResult::AwaitingApproval(approval) => {
                        let waiting = repository
                            .transition(
                                run.id,
                                AgentRunStatus::AwaitingApproval,
                                "Agent write request is awaiting user approval",
                                Some(summary),
                            )
                            .await?;
                        let _ = app.emit("agent:approval_required", &approval);
                        let _ = app.emit("agent:run_state", &waiting);
                        return Ok(waiting);
                    }
                    PrepareResult::Blocked { risk, .. } => {
                        let _ = app.emit(
                            "agent:tool_blocked",
                            serde_json::json!({
                                "runId": run.id, "toolCallId": tool_call_id, "risk": risk,
                            }),
                        );
                    }
                }
            }
            let completed = repository
                .transition(
                    run.id,
                    AgentRunStatus::Succeeded,
                    "model response completed",
                    Some(summary),
                )
                .await?;
            let _ = app.emit("agent:run_state", &completed);
            Ok(completed)
        }
        Err(error) => {
            let _ = repository
                .transition(run.id, AgentRunStatus::Failed, "model request failed", None)
                .await;
            Err(error)
        }
    }
}

async fn read_server_overview(
    tools: &ToolRegistry,
    run_id: Id,
    server_id: Id,
) -> Result<Value, CoreError> {
    let result = tools
        .request(
            &AgentRunScope {
                run_id,
                server_id,
                project_id: None,
            },
            ToolCall {
                tool_call_id: Id::new(),
                run_id,
                server_id,
                name: "server.overview".to_owned(),
                schema_version: 1,
                args: serde_json::json!({}),
            },
        )
        .await?;
    match result {
        PrepareResult::ReadCompleted { result, .. } => Ok(result.value().clone()),
        _ => Err(CoreError::new(
            CoreErrorCode::Internal,
            "read-only Agent tool unexpectedly requested approval",
            false,
        )),
    }
}

#[tauri::command]
pub(crate) async fn agent_run_status(
    services: State<'_, CoreServices>,
    run_id: Id,
) -> Result<AgentRunSummary, CoreError> {
    AgentRepository::new(services.database.clone())
        .get_run(run_id)
        .await
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use opspilot_agent_bridge::ToolRegistry;
    use opspilot_domain::{AuthType, Id, ServerEnvironment, ServerInput};
    use opspilot_persistence::{Database, ServerRepository};

    use super::read_server_overview;

    #[tokio::test]
    async fn agent_observation_runs_through_the_scoped_rust_tool_registry() {
        let database = Database::open(":memory:").await.unwrap();
        let server = ServerRepository::new(database.clone())
            .create(
                ServerInput::try_new(
                    "Production",
                    "prod.example.com",
                    22,
                    "deploy",
                    ServerEnvironment::Production,
                    AuthType::SshAgent,
                    None,
                    vec![],
                )
                .unwrap(),
            )
            .await
            .unwrap();
        let registry = ToolRegistry::new(
            Arc::new(crate::commands::operation::operation_gateway(database).unwrap()),
            crate::commands::operation::agent_tool_descriptors(),
        )
        .unwrap();

        let observation = read_server_overview(&registry, Id::new(), server.id)
            .await
            .unwrap();
        assert_eq!(observation["name"], "Production");
        assert_eq!(observation["host"], "prod.example.com");
        assert!(observation.get("password").is_none());
    }
}
