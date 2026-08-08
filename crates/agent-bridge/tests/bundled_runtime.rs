use std::path::PathBuf;

use opspilot_agent_bridge::{AgentSidecar, AgentStatus, SidecarCommand};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[tokio::test]
async fn bundled_runtime_authenticates_initializes_private_storage_and_responds() {
    let root = tempfile::tempdir().unwrap();
    let storage = root.path().join("nested/agent-workflows.db");
    let runtime = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../src-tauri/resources/agent-runtime/main.mjs");
    let sidecar = AgentSidecar::start(SidecarCommand {
        program: PathBuf::from("node"),
        args: vec![runtime.to_string_lossy().into_owned()],
        storage_url: storage.to_string_lossy().into_owned(),
    })
    .await
    .unwrap();

    assert_eq!(sidecar.status(), AgentStatus::Ready);
    assert_eq!(
        sidecar
            .request("runtime.status", serde_json::json!({}))
            .await
            .unwrap(),
        serde_json::json!({ "ready": true }),
    );
    assert!(storage.is_file());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&storage).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    sidecar.shutdown().await.unwrap();
}

#[tokio::test]
async fn bundled_runtime_maps_provider_tool_calls_back_to_the_rust_catalog_name() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        for step in 0..2 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0_u8; 64 * 1024];
            let read = socket.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..read]);
            assert!(request.contains("nginx__apply"));
            assert!(request.contains("livePath"));
            let body = if step == 0 {
                serde_json::json!({
                    "id": "chatcmpl-fixture-tool",
                    "object": "chat.completion",
                    "created": 1,
                    "model": "fixture",
                    "choices": [{
                        "index": 0,
                        "finish_reason": "tool_calls",
                        "message": {
                            "role": "assistant",
                            "content": null,
                            "tool_calls": [{
                                "id": "call-fixture",
                                "type": "function",
                                "function": {
                                    "name": "nginx__apply",
                                    "arguments": "{\"livePath\":\"/etc/nginx/sites-enabled/app\"}"
                                }
                            }]
                        }
                    }],
                    "usage": { "prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14 }
                })
            } else {
                assert!(request.contains("queued_for_rust_core_review"));
                serde_json::json!({
                    "id": "chatcmpl-fixture-summary",
                    "object": "chat.completion",
                    "created": 2,
                    "model": "fixture",
                    "choices": [{
                        "index": 0,
                        "finish_reason": "stop",
                        "message": { "role": "assistant", "content": "Operation queued for review." }
                    }],
                    "usage": { "prompt_tokens": 14, "completion_tokens": 5, "total_tokens": 19 }
                })
            }
            .to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body,
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        }
    });

    let root = tempfile::tempdir().unwrap();
    let sidecar = AgentSidecar::start(runtime_command(root.path().join("agent.db")))
        .await
        .unwrap();
    let value = sidecar.request("run.start", serde_json::json!({
        "runId": "00000000-0000-4000-8000-000000000001",
        "input": "Apply the reviewed Nginx change",
        "observations": [],
        "profile": { "baseUrl": format!("http://{address}/v1"), "model": "fixture", "timeoutMs": 5000 },
        "catalog": [{
            "name": "nginx.apply", "description": "Apply Nginx config", "schemaVersion": 1,
            "inputSchema": { "type": "object", "properties": { "livePath": { "type": "string" } } }
        }]
    })).await.unwrap();

    assert_eq!(value["toolCalls"][0]["name"], "nginx.apply");
    assert_eq!(
        value["toolCalls"][0]["args"]["livePath"],
        "/etc/nginx/sites-enabled/app"
    );
    sidecar.shutdown().await.unwrap();
    server.await.unwrap();
}

fn runtime_command(storage: PathBuf) -> SidecarCommand {
    SidecarCommand {
        program: PathBuf::from("node"),
        args: vec![
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../src-tauri/resources/agent-runtime/main.mjs")
                .to_string_lossy()
                .into_owned(),
        ],
        storage_url: storage.to_string_lossy().into_owned(),
    }
}
