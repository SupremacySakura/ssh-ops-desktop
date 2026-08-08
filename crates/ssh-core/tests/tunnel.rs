use opspilot_domain::CoreErrorCode;
use opspilot_ssh_core::{RemoteSocketPath, TunnelDirection, TunnelRule};

#[tokio::test]
async fn local_tunnel_defaults_to_loopback_and_reports_bind_conflicts() {
    let rule = TunnelRule::try_new(
        TunnelDirection::Local,
        None,
        0,
        Some("127.0.0.1"),
        Some(5432),
        false,
    )
    .unwrap();
    assert_eq!(rule.bind_host(), "127.0.0.1");
    let listener = rule.bind_local().await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let conflict = TunnelRule::try_new(
        TunnelDirection::Local,
        None,
        port,
        Some("127.0.0.1"),
        Some(5432),
        false,
    )
    .unwrap()
    .bind_local()
    .await
    .expect_err("occupied local ports must return a conflict");
    assert_eq!(conflict.code(), CoreErrorCode::Conflict);
}

#[test]
fn public_bind_requires_explicit_confirmation_and_streamlocal_is_absolute() {
    assert!(
        TunnelRule::try_new(
            TunnelDirection::Local,
            Some("0.0.0.0"),
            8080,
            Some("127.0.0.1"),
            Some(80),
            false,
        )
        .is_err()
    );
    assert!(
        TunnelRule::try_new(
            TunnelDirection::Local,
            Some("0.0.0.0"),
            8080,
            Some("127.0.0.1"),
            Some(80),
            true,
        )
        .is_ok()
    );
    assert!(RemoteSocketPath::try_new("relative.sock").is_err());
    assert!(RemoteSocketPath::try_new("/run/docker.sock").is_ok());
}
