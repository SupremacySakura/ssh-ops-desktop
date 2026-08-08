#![forbid(unsafe_code)]

//! Safe, structured remote operation adapters.

mod command;
mod deploy;
mod docker;
mod linux;
mod nginx;
mod project;
mod systemd;

pub use command::{RemoteCommand, RemoteCommandRunner, RemoteExecutor, ValidatedProgram};
pub use deploy::{DeploymentPlan, DeploymentResult, GitRevision, ReleaseDeployer};
pub use docker::{
    ContainerIdentifier, DockerCliAdapter, DockerContainer, DockerStats, DockerVersion,
    parse_containers, parse_stats, parse_version,
};
pub use linux::{
    DiskMetric, LinuxMetrics, LinuxParsers, ListeningPort, LoadMetric, MemoryMetric, OsRelease,
    RemoteLinuxAdapter, ServiceManager, SystemService,
};
pub use nginx::{NginxAdapter, NginxApplyPlan, NginxApplyResult, NginxPath};
pub use opspilot_domain::RuntimeType;
pub use project::{ProjectDetection, ProjectDetector};
pub use systemd::{ServiceAction, SystemdAdapter};
