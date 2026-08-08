use std::{
    path::{Path, PathBuf},
    process::Command,
};

use opspilot_domain::{CoreError, CoreErrorCode};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OpenSshServer {
    host: String,
    port: u16,
    username: String,
}

impl OpenSshServer {
    pub fn try_new(host: &str, port: u32, username: &str) -> Result<Self, CoreError> {
        let host = validate_atom(host, "OpenSSH host")?.to_lowercase();
        let username = validate_atom(username, "OpenSSH username")?;
        if host.contains("://")
            || !host.chars().all(|value| {
                value.is_ascii_alphanumeric() || matches!(value, '.' | '-' | '_' | ':')
            })
        {
            return Err(validation("OpenSSH host contains unsupported characters"));
        }
        if !username
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, '.' | '-' | '_'))
        {
            return Err(validation(
                "OpenSSH username contains unsupported characters",
            ));
        }
        let port = u16::try_from(port)
            .ok()
            .filter(|value| *value > 0)
            .ok_or_else(|| validation("OpenSSH port must be between 1 and 65535"))?;
        Ok(Self {
            host,
            port,
            username,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OpenSshArgs {
    program: PathBuf,
    arguments: Vec<String>,
}

impl OpenSshArgs {
    pub fn for_server(server: &OpenSshServer) -> Result<Self, CoreError> {
        Ok(Self {
            program: PathBuf::from("ssh"),
            arguments: vec![
                "-p".to_owned(),
                server.port.to_string(),
                "--".to_owned(),
                format!("{}@{}", server.username, server.host),
            ],
        })
    }

    pub fn with_program(mut self, program: impl AsRef<Path>) -> Result<Self, CoreError> {
        let program = program.as_ref();
        if !program.is_absolute() || !program.is_file() {
            return Err(validation(
                "OpenSSH executable must be an existing absolute file",
            ));
        }
        self.program = program.to_owned();
        Ok(self)
    }

    pub fn program(&self) -> &Path {
        &self.program
    }

    pub fn arguments(&self) -> &[String] {
        &self.arguments
    }

    pub fn command(&self) -> Command {
        let mut command = Command::new(&self.program);
        command.args(&self.arguments).env_clear();
        for name in ["PATH", "LANG", "LC_ALL", "SSH_AUTH_SOCK"] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        command
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SshConfigPreview {
    pub alias: String,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub identity_file: Option<String>,
    pub proxy_jump: Option<String>,
    pub unsupported_directives: Vec<String>,
    pub trusted_host_key: bool,
    pub private_key_copied: bool,
}

pub struct SshConfigImporter;

impl SshConfigImporter {
    pub fn preview(source: &str) -> Result<Vec<SshConfigPreview>, CoreError> {
        let mut previews = Vec::new();
        let mut current: Option<SshConfigPreview> = None;
        for raw_line in source.lines() {
            let line = raw_line.split('#').next().unwrap_or("").trim();
            if line.is_empty() {
                continue;
            }
            let (directive, value) = line
                .split_once(char::is_whitespace)
                .map(|(name, value)| (name, value.trim()))
                .ok_or_else(|| validation("SSH config directive is missing a value"))?;
            if directive.eq_ignore_ascii_case("Host") {
                if let Some(profile) = current.take() {
                    previews.push(validate_preview(profile)?);
                }
                let alias = validate_atom(value, "SSH config alias")?;
                if alias.contains(['*', '?', '!']) || alias.split_whitespace().count() != 1 {
                    return Err(validation("SSH config Host must be one explicit alias"));
                }
                current = Some(SshConfigPreview {
                    host: alias.clone(),
                    alias,
                    port: 22,
                    username: None,
                    identity_file: None,
                    proxy_jump: None,
                    unsupported_directives: Vec::new(),
                    trusted_host_key: false,
                    private_key_copied: false,
                });
                continue;
            }
            let profile = current
                .as_mut()
                .ok_or_else(|| validation("SSH config must start with an explicit Host"))?;
            match directive.to_ascii_lowercase().as_str() {
                "hostname" => profile.host = validate_atom(value, "SSH config hostname")?,
                "user" => profile.username = Some(validate_atom(value, "SSH config user")?),
                "port" => {
                    profile.port = value
                        .parse::<u16>()
                        .ok()
                        .filter(|port| *port > 0)
                        .ok_or_else(|| validation("SSH config port is invalid"))?;
                }
                "identityfile" => {
                    profile.identity_file = Some(validate_atom(value, "SSH identity path")?)
                }
                "proxyjump" => profile.proxy_jump = Some(validate_atom(value, "SSH ProxyJump")?),
                _ => profile
                    .unsupported_directives
                    .push(canonical_directive(directive)),
            }
        }
        if let Some(profile) = current {
            previews.push(validate_preview(profile)?);
        }
        Ok(previews)
    }
}

fn validate_preview(profile: SshConfigPreview) -> Result<SshConfigPreview, CoreError> {
    OpenSshServer::try_new(
        &profile.host,
        u32::from(profile.port),
        profile.username.as_deref().unwrap_or("unknown"),
    )?;
    Ok(profile)
}

fn canonical_directive(value: &str) -> String {
    if value.eq_ignore_ascii_case("proxycommand") {
        "ProxyCommand".to_owned()
    } else {
        value.to_owned()
    }
}

fn validate_atom(value: &str, field: &str) -> Result<String, CoreError> {
    let value = value.trim();
    if value.is_empty() || value.len() > 1024 || value.chars().any(char::is_control) {
        return Err(validation(&format!("{field} is invalid")));
    }
    Ok(value.to_owned())
}

fn validation(message: &str) -> CoreError {
    CoreError::new(CoreErrorCode::Validation, message, false)
}
