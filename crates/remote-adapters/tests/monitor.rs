use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};

use async_trait::async_trait;
use opspilot_domain::{CoreError, CoreErrorCode, Id};
use opspilot_remote_adapters::{
    CpuSampleStore, DiskMetric, LoadMetric, MemoryMetric, MonitorSnapshot, MonitorUnavailable,
    ProcessMetric, RemoteCommand, RemoteCommandRunner, SystemMonitor, cpu_usage_percent,
    parse_load_metric, parse_memory_metric, parse_proc_stat, parse_processes, parse_root_disk,
    parse_uptime_seconds, select_top_processes,
};
use opspilot_ssh_core::{ConnectionHandle, ExecOutput};

#[test]
fn first_cpu_sample_has_no_usage_and_the_next_uses_delta_idle_including_iowait() {
    let first =
        parse_proc_stat("cpu  100 20 50 800 30 0 0 0 0 0\ncpu0 50 10 25 400 15 0 0 0 0 0\n")
            .unwrap();
    assert_eq!(cpu_usage_percent(None, first), None);

    let second =
        parse_proc_stat("cpu  200 20 100 980 50 20 10 20 0 0\ncpu0 100 10 50 490 25 10 5 10 0 0\n")
            .unwrap();
    assert_eq!(cpu_usage_percent(Some(first), second), Some(50.0));
}

#[test]
fn cpu_usage_rejects_zero_delta_counter_rollback_and_short_rows() {
    let sample = parse_proc_stat("cpu  10 10 10 70 0 0 0 0\n").unwrap();
    assert_eq!(cpu_usage_percent(Some(sample), sample), None);

    let rolled_back = parse_proc_stat("cpu  9 10 10 70 0 0 0 0\n").unwrap();
    assert_eq!(cpu_usage_percent(Some(sample), rolled_back), None);
    assert!(parse_proc_stat("cpu  1 2 3\n").is_err());
}

#[test]
fn parses_memory_load_uptime_and_only_the_root_filesystem() {
    let memory =
        parse_memory_metric("MemTotal:       1000 kB\nMemAvailable:    250 kB\nBuffers: 10 kB\n")
            .unwrap();
    assert_eq!(memory.total_bytes, 1000 * 1024);
    assert_eq!(memory.available_bytes, 250 * 1024);
    assert_eq!(memory.used_bytes, 750 * 1024);

    let load = parse_load_metric("0.25 0.50 0.75 1/10 42\n").unwrap();
    assert_eq!(load.one, 0.25);
    assert_eq!(parse_uptime_seconds("12345.67 456.78\n").unwrap(), 12_345);

    let disk = parse_root_disk(
        "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda1 1000 400 600 40% /\n/dev/vdb1 9000 8000 1000 89% /data\n",
    )
    .unwrap();
    assert_eq!(disk.mount_point, "/");
    assert_eq!(disk.total_bytes, 1000 * 1024);
    assert_eq!(disk.used_bytes, 400 * 1024);
    assert_eq!(disk.available_bytes, 600 * 1024);
}

#[test]
fn metric_parsers_reject_incomplete_or_invalid_sections() {
    assert!(parse_memory_metric("MemTotal: nope kB\n").is_err());
    assert!(parse_load_metric("0.2 NaN 0.4\n").is_err());
    assert!(parse_uptime_seconds("-1 0\n").is_err());
    assert!(parse_root_disk(
        "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda1 1 1 1 100% /data\n",
    )
    .is_err());
}

#[test]
fn process_parsing_skips_bad_rows_and_preserves_names_with_spaces() {
    let parsed = parse_processes(
        " 42 root 125.5 3.25 nginx worker\nnot-a-process\n 43 deploy 0 1.5 postgres\n",
    );
    assert_eq!(parsed.invalid_rows, 1);
    assert_eq!(parsed.processes.len(), 2);
    assert_eq!(parsed.processes[0].pid, 42);
    assert_eq!(parsed.processes[0].name, "nginx worker");
    assert_eq!(parsed.processes[0].cpu_percent, 125.5);
    assert_eq!(parsed.processes[0].memory_percent, 3.25);
}

