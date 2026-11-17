use std::fs;

use opspilot_domain::CoreErrorCode;
use opspilot_ssh_core::{OpenSshArgs, OpenSshServer, SshConfigImporter, read_ssh_config};

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
fn ssh_config_imports_explicit_hosts_without_failing_on_the_default_block() {
    let parsed = SshConfigImporter::parse(
        "# Personal hosts\r\n\
         Host *\r\n\
           ServerAliveInterval 30\r\n\
         Host prod staging\r\n\
           HostName \"prod.example.com\"\r\n\
           User deploy\r\n\
           Port 2222\r\n\
           IdentityFile \"~/.ssh/id_ed25519\" # never copied\r\n\
         Host dev\r\n\
           User shi\r\n",
    )
    .expect("a valid SSH config should parse");

    assert_eq!(parsed.entries.len(), 3);
    assert_eq!(parsed.entries[0].alias, "prod");
    assert_eq!(parsed.entries[0].host, "prod.example.com");
    assert_eq!(parsed.entries[0].port, 2222);
    assert_eq!(parsed.entries[0].username, "deploy");
    assert_eq!(
        parsed.entries[0].identity_file.as_deref(),
        Some("~/.ssh/id_ed25519")
    );
    assert!(parsed.entries[0].importable);
    assert_eq!(parsed.entries[1].alias, "staging");
    assert_eq!(parsed.entries[2].alias, "dev");
    assert_eq!(parsed.entries[2].host, "dev");
    assert_eq!(parsed.entries[2].port, 22);
    assert!(
        parsed
            .warnings
            .iter()
            .any(|warning| warning.message.contains("通配 Host"))
    );
}

#[test]
fn ssh_config_skips_incomplete_entries_and_keeps_valid_siblings() {
    let parsed = SshConfigImporter::parse(
        "Host missing-user\n\
           HostName missing.example.com\n\
         Host bad-port\n\
           HostName bad.example.com\n\
           User deploy\n\
           Port 70000\n\
         Host good\n\
           HostName good.example.com\n\
           User deploy\n",
    )
    .expect("one broken Host must not fail its siblings");

    assert_eq!(parsed.entries.len(), 1);
    assert_eq!(parsed.entries[0].alias, "good");
    assert!(
        parsed
            .warnings
            .iter()
            .any(|warning| warning.line == 1 && warning.message.contains("User"))
    );
    assert!(
        parsed
            .warnings
            .iter()
            .any(|warning| warning.line == 6 && warning.message.contains("端口"))
    );
}

#[test]
fn ssh_config_marks_proxy_semantics_unsupported_and_does_not_hide_match_blocks() {
    let parsed = SshConfigImporter::parse(
        "Include ~/.ssh/company/*\n\
         Host bastion\n\
           HostName bastion.example.com\n\
           User deploy\n\
           ProxyJump jump.example.com\n\
           ProxyCommand ssh -W %h:%p jump.example.com\n\
         Match host *.internal\n\
           User root\n\
         Host direct\n\
           HostName direct.example.com\n\
           User deploy\n",
    )
    .expect("unsupported directives should not fail the whole file");

    assert_eq!(parsed.entries.len(), 2);
    assert_eq!(parsed.entries[0].alias, "bastion");
    assert!(!parsed.entries[0].importable);
    assert_eq!(
        parsed.entries[0].unsupported_directives,
        ["ProxyJump", "ProxyCommand"]
    );
    assert_eq!(parsed.entries[1].alias, "direct");
    assert!(parsed.entries[1].importable);
    assert!(
        parsed
            .warnings
            .iter()
            .any(|warning| warning.line == 1 && warning.message.contains("Include"))
    );
    assert!(
        parsed
            .warnings
            .iter()
            .any(|warning| warning.line == 7 && warning.message.contains("Match"))
    );
}

#[test]
fn ssh_config_reports_each_unpersisted_directive_without_disabling_metadata_import() {
    let parsed = SshConfigImporter::parse(
        "Host prod\n\
           HostName prod.example.com\n\
           User deploy\n\
           ServerAliveInterval 30\n\
           ForwardAgent yes\n",
    )
    .expect("non-connection directives should remain visible warnings");

    assert_eq!(parsed.entries.len(), 1);
    assert!(parsed.entries[0].importable);
    assert_eq!(
        parsed.entries[0].unsupported_directives,
        ["ServerAliveInterval", "ForwardAgent"]
    );
    assert!(
        parsed.entries[0]
            .warnings
            .iter()
            .any(|warning| warning.message.contains("ServerAliveInterval"))
    );
    assert!(
        parsed.entries[0]
            .warnings
            .iter()
            .any(|warning| warning.message.contains("ForwardAgent"))
    );
}

#[test]
fn ssh_config_rejects_files_without_any_recognized_host_declaration() {
    let error = SshConfigImporter::parse("this is not an ssh config\n")
        .expect_err("a structurally invalid file must not masquerade as an empty import");

    assert!(error.message().contains("格式异常"));
}

#[test]
fn ssh_config_file_reader_is_bounded_and_returns_a_source_digest() {
    let directory = tempfile::tempdir().expect("temporary directory should open");
    let path = directory.path().join("config");
    fs::write(
        &path,
        "Host prod\n  HostName prod.example.com\n  User deploy\n",
    )
    .expect("fixture config should be written");

    let document = read_ssh_config(&path).expect("fixture config should be readable");
    let parsed = SshConfigImporter::parse(&document.source).expect("fixture config should parse");

    assert_eq!(parsed.entries.len(), 1);
    assert_eq!(document.sha256.len(), 64);
    assert!(
        document
            .sha256
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    );
}

#[test]
fn ssh_config_file_reader_returns_clear_chinese_errors() {
    let directory = tempfile::tempdir().expect("temporary directory should open");
    let missing = read_ssh_config(&directory.path().join("missing")).unwrap_err();
    assert_eq!(missing.code(), CoreErrorCode::NotFound);
    assert!(missing.message().contains("未找到 SSH Config"));

    let directory_path = directory.path().join("config-directory");
    fs::create_dir(&directory_path).expect("fixture directory should be created");
    let not_a_file = read_ssh_config(&directory_path).unwrap_err();
    assert!(not_a_file.message().contains("不是普通文件"));

    let non_utf8 = directory.path().join("non-utf8");
    fs::write(&non_utf8, [0xff, 0xfe, 0xfd]).expect("invalid UTF-8 fixture should be written");
    let invalid_text = read_ssh_config(&non_utf8).unwrap_err();
    assert_eq!(invalid_text.code(), CoreErrorCode::Validation);
    assert!(invalid_text.message().contains("UTF-8"));

    let oversized = directory.path().join("oversized");
    fs::write(&oversized, vec![b'a'; 1024 * 1024 + 1])
        .expect("oversized fixture should be written");
    let too_large = read_ssh_config(&oversized).unwrap_err();
    assert_eq!(too_large.code(), CoreErrorCode::Validation);
    assert!(too_large.message().contains("1 MiB"));
}
