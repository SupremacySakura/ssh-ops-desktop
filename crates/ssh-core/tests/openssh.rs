use opspilot_domain::CoreErrorCode;
use opspilot_ssh_core::{OpenSshArgs, OpenSshServer, SshConfigImporter};

#[test]
fn openssh_arguments_do_not_invoke_a_shell_or_accept_host_injection() {
    assert!(OpenSshServer::try_new("example.com;touch /tmp/pwned", 22, "deploy").is_err());
    let server = OpenSshServer::try_new("example.com", 2222, "deploy").unwrap();
    let args = OpenSshArgs::for_server(&server).unwrap();

    assert_eq!(args.program().to_string_lossy(), "ssh");
    assert_eq!(args.arguments(), ["-p", "2222", "--", "deploy@example.com"]);
    assert!(!args.arguments().iter().any(|arg| arg.contains("sh -c")));
}

#[test]
fn ssh_config_importer_expands_supported_fields_and_reports_unsupported_directives() {
    let preview = SshConfigImporter::preview(
        r#"
Host prod
  HostName prod.example.com
  User deploy
  Port 2222
  IdentityFile ~/.ssh/id_ed25519
  ProxyJump bastion
  ProxyCommand sh -c unsafe
"#,
    )
    .unwrap();
    assert_eq!(preview.len(), 1);
    assert_eq!(preview[0].alias, "prod");
    assert_eq!(preview[0].host, "prod.example.com");
    assert_eq!(preview[0].port, 2222);
    assert_eq!(preview[0].unsupported_directives, ["ProxyCommand"]);
    assert!(!preview[0].trusted_host_key);
    assert!(!preview[0].private_key_copied);
}

#[test]
fn ssh_config_rejects_wildcard_targets_and_invalid_ports() {
    let error = SshConfigImporter::preview("Host *\n  HostName example.com\n")
        .expect_err("wildcard profiles cannot become an explicit server silently");
    assert_eq!(error.code(), CoreErrorCode::Validation);
    assert!(SshConfigImporter::preview("Host bad\n  Port 70000\n").is_err());
}
