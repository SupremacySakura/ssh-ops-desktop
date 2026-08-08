use opspilot_remote_adapters::{ContainerIdentifier, parse_containers, parse_stats, parse_version};

#[test]
fn parses_json_lines_without_localized_table_output() {
    let containers = parse_containers(br#"{"ID":"abc123","Names":"web","Image":"nginx:alpine","State":"running","Status":"Up 3 hours","Ports":"80/tcp"}
{"ID":"def456","Names":"worker","Image":"worker:1","State":"exited","Status":"Exited (0)","Ports":""}
"#).unwrap();
    assert_eq!(containers.len(), 2);
    assert_eq!(containers[0].names, "web");
}

#[test]
fn parses_version_and_stats_and_rejects_option_like_ids() {
    let version =
        parse_version(br#"{"Version":"27.1.1","ApiVersion":"1.46","Os":"linux","Arch":"amd64"}"#)
            .unwrap();
    assert_eq!(version.transport, "cli");
    let stats = parse_stats(br#"{"ID":"abc123","Name":"web","CPUPerc":"0.10%","MemUsage":"1MiB / 1GiB","MemPerc":"0.10%","NetIO":"1kB / 2kB","BlockIO":"0B / 0B"}"#).unwrap();
    assert_eq!(stats.name, "web");
    assert!(ContainerIdentifier::try_new("--host=tcp://evil").is_err());
}