#[test]
fn top_processes_are_the_stable_union_of_cpu_and_memory_top_ten() {
    let processes = (1..=12)
        .map(|pid| ProcessMetric {
            pid,
            user: "deploy".to_owned(),
            name: format!("process-{pid}"),
            cpu_percent: f64::from(13 - pid),
            memory_percent: f64::from(pid),
        })
        .collect::<Vec<_>>();

    let selected = select_top_processes(&processes);
    assert_eq!(selected.len(), 12);
    assert_eq!(
        select_top_processes(&processes)
            .into_iter()
            .filter(|process| process.cpu_percent >= 3.0)
            .count(),
        10
    );
    assert!(selected.iter().any(|process| process.pid == 1));
    assert!(selected.iter().any(|process| process.pid == 12));
}

#[test]
fn monitor_snapshot_matches_the_frontend_camel_case_contract() {
    let snapshot = MonitorSnapshot {
        timestamp: "2026-11-17T12:34:56.789Z".to_owned(),
        cpu_percent: Some(42.5),
        memory: Some(MemoryMetric {
            total_bytes: 8_000,
            available_bytes: 3_000,
            used_bytes: 5_000,
        }),
        disk: Some(DiskMetric {
            filesystem: "/dev/vda1".to_owned(),
            total_bytes: 100_000,
            used_bytes: 40_000,
            available_bytes: 60_000,
            mount_point: "/".to_owned(),
        }),
        load: Some(LoadMetric {
            one: 0.25,
            five: 0.5,
            fifteen: 0.75,
        }),
        uptime_seconds: Some(123_456),
        top_processes: vec![ProcessMetric {
            pid: 42,
            user: "deploy".to_owned(),
            name: "nginx worker".to_owned(),
            cpu_percent: 125.5,
            memory_percent: 3.25,
        }],
        unavailable: vec![
            MonitorUnavailable::CpuWarmingUp,
            MonitorUnavailable::ProcessesPartial,
        ],
    };

    let value = serde_json::to_value(&snapshot).unwrap();
    assert_eq!(value["timestamp"], "2026-11-17T12:34:56.789Z");
    assert_eq!(value["cpuPercent"], 42.5);
    assert_eq!(value["memory"]["totalBytes"], 8_000);
    assert_eq!(value["memory"]["usedBytes"], 5_000);
    assert_eq!(value["disk"]["mountPoint"], "/");
    assert_eq!(value["load"]["fifteen"], 0.75);
    assert_eq!(value["uptimeSeconds"], 123_456);
    assert_eq!(value["topProcesses"][0]["cpuPercent"], 125.5);
    assert_eq!(value["topProcesses"][0]["memoryPercent"], 3.25);
    assert_eq!(
        value["unavailable"],
        serde_json::json!(["cpu_warming_up", "processes_partial"])
    );

    let mut first_sample = serde_json::to_value(MonitorSnapshot {
        cpu_percent: None,
        ..snapshot
    })
    .unwrap();
    assert!(first_sample.get("cpuPercent").is_none());
    first_sample["unknown"] = serde_json::json!(true);
    assert!(serde_json::from_value::<MonitorSnapshot>(first_sample).is_err());
}

#[derive(Clone)]
struct MonitorRunner {
    stat_samples: Arc<Mutex<VecDeque<&'static str>>>,
    commands: Arc<Mutex<Vec<String>>>,
}

