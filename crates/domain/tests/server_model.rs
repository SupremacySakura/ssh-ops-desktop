use opspilot_domain::{AuthType, CoreErrorCode, Id, ServerGroup, ServerInput, ServerPort};

#[test]
fn server_input_normalizes_harbor_identity_fields() {
    let group_id = Id::new();
    let input = ServerInput::try_new(
        "  prod-web-01 ",
        " PROD.Example.COM ",
        2222,
        " deploy ",
        AuthType::Key,
        " secret-ref-fixture-001 ",
        Some(group_id),
        true,
    )
    .expect("valid Harbor server input should be accepted");

    assert_eq!(input.name(), "prod-web-01");
    assert_eq!(input.host().as_str(), "prod.example.com");
    assert_eq!(input.port().get(), 2222);
    assert_eq!(input.user(), "deploy");
    assert_eq!(input.auth_type(), AuthType::Key);
    assert_eq!(input.secret_ref(), "secret-ref-fixture-001");
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
            secret_ref,
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
