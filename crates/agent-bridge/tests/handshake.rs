use std::path::PathBuf;

use opspilot_agent_bridge::{AgentSidecar, AgentStatus, SidecarCommand};
use opspilot_domain::CoreErrorCode;

#[tokio::test]
async fn authenticates_real_child_and_correlates_requests() {
    let storage = tempfile::tempdir()
        .unwrap()
        .path()
        .join("agent-workflows.db");
    let sidecar = AgentSidecar::start(command("good-sidecar.mjs", storage))
        .await
        .unwrap();
    assert_eq!(sidecar.status(), AgentStatus::Ready);
    assert_eq!(
        sidecar
            .request("catalog.list", serde_json::json!({}))
            .await
            .unwrap(),
        serde_json::json!([])
    );
    sidecar.shutdown().await.unwrap();
}

#[tokio::test]
async fn rejects_child_that_cannot_prove_the_private_session_token() {
    let storage = tempfile::tempdir()
        .unwrap()
        .path()
        .join("agent-workflows.db");
    let error = match AgentSidecar::start(command("bad-sidecar.mjs", storage)).await {
        Ok(_) => panic!("bad proof must reject the child"),
        Err(error) => error,
    };
    assert_eq!(error.code(), CoreErrorCode::SidecarUnavailable);
}

fn command(fixture: &str, storage: PathBuf) -> SidecarCommand {
    SidecarCommand {
        program: PathBuf::from("node"),
        args: vec![
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures")
                .join(fixture)
                .to_string_lossy()
                .into_owned(),
        ],
        storage_url: storage.to_string_lossy().into_owned(),
    }
}