#[async_trait]
impl RemoteCommandRunner for MonitorRunner {
    async fn run(
        &self,
        _connection: &ConnectionHandle,
        command: RemoteCommand,
    ) -> Result<ExecOutput, CoreError> {
        let rendered = command.render_posix();
        self.commands.lock().unwrap().push(rendered.clone());
        let stdout = match rendered.as_str() {
            value if value.contains("/proc/stat") => self
                .stat_samples
                .lock()
                .unwrap()
                .pop_front()
                .expect("missing stat fixture")
                .to_owned(),
            value if value.contains("/proc/meminfo") => {
                "MemTotal: 1000 kB\nMemAvailable: 250 kB\n".to_owned()
            }
            value if value.contains("/proc/loadavg") => "0.25 0.50 0.75 1/10 42\n".to_owned(),
            value if value.contains("/proc/uptime") => "12345.67 456.78\n".to_owned(),
            value if value.contains("'df'") => {
                "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda1 1000 400 600 40% /\n"
                    .to_owned()
            }
            value if value.contains("'ps'") => {
                "42 root 5.5 2.5 nginx worker\n43 deploy 1.0 3.5 postgres\n".to_owned()
            }
            other => panic!("unexpected monitor command: {other}"),
        };
        Ok(ExecOutput {
            stdout: stdout.into_bytes(),
            stderr: Vec::new(),
            exit_status: 0,
        })
    }
}

#[tokio::test]
async fn snapshots_keep_the_previous_cpu_sample_on_the_shared_monitor_state() {
    let runner = MonitorRunner {
        stat_samples: Arc::new(Mutex::new(VecDeque::from([
            "cpu  100 20 50 800 30 0 0 0 0 0\n",
            "cpu  200 20 100 980 50 20 10 20 0 0\n",
        ]))),
        commands: Arc::new(Mutex::new(Vec::new())),
    };
    let monitor = SystemMonitor::new(runner.clone(), CpuSampleStore::default());
    let connection = ConnectionHandle::new(Id::new(), Id::new());

    let first = monitor.snapshot(&connection).await.unwrap();
    assert_eq!(first.cpu_percent, None);
    assert!(
        first
            .unavailable
            .contains(&MonitorUnavailable::CpuWarmingUp)
    );

    let second = monitor.snapshot(&connection).await.unwrap();
    assert_eq!(second.cpu_percent, Some(50.0));
    assert!(
        !second
            .unavailable
            .contains(&MonitorUnavailable::CpuWarmingUp)
    );
    assert_eq!(second.memory.unwrap().used_bytes, 750 * 1024);
    assert_eq!(second.disk.unwrap().mount_point, "/");
    assert_eq!(second.load.unwrap().one, 0.25);
    assert_eq!(second.uptime_seconds, Some(12_345));
    assert_eq!(second.top_processes.len(), 2);

    let commands = runner.commands.lock().unwrap().clone();
    assert!(commands.iter().any(|command| command == "'df' '-Pk' '/'"));
    assert!(
        commands
            .iter()
            .any(|command| { command == "'ps' '-eo' 'pid=,user=,pcpu=,pmem=,comm='" })
    );
}

#[tokio::test]
async fn failed_cpu_reads_clear_the_previous_sample_before_the_next_request() {
    let runner = MonitorRunner {
        stat_samples: Arc::new(Mutex::new(VecDeque::from([
            "cpu  20 0 0 80 0 0 0 0\n",
            "cpu invalid\n",
            "cpu  100 0 0 100 0 0 0 0\n",
        ]))),
        commands: Arc::new(Mutex::new(Vec::new())),
    };
    let monitor = SystemMonitor::new(runner, CpuSampleStore::default());
    let connection = ConnectionHandle::new(Id::new(), Id::new());

    let first = monitor.snapshot(&connection).await.unwrap();
    assert_eq!(first.cpu_percent, None);
    assert!(
        first
            .unavailable
            .contains(&MonitorUnavailable::CpuWarmingUp)
    );

    let failed = monitor.snapshot(&connection).await.unwrap();
    assert_eq!(failed.cpu_percent, None);
    assert!(failed.unavailable.contains(&MonitorUnavailable::Cpu));

    let recovered = monitor.snapshot(&connection).await.unwrap();
    assert_eq!(recovered.cpu_percent, None);
    assert!(
        recovered
            .unavailable
            .contains(&MonitorUnavailable::CpuWarmingUp)
    );
}

