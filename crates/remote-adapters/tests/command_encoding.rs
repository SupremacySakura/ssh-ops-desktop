use opspilot_domain::CoreErrorCode;
use opspilot_remote_adapters::RemoteCommand;

#[test]
fn quotes_each_argument_without_interpolation() {
    let command = RemoteCommand::try_new("systemctl")
        .unwrap()
        .arg("status")
        .unwrap()
        .arg("name; echo pwned")
        .unwrap();
    assert_eq!(
        command.render_posix(),
        "'systemctl' 'status' 'name; echo pwned'"
    );
}

#[test]
fn quotes_single_quotes_and_rejects_nul_or_parent_programs() {
    assert_eq!(
        RemoteCommand::try_new("printf")
            .unwrap()
            .arg("a'b")
            .unwrap()
            .render_posix(),
        "'printf' 'a'\"'\"'b'"
    );
    let error = RemoteCommand::try_new("../bin/sh").unwrap_err();
    assert_eq!(error.code(), CoreErrorCode::Validation);
    assert!(
        RemoteCommand::try_new("printf")
            .unwrap()
            .arg("a\0b")
            .is_err()
    );
}

#[test]
fn cwd_timeout_and_stdin_are_bounded_structured_fields() {
    let command = RemoteCommand::try_new("/usr/bin/env")
        .unwrap()
        .cwd("/srv/app")
        .unwrap()
        .timeout_ms(30_000)
        .unwrap()
        .stdin(vec![1, 2, 3])
        .unwrap();
    assert_eq!(command.timeout().as_millis(), 30_000);
    assert_eq!(command.render_posix(), "cd -- '/srv/app' && '/usr/bin/env'");
    assert!(
        RemoteCommand::try_new("true")
            .unwrap()
            .stdin(vec![0; 1024 * 1024 + 1])
            .is_err()
    );
}
