use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};

use chrono::{SecondsFormat, Utc};
use opspilot_domain::{CoreError, CoreErrorCode, Id};
use opspilot_ssh_core::ConnectionHandle;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::{DiskMetric, LoadMetric, MemoryMetric, RemoteCommand, RemoteCommandRunner};

const TOP_PROCESS_LIMIT: usize = 10;
const DEFAULT_CPU_STATE_TTL: Duration = Duration::from_secs(15 * 60);
const DEFAULT_CPU_STATE_CAPACITY: usize = 64;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CpuTimes {
    total: u64,
    idle: u64,
}

pub fn parse_proc_stat(source: &str) -> Result<CpuTimes, CoreError> {
    let line = source
        .lines()
        .find(|line| line.split_whitespace().next() == Some("cpu"))
        .ok_or_else(|| parse_error("proc stat is missing the aggregate cpu row"))?;
    let values = line
        .split_whitespace()
        .skip(1)
        .take(8)
        .map(str::parse::<u64>)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| parse_error("proc stat contains an invalid cpu counter"))?;
    if values.len() < 4 {
        return Err(parse_error("proc stat cpu row has too few counters"));
    }
    let idle = values[3]
        .checked_add(values.get(4).copied().unwrap_or(0))
        .ok_or_else(|| parse_error("proc stat idle counter overflowed"))?;
    let total = values
        .into_iter()
        .try_fold(0_u64, u64::checked_add)
        .ok_or_else(|| parse_error("proc stat total counter overflowed"))?;
    Ok(CpuTimes { total, idle })
}

pub fn cpu_usage_percent(previous: Option<CpuTimes>, current: CpuTimes) -> Option<f64> {
    let previous = previous?;
    let total = current.total.checked_sub(previous.total)?;
    let idle = current.idle.checked_sub(previous.idle)?;
    if total == 0 || idle > total {
        return None;
    }
    Some(((total - idle) as f64 / total as f64) * 100.0)
}

pub fn parse_memory_metric(source: &str) -> Result<MemoryMetric, CoreError> {
    let mut total = None;
    let mut available = None;
    for line in source.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let Some(kilobytes) = value
            .split_whitespace()
            .next()
            .and_then(|value| value.parse::<u64>().ok())
        else {
            continue;
        };
        let bytes = kilobytes
            .checked_mul(1024)
            .ok_or_else(|| parse_error("memory counter overflowed"))?;
        match key.trim() {
            "MemTotal" => total = Some(bytes),
            "MemAvailable" => available = Some(bytes),
            _ => {}
        }
    }
    let (total_bytes, available_bytes) = total
        .zip(available)
        .filter(|(total, available)| *total > 0 && *available <= *total)
        .ok_or_else(|| parse_error("memory information is incomplete"))?;
    Ok(MemoryMetric {
        total_bytes,
        available_bytes,
        used_bytes: total_bytes - available_bytes,
    })
}

pub fn parse_load_metric(source: &str) -> Result<LoadMetric, CoreError> {
    let values = source
        .split_whitespace()
        .take(3)
        .map(str::parse::<f64>)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| parse_error("load average contains an invalid number"))?;
    if values.len() != 3
        || values
            .iter()
            .any(|value| !value.is_finite() || *value < 0.0)
    {
        return Err(parse_error("load average is incomplete or invalid"));
    }
    Ok(LoadMetric {
        one: values[0],
        five: values[1],
        fifteen: values[2],
    })
}

pub fn parse_uptime_seconds(source: &str) -> Result<u64, CoreError> {
    let seconds = source
        .split_whitespace()
        .next()
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value >= 0.0)
        .ok_or_else(|| parse_error("uptime is invalid"))?;
    if seconds > u64::MAX as f64 {
        return Err(parse_error("uptime is outside the supported range"));
    }
    Ok(seconds as u64)
}

