use opspilot_domain::CoreErrorCode;
use opspilot_remote_adapters::{ServiceAction, SystemdAdapter};

#[test]
fn systemd_units_are_validated_before_command_construction() {
    let command = SystemdAdapter::action_command("nginx.service", ServiceAction::Restart).unwrap();
    assert_eq!(
        command.render_posix(),
        "'systemctl' 'restart' '--' 'nginx.service'"
    );

    for unit in [
        "nginx;reboot.service",
        "../nginx.service",
        "nginx\n.service",
        "nginx",
    ] {
        let error = SystemdAdapter::action_command(unit, ServiceAction::Restart)
            .expect_err("unsafe unit must be rejected");
        assert_eq!(error.code(), CoreErrorCode::Validation);
    }
}

#[test]
fn journal_reads_use_bounded_structured_arguments() {
    let command = SystemdAdapter::journal_command("nginx.service", 200).unwrap();
    assert_eq!(
        command.render_posix(),
        "'journalctl' '--no-pager' '--output=json' '--lines' '200' '--unit' 'nginx.service'"
    );
    assert!(SystemdAdapter::journal_command("nginx.service", 100_001).is_err());
}
