use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use opspilot_domain::{CoreError, CoreErrorCode, Id};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const COPY_BUFFER_SIZE: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictPolicy {
    Fail,
    Overwrite,
    Rename,
    ResumeIfMatching,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct RemotePath(String);

impl RemotePath {
    pub fn try_new(value: &str) -> Result<Self, CoreError> {
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
                "" | "." => {} // 连续斜杠与当前目录段
                ".." => return Err(validation("remote path must not escape its root")),
                _ => {
                    normalized.push_str(segment);
                    normalized.push('/');
                    segments += 1;
                }
            }
        }
        if segments == 0 {
            return Err(validation("remote path must identify a resource"));
        }
        normalized.pop();
        Ok(Self(normalized))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn relative(&self) -> &str {
        self.0
            .strip_prefix('/')
            .expect("validated remote paths are absolute")
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferCheckpoint {
    pub source_size: u64,
    pub source_modified_millis: u64,
    pub source_sha256: String,
    pub transferred: u64,
}

#[derive(Clone, Debug)]
pub struct UploadOptions {
    pub task_id: Id,
    pub conflict: ConflictPolicy,
    pub checkpoint: Option<TransferCheckpoint>,
    /// Test/adapter interruption hook. Production callers leave this unset and cancel through
    /// the task engine between chunks.
    pub byte_limit: Option<u64>,
}

impl UploadOptions {
    pub fn new(task_id: Id, conflict: ConflictPolicy) -> Self {
        Self {
            task_id,
            conflict,
            checkpoint: None,
            byte_limit: None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UploadResult {
    pub destination: RemotePath,
    pub transferred: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransferFailure {
    pub error: CoreError,
    pub checkpoint: TransferCheckpoint,
}

#[derive(Clone, Debug)]
pub struct LocalSftpAdapter {
    root: PathBuf,
}

impl LocalSftpAdapter {
    pub fn new(root: impl AsRef<Path>) -> Result<Self, CoreError> {
        let root = root
            .as_ref()
            .canonicalize()
            .map_err(|error| io_error("open transfer root", error))?;
        if !root.is_dir() {
            return Err(validation("transfer root must be a directory"));
        }
        Ok(Self { root })
    }

    pub fn upload(
        &self,
        source: impl AsRef<Path>,
        destination: &RemotePath,
        options: UploadOptions,
    ) -> Result<UploadResult, TransferFailure> {
        let source = source.as_ref();
        let source_metadata =
            fs::metadata(source).map_err(|error| failure(io_error("read upload source", error)))?;
        if !source_metadata.is_file() {
            return Err(failure(validation("upload source must be a regular file")));
        }
        let source_fingerprint = fingerprint(source, &source_metadata).map_err(failure)?;
        let (parent, file_name) = self.resolve_parent(destination).map_err(failure)?;
        let mut final_path = parent.join(&file_name);
        if fs::symlink_metadata(&final_path)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Err(failure(validation(
                "upload destination must not be a symbolic link",
            )));
        }
        if final_path.exists() {
            match options.conflict {
                ConflictPolicy::Fail | ConflictPolicy::ResumeIfMatching => {
                    return Err(failure(CoreError::new(
                        CoreErrorCode::Conflict,
                        "upload destination already exists",
                        false,
                    )));
                }
                ConflictPolicy::Overwrite => {}
                ConflictPolicy::Rename => {
                    final_path = available_name(&parent, &file_name).map_err(failure)?;
                }
            }
        }

        let part_path = parent.join(format!(".opspilot-upload-{}.part", options.task_id));
        if fs::symlink_metadata(&part_path)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Err(failure(validation(
                "upload checkpoint must not be a symbolic link",
            )));
        }
        let offset = match options.conflict {
            ConflictPolicy::ResumeIfMatching => {
                let checkpoint = options.checkpoint.as_ref().ok_or_else(|| {
                    failure(CoreError::new(
                        CoreErrorCode::Conflict,
                        "resume requires a transfer checkpoint",
                        false,
                    ))
                })?;
                if !checkpoint.matches(&source_fingerprint) {
                    return Err(TransferFailure {
                        error: CoreError::new(
                            CoreErrorCode::Conflict,
                            "upload source changed since the checkpoint was created",
                            false,
                        ),
                        checkpoint: checkpoint.clone(),
                    });
                }
                let part_size = fs::metadata(&part_path)
                    .map_err(|error| failure(io_error("read upload checkpoint", error)))?
                    .len();
                if part_size != checkpoint.transferred {
                    return Err(TransferFailure {
                        error: CoreError::new(
                            CoreErrorCode::Conflict,
                            "partial upload no longer matches its checkpoint",
                            false,
                        ),
                        checkpoint: checkpoint.clone(),
                    });
                }
                checkpoint.transferred
            }
            _ => 0,
        };

        let mut input =
            File::open(source).map_err(|error| failure(io_error("open upload source", error)))?;
        input
            .seek(SeekFrom::Start(offset))
            .map_err(|error| failure(io_error("seek upload source", error)))?;
        let mut output = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(offset == 0)
            .open(&part_path)
            .map_err(|error| failure(io_error("open partial upload", error)))?;
        output
            .seek(SeekFrom::Start(offset))
            .map_err(|error| failure(io_error("seek partial upload", error)))?;

        let mut transferred = offset;
        let mut buffer = vec![0_u8; COPY_BUFFER_SIZE];
        loop {
            let read = input.read(&mut buffer).map_err(|error| {
                failure_with(
                    &source_fingerprint,
                    transferred,
                    io_error("read upload source", error),
                )
            })?;
            if read == 0 {
                break;
            }
            let allowed = options
                .byte_limit
                .map(|limit| limit.saturating_sub(transferred - offset) as usize)
                .unwrap_or(read)
                .min(read);
            if allowed > 0 {
                output.write_all(&buffer[..allowed]).map_err(|error| {
                    failure_with(
                        &source_fingerprint,
                        transferred,
                        io_error("write partial upload", error),
                    )
                })?;
                transferred += allowed as u64;
            }
            if allowed < read
                || options
                    .byte_limit
                    .is_some_and(|limit| transferred - offset >= limit)
            {
                output.flush().ok();
                return Err(failure_with(
                    &source_fingerprint,
                    transferred,
                    CoreError::new(CoreErrorCode::Cancelled, "transfer interrupted", true),
                ));
            }
        }
        output.sync_all().map_err(|error| {
            failure_with(
                &source_fingerprint,
                transferred,
                io_error("sync partial upload", error),
            )
        })?;
        fs::rename(&part_path, &final_path).map_err(|error| {
            failure_with(
                &source_fingerprint,
                transferred,
                io_error("commit upload", error),
            )
        })?;
        sync_directory(&parent)
            .map_err(|error| failure_with(&source_fingerprint, transferred, error))?;

        let final_name = final_path
            .strip_prefix(&self.root)
            .map_err(|_| failure(validation("committed upload escaped its root")))?;
        let final_remote =
            RemotePath::try_new(&format!("/{}", final_name.to_string_lossy())).map_err(failure)?;
        Ok(UploadResult {
            destination: final_remote,
            transferred,
            sha256: source_fingerprint.source_sha256,
        })
    }

    fn resolve_parent(&self, destination: &RemotePath) -> Result<(PathBuf, String), CoreError> {
        let path = self.root.join(destination.relative());
        let file_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| validation("remote destination name is invalid"))?
            .to_owned();
        let parent = path
            .parent()
            .ok_or_else(|| validation("remote destination parent is invalid"))?
            .canonicalize()
            .map_err(|error| io_error("resolve remote destination", error))?;
        if !parent.starts_with(&self.root) {
            return Err(validation("remote destination escapes its root"));
        }
        Ok((parent, file_name))
    }
}

impl TransferCheckpoint {
    fn matches(&self, other: &Self) -> bool {
        self.source_size == other.source_size
            && self.source_modified_millis == other.source_modified_millis
            && self.source_sha256 == other.source_sha256
    }
}

fn fingerprint(path: &Path, metadata: &fs::Metadata) -> Result<TransferCheckpoint, CoreError> {
    let modified = metadata
        .modified()
        .map_err(|error| io_error("read upload source timestamp", error))?
        .duration_since(UNIX_EPOCH)
        .map_err(|_| validation("upload source timestamp predates the Unix epoch"))?;
    let mut source = File::open(path).map_err(|error| io_error("open upload source", error))?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; COPY_BUFFER_SIZE];
    loop {
        let read = source
            .read(&mut buffer)
            .map_err(|error| io_error("hash upload source", error))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(TransferCheckpoint {
        source_size: metadata.len(),
        source_modified_millis: modified.as_millis().try_into().unwrap_or(u64::MAX),
        source_sha256: format!("{:x}", digest.finalize()),
        transferred: 0,
    })
}

fn available_name(parent: &Path, file_name: &str) -> Result<PathBuf, CoreError> {
    for suffix in 1..=10_000_u32 {
        let candidate = parent.join(format!("{file_name}.{suffix}"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(CoreError::new(
        CoreErrorCode::Conflict,
        "no conflict-free upload destination is available",
        false,
    ))
}

fn sync_directory(path: &Path) -> Result<(), CoreError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| io_error("sync upload directory", error))
}

fn failure(error: CoreError) -> TransferFailure {
    TransferFailure {
        error,
        checkpoint: TransferCheckpoint {
            source_size: 0,
            source_modified_millis: 0,
            source_sha256: String::new(),
            transferred: 0,
        },
    }
}

fn failure_with(
    fingerprint: &TransferCheckpoint,
    transferred: u64,
    error: CoreError,
) -> TransferFailure {
    let mut checkpoint = fingerprint.clone();
    checkpoint.transferred = transferred;
    TransferFailure { error, checkpoint }
}

fn validation(message: &str) -> CoreError {
    CoreError::new(CoreErrorCode::Validation, message, false)
}

fn io_error(context: &str, error: std::io::Error) -> CoreError {
    CoreError::new(
        CoreErrorCode::Internal,
        format!("failed to {context}: {error}"),
        false,
    )
}
