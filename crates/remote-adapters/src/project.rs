use std::collections::HashSet;

use opspilot_domain::ProjectRoot;
use opspilot_domain::{CoreError, CoreErrorCode, RuntimeType};
use opspilot_secrets::SecretStore;
use opspilot_ssh_core::ConnectionHandle;
use serde::{Deserialize, Serialize};

use crate::{RemoteCommand, RemoteExecutor};

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectDetection {
    pub primary: RuntimeType,
    pub evidence: Vec<String>,
    pub confidence: f32,
}

#[derive(Clone, Debug, Default)]
pub struct ProjectDetector;

impl ProjectDetector {
    pub fn detect<I, S>(&self, files: I) -> Result<ProjectDetection, CoreError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut names = HashSet::new();
        for file in files {
            let file = file.as_ref();
            if file.is_empty()
                || file.chars().any(char::is_control)
                || file.contains('/')
                || matches!(file, "." | "..")
            {
                return Err(CoreError::new(
                    CoreErrorCode::Validation,
                    "project detection accepts only bounded root-level file names",
                    false,
                ));
            }
            names.insert(file.to_owned());
        }
        let known = [
            "compose.yaml",
            "compose.yml",
            "docker-compose.yml",
            "Dockerfile",
            "package.json",
            "go.mod",
            "requirements.txt",
            "pyproject.toml",
            "index.html",
        ];
        let evidence = known
            .into_iter()
            .filter(|name| names.contains(*name))
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let primary = if ["compose.yaml", "compose.yml", "docker-compose.yml"]
            .iter()
            .any(|name| names.contains(*name))
        {
            RuntimeType::DockerCompose
        } else if names.contains("go.mod") {
            RuntimeType::Go
        } else if names.contains("pyproject.toml") || names.contains("requirements.txt") {
            RuntimeType::Python
        } else if names.contains("package.json") {
            RuntimeType::NodeJs
        } else if names.contains("index.html") {
            RuntimeType::StaticSite
        } else {
            RuntimeType::Generic
        };
        let confidence = match primary {
            RuntimeType::DockerCompose if names.contains("Dockerfile") => 1.0,
            RuntimeType::Generic => 0.25,
            _ => 0.9,
        };
        Ok(ProjectDetection {
            primary,
            evidence,
            confidence,
        })
    }

    pub async fn detect_remote<S>(
        &self,
        executor: &RemoteExecutor<S>,
        connection: &ConnectionHandle,
        root: &ProjectRoot,
    ) -> Result<ProjectDetection, CoreError>
    where
        S: SecretStore + 'static,
    {
        let command = RemoteCommand::try_new("find")?
            .arg(root.as_str())?
            .arg("-mindepth")?
            .arg("1")?
            .arg("-maxdepth")?
            .arg("1")?
            .arg("-printf")?
            .arg("%f\\0")?;
        let output = executor.execute(connection, command).await?;
        if output.exit_status != 0 {
            return Err(CoreError::new(
                CoreErrorCode::RemoteCommand,
                format!(
                    "project root listing exited with status {}",
                    output.exit_status
                ),
                false,
            ));
        }
        let names = output
            .stdout
            .split(|byte| *byte == 0)
            .filter(|name| !name.is_empty())
            .map(|name| std::str::from_utf8(name).map(str::to_owned))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| {
                CoreError::new(
                    CoreErrorCode::RemoteParse,
                    "project root contains a non-UTF-8 file name",
                    false,
                )
            })?;
        self.detect(names)
    }
}
