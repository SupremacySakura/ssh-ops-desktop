use opspilot_domain::{CoreError, CoreErrorCode};
use serde::{Deserialize, Serialize};

use crate::RemoteCommand;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ServiceAction {
    Start,
    Stop,
    Restart,
}

pub struct SystemdAdapter;

impl SystemdAdapter {
    pub fn action_command(unit: &str, action: ServiceAction) -> Result<RemoteCommand, CoreError> {
        validate_unit(unit)?;
        RemoteCommand::try_new("systemctl")?
            .arg(match action {
                ServiceAction::Start => "start",
                ServiceAction::Stop => "stop",
                ServiceAction::Restart => "restart",
            })?
            .arg("--")?
            .arg(unit)
    }

    pub fn journal_command(unit: &str, lines: u32) -> Result<RemoteCommand, CoreError> {
        validate_unit(unit)?;
        if !(1..=100_000).contains(&lines) {
            return Err(validation(
                "journal line count must be between 1 and 100000",
            ));
        }
        RemoteCommand::try_new("journalctl")?
            .arg("--no-pager")?
            .arg("--output=json")?
            .arg("--lines")?
            .arg(&lines.to_string())?
            .arg("--unit")?
            .arg(unit)
    }
}

fn validate_unit(value: &str) -> Result<(), CoreError> {
    if !value.ends_with(".service")
        || value.len() > 256
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '@' | '_' | '.' | ':' | '-')
        })
    {
        return Err(validation("systemd unit name is invalid"));
    }
    Ok(())
}

fn validation(message: &str) -> CoreError {
    CoreError::new(CoreErrorCode::Validation, message, false)
}
