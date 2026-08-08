use opspilot_remote_adapters::{LinuxParsers, ServiceManager};

#[test]
fn parses_multiple_distributions_and_alpine_is_explicitly_unsupported_for_systemd() {
    let ubuntu = LinuxParsers::os_release(
        "ID=ubuntu\nVERSION_ID=\"24.04\"\nPRETTY_NAME=\"Ubuntu 24.04 LTS\"\n",
        true,
    )
    .unwrap();
    assert_eq!(ubuntu.id, "ubuntu");
    assert_eq!(ubuntu.service_manager, ServiceManager::Systemd);

    let rocky = LinuxParsers::os_release(
        "ID=rocky\nVERSION_ID=9.4\nPRETTY_NAME=\"Rocky Linux 9.4\"\n",
        true,
    )
    .unwrap();
    assert_eq!(rocky.id, "rocky");

    let alpine = LinuxParsers::os_release(
        "ID=alpine\nVERSION_ID=3.20\nPRETTY_NAME=\"Alpine Linux v3.20\"\n",
        false,
    )
    .unwrap();
    assert_eq!(alpine.service_manager, ServiceManager::Unsupported);
}

#[test]
fn parses_memory_load_and_disk_with_field_level_unavailability() {
    let metrics = LinuxParsers::metrics(
        "MemTotal:       1000 kB\nMemAvailable:    250 kB\n",
        "0.25 0.50 0.75 1/10 42\n",
        "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda1 1000 400 600 40% /\nmalformed\n",
    );
    assert_eq!(metrics.memory.as_ref().unwrap().used_bytes, 750 * 1024);
    assert_eq!(metrics.load.as_ref().unwrap().one, 0.25);
    assert_eq!(metrics.disks.len(), 1);
    assert!(!metrics.unavailable.is_empty());
}

#[test]
fn parses_ss_with_or_without_header_and_keeps_process_text_as_data() {
    let output = "State Recv-Q Send-Q Local Address:Port Peer Address:Port Process\nLISTEN 0 4096 127.0.0.1:22 0.0.0.0:* users:((\"sshd;safe\",pid=1,fd=3))\n";
    let ports = LinuxParsers::listening_ports(output).unwrap();
    assert_eq!(ports.len(), 1);
    assert_eq!(ports[0].port, 22);
    assert_eq!(
        ports[0].process.as_deref(),
        Some("users:((\"sshd;safe\",pid=1,fd=3))")
    );

    let no_header = "tcp LISTEN 0 128 [::]:443 [::]:* users:((\"nginx\",pid=2,fd=6))\n";
    assert_eq!(
        LinuxParsers::listening_ports(no_header).unwrap()[0].port,
        443
    );
}

#[test]
fn parses_systemd_services_without_localized_table_headers() {
    let services = LinuxParsers::services(
        "sshd.service loaded active running OpenSSH server daemon\nnginx.service loaded inactive dead A web server\n",
    ).unwrap();
    assert_eq!(services[0].unit, "sshd.service");
    assert_eq!(services[1].description, "A web server");
}
