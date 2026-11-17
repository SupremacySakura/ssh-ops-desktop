#![forbid(unsafe_code)]

//! Safe, structured remote operation adapters.

mod command;
mod docker;
mod linux;
mod monitor;
mod systemd;

pub use command::{RemoteCommand, RemoteCommandRunner, RemoteExecutor, ValidatedProgram};
pub use docker::{
    ContainerIdentifier, DockerAction, DockerCliAdapter, DockerContainer, DockerContainerList,
    DockerLogs, DockerShell, DockerStats, DockerVersion, parse_containers, parse_started_at,
    parse_stats, parse_version,
};
pub use linux::{
    DiskMetric, LinuxMetrics, LinuxParsers, ListeningPort, LoadMetric, MemoryMetric, OsRelease,
    RemoteLinuxAdapter, ServiceManager, SystemService,
};
pub use monitor::{
    CpuSampleStore, CpuTimes, MonitorSnapshot, MonitorUnavailable, ProcessMetric, ProcessParse,
    SystemMonitor, cpu_usage_percent, parse_load_metric, parse_memory_metric, parse_proc_stat,
    parse_processes, parse_root_disk, parse_uptime_seconds, select_top_processes,
};
pub use systemd::{ServiceAction, SystemdAdapter};