#[tokio::test]
async fn cpu_samples_are_isolated_by_connection_id() {
    let runner = MonitorRunner {
        stat_samples: Arc::new(Mutex::new(VecDeque::from([
            "cpu  20 0 0 80 0 0 0 0\n",
            "cpu  500 0 0 500 0 0 0 0\n",
            "cpu  100 0 0 100 0 0 0 0\n",
            "cpu  500 0 0 700 0 0 0 0\n",
        ]))),
        commands: Arc::new(Mutex::new(Vec::new())),
    };
    let monitor = SystemMonitor::new(runner, CpuSampleStore::default());
    let first_connection = ConnectionHandle::new(Id::new(), Id::new());
    let second_connection = ConnectionHandle::new(Id::new(), Id::new());

    assert_eq!(
        monitor
            .snapshot(&first_connection)
            .await
            .unwrap()
            .cpu_percent,
        None
    );
    assert_eq!(
        monitor
            .snapshot(&second_connection)
            .await
            .unwrap()
            .cpu_percent,
        None
    );
    assert_eq!(
        monitor
            .snapshot(&first_connection)
            .await
            .unwrap()
            .cpu_percent,
        Some(80.0)
    );
    assert_eq!(
        monitor
            .snapshot(&second_connection)
            .await
            .unwrap()
            .cpu_percent,
        Some(0.0)
    );
}

#[derive(Clone)]
struct PartialFailureRunner;

#[async_trait]
impl RemoteCommandRunner for PartialFailureRunner {
    async fn run(
        &self,
        _connection: &ConnectionHandle,
        command: RemoteCommand,
    ) -> Result<ExecOutput, CoreError> {
        let rendered = command.render_posix();
        if rendered.contains("/proc/meminfo") {
            return Err(CoreError::new(
                CoreErrorCode::RemotePermission,
                "fixture permission denied",
                false,
            ));
        }
        let (stdout, exit_status) = if rendered.contains("/proc/stat") {
            ("cpu  1 1 1 7 0 0 0 0\n".to_owned(), 0)
        } else if rendered.contains("/proc/loadavg") {
            ("0.25 0.50 0.75 1/10 42\n".to_owned(), 0)
        } else if rendered.contains("/proc/uptime") {
            ("12345.67 456.78\n".to_owned(), 0)
        } else if rendered.contains("'df'") {
            (
                "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda1 1000 400 600 40% /\n"
                    .to_owned(),
                0,
            )
        } else if rendered.contains("'ps'") {
            ("42 root 5.5 2.5 nginx worker\nbad-row\n".to_owned(), 0)
        } else {
            panic!("unexpected command: {rendered}");
        };
        Ok(ExecOutput {
            stdout: stdout.into_bytes(),
            stderr: Vec::new(),
            exit_status,
        })
    }
}

#[tokio::test]
async fn a_failed_section_is_unavailable_while_the_rest_of_the_snapshot_survives() {
    let monitor = SystemMonitor::new(PartialFailureRunner, CpuSampleStore::default());
    let connection = ConnectionHandle::new(Id::new(), Id::new());

    let snapshot = monitor.snapshot(&connection).await.unwrap();

    assert!(snapshot.memory.is_none());
    assert!(snapshot.disk.is_some());
    assert!(snapshot.load.is_some());
    assert_eq!(snapshot.uptime_seconds, Some(12_345));
    assert_eq!(snapshot.top_processes.len(), 1);
    assert!(snapshot.unavailable.contains(&MonitorUnavailable::Memory));
    assert!(
        snapshot
            .unavailable
            .contains(&MonitorUnavailable::ProcessesPartial)
    );
    assert!(!snapshot.unavailable.contains(&MonitorUnavailable::Disk));
}

#[derive(Clone)]
struct TransportFailureRunner;

#[async_trait]
impl RemoteCommandRunner for TransportFailureRunner {
    async fn run(
        &self,
        _connection: &ConnectionHandle,
        command: RemoteCommand,
    ) -> Result<ExecOutput, CoreError> {
        let rendered = command.render_posix();
        if rendered.contains("/proc/meminfo") {
            return Err(CoreError::new(
                CoreErrorCode::SshConnection,
                "fixture transport closed",
                true,
            ));
        }
        let stdout = if rendered.contains("/proc/stat") {
            "cpu  1 1 1 7 0 0 0 0\n"
        } else if rendered.contains("/proc/loadavg") {
            "0.25 0.50 0.75 1/10 42\n"
        } else if rendered.contains("/proc/uptime") {
            "12345.67 456.78\n"
        } else if rendered.contains("'df'") {
            "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda1 1000 400 600 40% /\n"
        } else if rendered.contains("'ps'") {
            "42 root 5.5 2.5 nginx\n"
        } else {
            panic!("unexpected command: {rendered}");
        };
        Ok(ExecOutput {
            stdout: stdout.as_bytes().to_vec(),
            stderr: Vec::new(),
            exit_status: 0,
        })
    }
}

