#![forbid(unsafe_code)]

//! Safe, structured remote operation adapters.

mod command;
mod docker;
mod linux;
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
pub use systemd::{ServiceAction, SystemdAdapter};
