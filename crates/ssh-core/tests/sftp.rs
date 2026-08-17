use std::fs;

use opspilot_domain::{CoreErrorCode, Id};
use opspilot_ssh_core::{
    ConflictPolicy, LocalSftpAdapter, RemotePath, TransferCheckpoint, UploadOptions,
};

#[test]
fn remote_path_rejects_parent_components_nul_and_relative_paths() {
    for path in [
        "../etc/passwd",
        "/srv/../etc/passwd",
        "/srv/a\0b",
        "relative",
    ] {
        let error = RemotePath::try_new(path).expect_err("unsafe path must be rejected");
        assert_eq!(error.code(), CoreErrorCode::Validation, "path: {path:?}");
    }

    assert_eq!(
        RemotePath::try_new("/srv/releases/-candidate;safe")
            .unwrap()
            .as_str(),
        "/srv/releases/-candidate;safe"
    );
}

#[test]
fn upload_is_atomic_and_resume_requires_matching_source_metadata() {
    let remote = tempfile::tempdir().unwrap();
    fs::create_dir_all(remote.path().join("srv/releases")).unwrap();
    let local = tempfile::tempdir().unwrap();
    let source = local.path().join("bundle.tar");
    fs::write(&source, b"0123456789").unwrap();
    let adapter = LocalSftpAdapter::new(remote.path()).unwrap();
    let destination = RemotePath::try_new("/srv/releases/bundle.tar").unwrap();
    let task_id = Id::new();

    let interrupted = adapter
        .upload(
            &source,
            &destination,
            UploadOptions {
                task_id,
                conflict: ConflictPolicy::Fail,
                checkpoint: None,
                byte_limit: Some(4),
            },
        )
        .expect_err("byte limit simulates an interruption");
    assert_eq!(interrupted.error.code(), CoreErrorCode::Cancelled);
    assert!(!remote.path().join("srv/releases/bundle.tar").exists());
    assert_eq!(
        fs::read(
            remote
                .path()
                .join(format!("srv/releases/.opspilot-upload-{task_id}.part"))
        )
        .unwrap(),
        b"0123"
    );

    let changed_source = local.path().join("changed.tar");
    fs::write(&changed_source, b"changed-source").unwrap();
    let mismatch = adapter
        .upload(
            &changed_source,
            &destination,
            UploadOptions {
                task_id,
                conflict: ConflictPolicy::ResumeIfMatching,
                checkpoint: Some(interrupted.checkpoint.clone()),
                byte_limit: None,
            },
        )
        .expect_err("changed source must invalidate resume");
    assert_eq!(mismatch.error.code(), CoreErrorCode::Conflict);

    let result = adapter
        .upload(
            &source,
            &destination,
            UploadOptions {
                task_id,
                conflict: ConflictPolicy::ResumeIfMatching,
                checkpoint: Some(interrupted.checkpoint),
                byte_limit: None,
            },
        )
        .unwrap();
    assert_eq!(result.transferred, 10);
    assert_eq!(
        fs::read(remote.path().join("srv/releases/bundle.tar")).unwrap(),
        b"0123456789"
    );
    assert!(
        !remote
            .path()
            .join(format!("srv/releases/.opspilot-upload-{task_id}.part"))
            .exists()
    );
}

#[test]
fn upload_refuses_symlink_escape_and_explicit_conflicts() {
    let remote = tempfile::tempdir().unwrap();
    let _outside = tempfile::tempdir().unwrap();
    fs::create_dir_all(remote.path().join("srv")).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(_outside.path(), remote.path().join("srv/escape")).unwrap();

    let local = tempfile::tempdir().unwrap();
    let source = local.path().join("payload");
    fs::write(&source, b"safe").unwrap();
    let adapter = LocalSftpAdapter::new(remote.path()).unwrap();

    #[cfg(unix)]
    {
        let error = adapter
            .upload(
                &source,
                &RemotePath::try_new("/srv/escape/payload").unwrap(),
                UploadOptions::new(Id::new(), ConflictPolicy::Fail),
            )
            .expect_err("symlink escape must fail");
        assert_eq!(error.error.code(), CoreErrorCode::Validation);
        assert!(!_outside.path().join("payload").exists());
    }

    fs::write(remote.path().join("srv/existing"), b"old").unwrap();
    let error = adapter
        .upload(
            &source,
            &RemotePath::try_new("/srv/existing").unwrap(),
            UploadOptions::new(Id::new(), ConflictPolicy::Fail),
        )
        .expect_err("conflict policy must be explicit");
    assert_eq!(error.error.code(), CoreErrorCode::Conflict);
    assert_eq!(
        fs::read(remote.path().join("srv/existing")).unwrap(),
        b"old"
    );
}

#[test]
fn checkpoints_round_trip_without_exposing_file_contents() {
    let checkpoint = TransferCheckpoint {
        source_size: 12,
        source_modified_millis: 42,
        source_sha256: "a".repeat(64),
        transferred: 6,
    };
    let value = serde_json::to_value(&checkpoint).unwrap();
    assert_eq!(
        serde_json::from_value::<TransferCheckpoint>(value).unwrap(),
        checkpoint
    );
}
