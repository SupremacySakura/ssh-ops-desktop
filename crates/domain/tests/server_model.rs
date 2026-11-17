use opspilot_domain::{AuthType, CoreErrorCode, Id, Server, ServerGroup, ServerInput, ServerPort};

#[test]
fn server_input_normalizes_harbor_identity_fields() {
    let group_id = Id::new();
    let input = ServerInput::try_new(
        "  prod-web-01 ",
        " PROD.Example.COM ",
        2222,
        " deploy ",
        AuthType::Key,
        Some(" secret-ref-fixture-001 "),
        Some(group_id),
        true,
    )
    .expect("valid Harbor server input should be accepted");

    assert_eq!(input.name(), "prod-web-01");
    assert_eq!(input.host().as_str(), "prod.example.com");
    assert_eq!(input.port().get(), 2222);
    assert_eq!(input.user(), "deploy");
    assert_eq!(input.auth_type(), AuthType::Key);
    assert_eq!(input.secret_ref(), Some("secret-ref-fixture-001"));
    assert_eq!(input.group_id(), Some(group_id));
    assert!(input.favorite());
}

#[test]
fn server_input_rejects_values_outside_the_v2_contract() {
    for (host, user, secret_ref) in [
        ("https://example.com", "deploy", "secret-ref-fixture-001"),
        ("example.com", "deploy user", "secret-ref-fixture-001"),
        ("example.com", "deploy", "  "),
    ] {
        let error = ServerInput::try_new(
            "server",
            host,
            22,
            user,
            AuthType::Password,
            Some(secret_ref),
            None,
            false,
        )
        .expect_err("invalid server input must fail closed");
        assert_eq!(error.code(), CoreErrorCode::Validation);
    }

    for port in [0, 65_536] {
        assert_eq!(
            ServerPort::try_from(port).unwrap_err().code(),
            CoreErrorCode::Validation
        );
    }
}

#[test]
fn imported_servers_can_explicitly_wait_for_a_credential() {
    let pending = ServerInput::try_new(
        "imported",
        "imported.example.com",
        22,
        "deploy",
        AuthType::Key,
        None,
        None,
        false,
    )
    .expect("an imported server without a credential should be valid");

    assert_eq!(pending.secret_ref(), None);

    let server = Server {
        id: Id::new(),
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
    };
    let error = server
        .require_secret_ref()
        .expect_err("an imported server must not connect before its credential is configured");

    assert_eq!(error.code(), CoreErrorCode::SecretUnavailable);
    assert!(!error.is_retryable());
    assert!(error.message().contains("凭据尚未配置"));
}

#[test]
fn group_names_are_trimmed_and_non_empty() {
    let group = ServerGroup {
        id: Id::new(),
        name: "  生产  ".to_owned(),
        sort_order: 3,
    };

    assert_eq!(group.name, "  生产  ");
    assert!(ServerGroup::try_new("  生产  ", 3).is_ok());
    assert_eq!(
        ServerGroup::try_new("   ", 0).unwrap_err().code(),
        CoreErrorCode::Validation
    );
}