pub fn parse_root_disk(source: &str) -> Result<DiskMetric, CoreError> {
    for line in source.lines().skip(1) {
        let fields = line.split_whitespace().collect::<Vec<_>>();
        if fields.len() < 6 || fields[5] != "/" {
            continue;
        }
        let values = fields
            .get(1..4)
            .into_iter()
            .flatten()
            .map(|value| value.parse::<u64>())
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| parse_error("root filesystem counters are invalid"))?;
        if values.len() != 3 {
            return Err(parse_error("root filesystem row is incomplete"));
        }
        return Ok(DiskMetric {
            filesystem: fields[0].to_owned(),
            total_bytes: values[0]
                .checked_mul(1024)
                .ok_or_else(|| parse_error("root filesystem total overflowed"))?,
            used_bytes: values[1]
                .checked_mul(1024)
                .ok_or_else(|| parse_error("root filesystem usage overflowed"))?,
            available_bytes: values[2]
                .checked_mul(1024)
                .ok_or_else(|| parse_error("root filesystem availability overflowed"))?,
            mount_point: "/".to_owned(),
        });
    }
    Err(parse_error("df output is missing the root filesystem"))
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessMetric {
    pub pid: u32,
    pub user: String,
    pub name: String,
    pub cpu_percent: f64,
    pub memory_percent: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProcessParse {
    pub processes: Vec<ProcessMetric>,
    pub invalid_rows: usize,
}

pub fn parse_processes(source: &str) -> ProcessParse {
    let mut processes = Vec::new();
    let mut invalid_rows = 0;
    for line in source.lines().filter(|line| !line.trim().is_empty()) {
        let fields = line.split_whitespace().collect::<Vec<_>>();
        if fields.first() == Some(&"PID") {
            continue;
        }
        let parsed = (|| {
            if fields.len() < 5 {
                return None;
            }
            let pid = fields[0].parse::<u32>().ok().filter(|pid| *pid > 0)?;
            let cpu_percent = fields[2].parse::<f64>().ok()?;
            let memory_percent = fields[3].parse::<f64>().ok()?;
            if !cpu_percent.is_finite()
                || !memory_percent.is_finite()
                || cpu_percent < 0.0
                || memory_percent < 0.0
            {
                return None;
            }
            let user = fields[1];
            let name = fields[4..].join(" ");
            if user.chars().any(char::is_control) || name.chars().any(char::is_control) {
                return None;
            }
            Some(ProcessMetric {
                pid,
                user: user.to_owned(),
                name,
                cpu_percent,
                memory_percent,
            })
        })();
        match parsed {
            Some(process) => processes.push(process),
            None => invalid_rows += 1,
        }
    }
    ProcessParse {
        processes,
        invalid_rows,
    }
}

pub fn select_top_processes(processes: &[ProcessMetric]) -> Vec<ProcessMetric> {
    let mut by_cpu = processes.to_vec();
    by_cpu.sort_by(compare_cpu);
    by_cpu.truncate(TOP_PROCESS_LIMIT);

    let mut by_memory = processes.to_vec();
    by_memory.sort_by(compare_memory);
    by_memory.truncate(TOP_PROCESS_LIMIT);

    let mut selected = Vec::with_capacity(TOP_PROCESS_LIMIT * 2);
    for process in by_cpu.into_iter().chain(by_memory) {
        if !selected
            .iter()
            .any(|existing: &ProcessMetric| existing.pid == process.pid)
        {
            selected.push(process);
        }
    }
    selected
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MonitorUnavailable {
    Cpu,
    CpuWarmingUp,
    Memory,
    Disk,
    Load,
    Uptime,
    Processes,
    ProcessesPartial,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MonitorSnapshot {
    pub timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory: Option<MemoryMetric>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disk: Option<DiskMetric>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub load: Option<LoadMetric>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uptime_seconds: Option<u64>,
    pub top_processes: Vec<ProcessMetric>,
    pub unavailable: Vec<MonitorUnavailable>,
}

struct CpuSampleEntry {
    sample: Arc<Mutex<Option<CpuTimes>>>,
    last_used: Instant,
}

struct CpuSampleState {
    entries: HashMap<Id, CpuSampleEntry>,
}

#[derive(Clone)]
pub struct CpuSampleStore {
    inner: Arc<Mutex<CpuSampleState>>,
    ttl: Duration,
    capacity: usize,
}

impl CpuSampleStore {
    pub fn new(ttl: Duration, capacity: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(CpuSampleState {
                entries: HashMap::new(),
            })),
            ttl,
            capacity: capacity.max(1),
        }
    }

    async fn acquire(&self, connection_id: Id) -> Arc<Mutex<Option<CpuTimes>>> {
        let now = Instant::now();
        let mut state = self.inner.lock().await;
        state.entries.retain(|_, entry| {
            now.checked_duration_since(entry.last_used)
                .is_some_and(|age| age < self.ttl)
        });
        if !state.entries.contains_key(&connection_id) {
            while state.entries.len() >= self.capacity {
                let Some(oldest) = state
                    .entries
                    .iter()
                    .min_by_key(|(_, entry)| entry.last_used)
                    .map(|(id, _)| *id)
                else {
                    break;
                };
                state.entries.remove(&oldest);
            }
        }
        let entry = state
            .entries
            .entry(connection_id)
            .or_insert_with(|| CpuSampleEntry {
                sample: Arc::new(Mutex::new(None)),
                last_used: now,
            });
        entry.last_used = now;
        entry.sample.clone()
    }

    #[cfg(test)]
    async fn tracked_connection_ids(&self) -> Vec<Id> {
        self.inner.lock().await.entries.keys().copied().collect()
    }
}

impl Default for CpuSampleStore {
    fn default() -> Self {
        Self::new(DEFAULT_CPU_STATE_TTL, DEFAULT_CPU_STATE_CAPACITY)
    }
}

#[derive(Clone)]
pub struct SystemMonitor<R> {
    runner: R,
    cpu_samples: CpuSampleStore,
}

impl<R> SystemMonitor<R>
where
    R: RemoteCommandRunner,
{
    pub fn new(runner: R, cpu_samples: CpuSampleStore) -> Self {
        Self {
            runner,
            cpu_samples,
        }
    }

    pub async fn snapshot(
        &self,
        connection: &ConnectionHandle,
    ) -> Result<MonitorSnapshot, CoreError> {
        let mut unavailable = Vec::new();
        let cpu_sample = self.cpu_samples.acquire(connection.connection_id()).await;
        let cpu_percent = {
            let mut previous = cpu_sample.lock().await;
            let source = self
                .section(
                    connection,
                    RemoteCommand::try_new("cat")?.arg("/proc/stat")?,
                )
                .await?;
            match source.as_deref().map(parse_proc_stat) {
                Some(Ok(current)) => {
                    let usage = cpu_usage_percent(*previous, current);
                    if usage.is_none() && previous.is_none() {
                        unavailable.push(MonitorUnavailable::CpuWarmingUp);
                    } else if usage.is_none() {
                        unavailable.push(MonitorUnavailable::Cpu);
                    }
                    *previous = Some(current);
                    usage
                }
                Some(Err(_)) | None => {
                    unavailable.push(MonitorUnavailable::Cpu);
                    None
                }
            }
        };

        let memory = match self
            .section(
                connection,
                RemoteCommand::try_new("cat")?.arg("/proc/meminfo")?,
            )
            .await?
            .as_deref()
            .map(parse_memory_metric)
        {
            Some(Ok(memory)) => Some(memory),
            Some(Err(_)) | None => {
                unavailable.push(MonitorUnavailable::Memory);
                None
            }
        };

        let disk = match self
            .section(
                connection,
                RemoteCommand::try_new("df")?.arg("-Pk")?.arg("/")?,
            )
            .await?
            .as_deref()
            .map(parse_root_disk)
        {
            Some(Ok(disk)) => Some(disk),
            Some(Err(_)) | None => {
                unavailable.push(MonitorUnavailable::Disk);
                None
            }
        };

        let load = match self
            .section(
                connection,
                RemoteCommand::try_new("cat")?.arg("/proc/loadavg")?,
            )
            .await?
            .as_deref()
            .map(parse_load_metric)
        {
            Some(Ok(load)) => Some(load),
            Some(Err(_)) | None => {
                unavailable.push(MonitorUnavailable::Load);
                None
            }
        };

        let uptime_seconds = match self
            .section(
                connection,
                RemoteCommand::try_new("cat")?.arg("/proc/uptime")?,
            )
            .await?
            .as_deref()
            .map(parse_uptime_seconds)
        {
            Some(Ok(uptime)) => Some(uptime),
            Some(Err(_)) | None => {
                unavailable.push(MonitorUnavailable::Uptime);
                None
            }
        };

        let top_processes = match self
            .section(
                connection,
                RemoteCommand::try_new("ps")?
                    .arg("-eo")?
                    .arg("pid=,user=,pcpu=,pmem=,comm=")?,
            )
            .await?
        {
            Some(source) => {
                let parsed = parse_processes(&source);
                if parsed.invalid_rows > 0 && !parsed.processes.is_empty() {
                    unavailable.push(MonitorUnavailable::ProcessesPartial);
                }
                if parsed.processes.is_empty() && parsed.invalid_rows > 0 {
                    unavailable.push(MonitorUnavailable::Processes);
                }
                select_top_processes(&parsed.processes)
            }
            None => {
                unavailable.push(MonitorUnavailable::Processes);
                Vec::new()
            }
        };

        Ok(MonitorSnapshot {
            timestamp: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            cpu_percent,
            memory,
            disk,
            load,
            uptime_seconds,
            top_processes,
            unavailable,
        })
    }

    async fn section(
        &self,
        connection: &ConnectionHandle,
        command: RemoteCommand,
    ) -> Result<Option<String>, CoreError> {
        let output = match self.runner.run(connection, command).await {
            Ok(output) => output,
            Err(error)
                if matches!(
                    error.code(),
                    CoreErrorCode::SshConnection | CoreErrorCode::NotFound
                ) =>
            {
                return Err(error);
            }
            Err(_) => return Ok(None),
        };
        if output.exit_status != 0 {
            return Ok(None);
        }
        Ok(String::from_utf8(output.stdout).ok())
    }
}

fn compare_cpu(left: &ProcessMetric, right: &ProcessMetric) -> std::cmp::Ordering {
    right
        .cpu_percent
        .total_cmp(&left.cpu_percent)
        .then_with(|| left.pid.cmp(&right.pid))
        .then_with(|| left.name.cmp(&right.name))
}

fn compare_memory(left: &ProcessMetric, right: &ProcessMetric) -> std::cmp::Ordering {
    right
        .memory_percent
        .total_cmp(&left.memory_percent)
        .then_with(|| left.pid.cmp(&right.pid))
        .then_with(|| left.name.cmp(&right.name))
}

fn parse_error(message: &str) -> CoreError {
    CoreError::new(CoreErrorCode::RemoteParse, message, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cpu_state_expires_idle_connections_and_stays_within_its_capacity() {
        let store = CpuSampleStore::new(Duration::from_millis(20), 2);
        let expired = Id::new();
        store.acquire(expired).await;
        tokio::time::sleep(Duration::from_millis(30)).await;

        let current = Id::new();
        store.acquire(current).await;
        assert_eq!(store.tracked_connection_ids().await, vec![current]);

        let newer = Id::new();
        store.acquire(newer).await;
        let ids = store.tracked_connection_ids().await;
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&current));
        assert!(ids.contains(&newer));
    }
}
