use opspilot_domain::{CoreError, CoreErrorCode};
use serde::{Deserialize, Deserializer, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct RemotePath(String);

impl RemotePath {
    pub fn try_new(value: &str) -> Result<Self, CoreError> {
        Ok(Self(normalize_remote_path(value, false)?))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn parent_directory(&self) -> RemoteDirectoryPath {
        let parent = self
            .0
            .rsplit_once('/')
            .map(|(parent, _)| if parent.is_empty() { "/" } else { parent })
            .unwrap_or("/");
        RemoteDirectoryPath(parent.to_owned())
    }

    pub fn file_name(&self) -> &str {
        self.0
            .rsplit_once('/')
            .map(|(_, name)| name)
            .expect("validated remote paths contain at least one segment")
    }
}

impl<'de> Deserialize<'de> for RemotePath {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::try_new(&value).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct RemoteDirectoryPath(String);

impl RemoteDirectoryPath {
    pub fn try_new(value: &str) -> Result<Self, CoreError> {
        Ok(Self(normalize_remote_path(value, true)?))
    }

    pub fn root() -> Self {
        Self("/".to_owned())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn join_resource(&self, name: &str) -> Result<RemotePath, CoreError> {
        if name.is_empty()
            || name == "."
            || name == ".."
            || name.contains('/')
            || name.contains('\0')
            || name.chars().any(char::is_control)
        {
            return Err(validation("remote entry name is invalid"));
        }
        let path = if self.0 == "/" {
            format!("/{name}")
        } else {
            format!("{}/{name}", self.0)
        };
        RemotePath::try_new(&path)
    }
}

impl<'de> Deserialize<'de> for RemoteDirectoryPath {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::try_new(&value).map_err(serde::de::Error::custom)
    }
}

fn normalize_remote_path(value: &str, allow_root: bool) -> Result<String, CoreError> {
    if value.is_empty() || value.contains('\0') || value.chars().any(char::is_control) {
        return Err(validation("remote path contains invalid characters"));
    }
    if !value.starts_with('/') {
        return Err(validation("remote path must be absolute"));
    }
    // 远程路径是 POSIX 语义，不能用宿主平台 Path 解析：Windows 上 "/etc" 不是绝对路径，
    // 且 PathBuf 归一化后分隔符会变成反斜杠。这里按 '/' 分段手动归一化。
    let mut normalized = String::from('/');
    let mut segments = 0usize;
    for segment in value.split('/') {
        match segment {
            "" | "." => {}
            ".." => return Err(validation("remote path must not escape its root")),
            _ => {
                normalized.push_str(segment);
                normalized.push('/');
                segments += 1;
            }
        }
    }
    if segments == 0 {
        if allow_root {
            return Ok("/".to_owned());
        }
        return Err(validation("remote path must identify a resource"));
    }
    normalized.pop();
    Ok(normalized)
}

fn validation(message: &str) -> CoreError {
    CoreError::new(CoreErrorCode::Validation, message, false)
}
