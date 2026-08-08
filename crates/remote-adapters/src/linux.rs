use std::collections::HashMap;

use chrono::{SecondsFormat, Utc};
use opspilot_domain::{CoreError, CoreErrorCode};
use opspilot_secrets::SecretStore;
use opspilot_ssh_core::ConnectionHandle;
use serde::{Deserialize, Serialize};

use crate::{RemoteCommand, RemoteExecutor};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ServiceManager {
    Systemd,
    Unsupported,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OsRelease {
    pub id: String,
    pub version_id: String,
    pub pretty_name: String,
    pub service_manager: ServiceManager,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryMetric {
    pub total_bytes: u64,
    pub available_bytes: u64,
    pub used_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoadMetric {
    pub one: f64,
    pub five: f64,
    pub fifteen: f64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiskMetric {
    pub filesystem: String,
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub available_bytes: u64,
    pub mount_point: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinuxMetrics {
    pub timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory: Option<MemoryMetric>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub load: Option<LoadMetric>,
    pub disks: Vec<DiskMetric>,
    pub unavailable: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListeningPort {
    pub protocol: String,
    pub address: String,
    pub port: u16,
    pub process: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SystemService {
    pub unit: String,
    pub load_state: String,
    pub active_state: String,
    pub sub_state: String,
    pub description: String,
}

#[derive(Clone)]
pub struct RemoteLinuxAdapter<S> {
    executor: RemoteExecutor<S>,
}

impl<S> RemoteLinuxAdapter<S>
where
    S: SecretStore + 'static,
{
    pub fn new(executor: RemoteExecutor<S>) -> Self {
        Self { executor }
    }

    pub async fn probe(&self, connection: &ConnectionHandle) -> Result<OsRelease, CoreError> {
        let release = self
            .run(
                connection,
                RemoteCommand::try_new("cat")?.arg("/etc/os-release")?,
            )
            .await?;
        let systemctl = self
            .executor
            .execute(
                connection,
                RemoteCommand::try_new("systemctl")?.arg("--version")?,
            )
            .await?;
        LinuxParsers::os_release(&release, systemctl.exit_status == 0)
    }

    pub async fn metrics(&self, connection: &ConnectionHandle) -> Result<LinuxMetrics, CoreError> {
        let meminfo = self
            .run(
                connection,
                RemoteCommand::try_new("cat")?.arg("/proc/meminfo")?,
            )
            .await?;
        let loadavg = self
            .run(
                connection,
                RemoteCommand::try_new("cat")?.arg("/proc/loadavg")?,
            )
            .await?;
        let disk = self
            .run(connection, RemoteCommand::try_new("df")?.arg("-Pk")?)
            .await?;
        Ok(LinuxParsers::metrics(&meminfo, &loadavg, &disk))
    }

    pub async fn ports(
        &self,
        connection: &ConnectionHandle,
    ) -> Result<Vec<ListeningPort>, CoreError> {
        for command in [
            RemoteCommand::try_new("ss")?.arg("-H")?.arg("-lntup")?,
            RemoteCommand::try_new("ss")?.arg("-lntup")?,
            RemoteCommand::try_new("netstat")?.arg("-lntup")?,
        ] {
            let output = self.executor.execute(connection, command).await?;
            if output.exit_status == 0 {
                return LinuxParsers::listening_ports(&utf8(output.stdout, "socket list")?);
            }
        }
        Err(CoreError::new(
            CoreErrorCode::CapabilityUnavailable,
            "neither ss nor netstat can list listening ports",
            false,
        ))
    }

    pub async fn services(
        &self,
        connection: &ConnectionHandle,
    ) -> Result<Vec<SystemService>, CoreError> {
        let command = RemoteCommand::try_new("systemctl")?
            .arg("list-units")?
            .arg("--type=service")?
            .arg("--all")?
            .arg("--no-pager")?
            .arg("--no-legend")?;
        let source = self.run(connection, command).await?;
        LinuxParsers::services(&source)
    }

    async fn run(
        &self,
        connection: &ConnectionHandle,
        command: RemoteCommand,
    ) -> Result<String, CoreError> {
        let output = self.executor.execute(connection, command).await?;
        if output.exit_status != 0 {
            return Err(CoreError::new(
                CoreErrorCode::RemoteCommand,
                format!("remote command exited with status {}", output.exit_status),
                false,
            ));
        }
        utf8(output.stdout, "remote command output")
    }
}

pub struct LinuxParsers;

impl LinuxParsers {
    pub fn os_release(source: &str, systemctl_available: bool) -> Result<OsRelease, CoreError> {
        let fields = source
            .lines()
            .filter_map(|line| line.split_once('='))
            .map(|(key, value)| (key.trim(), unquote(value.trim())))
            .collect::<HashMap<_, _>>();
        let required = |key: &str| {
            fields
                .get(key)
                .filter(|value| !value.is_empty())
                .cloned()
                .ok_or_else(|| parse_error("os-release is missing a required field"))
        };
        Ok(OsRelease {
            id: required("ID")?.to_lowercase(),
            version_id: required("VERSION_ID")?,
            pretty_name: required("PRETTY_NAME")?,
            service_manager: if systemctl_available {
                ServiceManager::Systemd
            } else {
                ServiceManager::Unsupported
            },
        })
    }

    pub fn metrics(meminfo: &str, loadavg: &str, disk: &str) -> LinuxMetrics {
        let mut unavailable = Vec::new();
        let memory_fields = meminfo
            .lines()
            .filter_map(|line| line.split_once(':'))
            .filter_map(|(key, value)| {
                value
                    .split_whitespace()
                    .next()
                    .and_then(|number| number.parse::<u64>().ok())
                    .map(|number| (key, number * 1024))
            })
            .collect::<HashMap<_, _>>();
        let memory = match (
            memory_fields.get("MemTotal"),
            memory_fields.get("MemAvailable"),
        ) {
            (Some(total), Some(available)) if available <= total => Some(MemoryMetric {
                total_bytes: *total,
                available_bytes: *available,
                used_bytes: total - available,
            }),
            _ => {
                unavailable.push("memory".to_owned());
                None
            }
        };
        let load_values = loadavg
            .split_whitespace()
            .take(3)
            .map(str::parse::<f64>)
            .collect::<Result<Vec<_>, _>>();
        let load = match load_values {
            Ok(values) if values.len() == 3 => Some(LoadMetric {
                one: values[0],
                five: values[1],
                fifteen: values[2],
            }),
            _ => {
                unavailable.push("load".to_owned());
                None
            }
        };
        let mut disks = Vec::new();
        for (index, line) in disk.lines().enumerate() {
            if index == 0 || line.trim().is_empty() {
                continue;
            }
            let fields = line.split_whitespace().collect::<Vec<_>>();
            let values = fields.get(1..4).and_then(|values| {
                values
                    .iter()
                    .map(|value| value.parse::<u64>())
                    .collect::<Result<Vec<_>, _>>()
                    .ok()
            });
            match (fields.first(), fields.get(5), values) {
                (Some(filesystem), Some(mount_point), Some(values)) if values.len() == 3 => {
                    disks.push(DiskMetric {
                        filesystem: (*filesystem).to_owned(),
                        total_bytes: values[0] * 1024,
                        used_bytes: values[1] * 1024,
                        available_bytes: values[2] * 1024,
                        mount_point: (*mount_point).to_owned(),
                    });
                }
                _ => unavailable.push(format!("disk_line_{index}")),
            }
        }
        LinuxMetrics {
            timestamp: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            memory,
            load,
            disks,
            unavailable,
        }
    }

    pub fn listening_ports(source: &str) -> Result<Vec<ListeningPort>, CoreError> {
        let mut ports = Vec::new();
        for line in source.lines() {
            let fields = line.split_whitespace().collect::<Vec<_>>();
            if fields.is_empty()
                || fields[0].eq_ignore_ascii_case("state")
                || fields[0].eq_ignore_ascii_case("netid")
            {
                continue;
            }
            let has_protocol = matches!(fields[0], "tcp" | "udp" | "tcp6" | "udp6");
            let (protocol, local_index, process_index) = if has_protocol {
                (fields[0].trim_end_matches('6').to_owned(), 4, 6)
            } else {
                ("tcp".to_owned(), 3, 5)
            };
            let local = fields
                .get(local_index)
                .ok_or_else(|| parse_error("socket row is missing a local address"))?;
            let (address, port) = split_address(local)?;
            ports.push(ListeningPort {
                protocol,
                address,
                port,
                process: fields
                    .get(process_index..)
                    .filter(|values| !values.is_empty())
                    .map(|values| values.join(" ")),
            });
        }
        Ok(ports)
    }

    pub fn services(source: &str) -> Result<Vec<SystemService>, CoreError> {
        source
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| {
                let mut fields = line.split_whitespace();
                let unit = fields
                    .next()
                    .ok_or_else(|| parse_error("service row is missing unit"))?;
                let load_state = fields
                    .next()
                    .ok_or_else(|| parse_error("service row is missing load state"))?;
                let active_state = fields
                    .next()
                    .ok_or_else(|| parse_error("service row is missing active state"))?;
                let sub_state = fields
                    .next()
                    .ok_or_else(|| parse_error("service row is missing sub state"))?;
                let description = fields.collect::<Vec<_>>().join(" ");
                if !unit.ends_with(".service") || description.is_empty() {
                    return Err(parse_error("service row is invalid"));
                }
                Ok(SystemService {
                    unit: unit.to_owned(),
                    load_state: load_state.to_owned(),
                    active_state: active_state.to_owned(),
                    sub_state: sub_state.to_owned(),
                    description,
                })
            })
            .collect()
    }
}

fn utf8(bytes: Vec<u8>, label: &str) -> Result<String, CoreError> {
    String::from_utf8(bytes).map_err(|_| parse_error(&format!("{label} is not UTF-8")))
}

fn split_address(value: &str) -> Result<(String, u16), CoreError> {
    let (address, port) = value
        .rsplit_once(':')
        .ok_or_else(|| parse_error("socket address is invalid"))?;
    let port = port
        .parse::<u16>()
        .ok()
        .filter(|port| *port > 0)
        .ok_or_else(|| parse_error("socket port is invalid"))?;
    Ok((address.trim_matches(['[', ']']).to_owned(), port))
}

fn unquote(value: &str) -> String {
    value
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .unwrap_or(value)
        .replace("\\\"", "\"")
}

fn parse_error(message: &str) -> CoreError {
    CoreError::new(CoreErrorCode::RemoteParse, message, false)
}