#[tokio::test]
async fn a_lost_ssh_transport_fails_the_whole_snapshot() {
    let monitor = SystemMonitor::new(TransportFailureRunner, CpuSampleStore::default());
    let connection = ConnectionHandle::new(Id::new(), Id::new());

    let error = monitor.snapshot(&connection).await.unwrap_err();

    assert_eq!(error.code(), CoreErrorCode::SshConnection);
}

#[derive(Clone)]
struct MissingConnectionRunner;

#[async_trait]
impl RemoteCommandRunner for MissingConnectionRunner {
    async fn run(
        &self,
        _connection: &ConnectionHandle,
        _command: RemoteCommand,
    ) -> Result<ExecOutput, CoreError> {
        Err(CoreError::new(
            CoreErrorCode::NotFound,
            "fixture connection disappeared",
            false,
        ))
    }
}

#[tokio::test]
async fn a_connection_that_disappears_mid_sample_fails_the_whole_snapshot() {
    let monitor = SystemMonitor::new(MissingConnectionRunner, CpuSampleStore::default());
    let connection = ConnectionHandle::new(Id::new(), Id::new());

    let error = monitor.snapshot(&connection).await.unwrap_err();

    assert_eq!(error.code(), CoreErrorCode::NotFound);
}

#[derive(Clone)]
struct ConcurrencyRunner {
    active_stat_reads: Arc<AtomicUsize>,
    max_active_stat_reads: Arc<AtomicUsize>,
}

#[async_trait]
impl RemoteCommandRunner for ConcurrencyRunner {
    async fn run(
        &self,
        _connection: &ConnectionHandle,
        command: RemoteCommand,
    ) -> Result<ExecOutput, CoreError> {
        let rendered = command.render_posix();
        let stdout = if rendered.contains("/proc/stat") {
            let active = self.active_stat_reads.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_active_stat_reads
                .fetch_max(active, Ordering::SeqCst);
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            self.active_stat_reads.fetch_sub(1, Ordering::SeqCst);
            "cpu  1 1 1 7 0 0 0 0\n"
        } else if rendered.contains("/proc/meminfo") {
            "MemTotal: 1000 kB\nMemAvailable: 250 kB\n"
        } else if rendered.contains("/proc/loadavg") {
            "0.25 0.50 0.75 1/10 42\n"
        } else if rendered.contains("/proc/uptime") {
            "12345.67 456.78\n"
        } else if rendered.contains("'df'") {
            "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda1 1000 400 600 40% /\n"
        } else if rendered.contains("'ps'") {
            "42 root 5.5 2.5 nginx\n"
        } else {
            panic!("unexpected command: {rendered}");
        };
        Ok(ExecOutput {
            stdout: stdout.as_bytes().to_vec(),
            stderr: Vec::new(),
            exit_status: 0,
        })
    }
}

#[tokio::test]
async fn concurrent_snapshots_for_one_connection_serialize_cpu_reads() {
    let active = Arc::new(AtomicUsize::new(0));
    let maximum = Arc::new(AtomicUsize::new(0));
    let monitor = SystemMonitor::new(
        ConcurrencyRunner {
            active_stat_reads: active,
            max_active_stat_reads: maximum.clone(),
        },
        CpuSampleStore::default(),
    );
    let connection = ConnectionHandle::new(Id::new(), Id::new());

    let (first, second) =
        tokio::join!(monitor.snapshot(&connection), monitor.snapshot(&connection));
    first.unwrap();
    second.unwrap();

    assert_eq!(maximum.load(Ordering::SeqCst), 1);
}
