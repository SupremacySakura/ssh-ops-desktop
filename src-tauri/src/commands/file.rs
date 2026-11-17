use async_trait::async_trait;
use opspilot_domain::CoreError;
use opspilot_ssh_core::{
    ConnectionHandle, RemoteDirectoryPath, RemoteFileDownload, RemoteFileEntry,
    RemoteFileMutationResult, RemoteFileService, RemoteFileWriteResult, RemotePath,
    RemoteRenameResult, RemoteTextFile, RemoteUploadFile, RemoteUploadOutcome,
};
use tauri::{AppHandle, Manager};

use super::CoreServices;

#[async_trait]
pub(crate) trait FileOperations: Send + Sync {
    async fn list(
        &self,
        connection: &ConnectionHandle,
        directory: &RemoteDirectoryPath,
    ) -> Result<Vec<RemoteFileEntry>, CoreError>;
    async fn read(
        &self,
        connection: &ConnectionHandle,
        path: &RemotePath,
    ) -> Result<RemoteTextFile, CoreError>;
    async fn write(
        &self,
        connection: &ConnectionHandle,
        path: &RemotePath,
        content: String,
        expected_sha256: &str,
    ) -> Result<RemoteFileWriteResult, CoreError>;
    async fn download(
        &self,
        connection: &ConnectionHandle,
        path: &RemotePath,
    ) -> Result<RemoteFileDownload, CoreError>;
    async fn upload_batch(
        &self,
        connection: &ConnectionHandle,
        directory: &RemoteDirectoryPath,
        files: &[RemoteUploadFile],
    ) -> Result<RemoteUploadOutcome, CoreError>;
    async fn create_directory(
        &self,
        connection: &ConnectionHandle,
        path: &RemotePath,
    ) -> Result<RemoteFileMutationResult, CoreError>;
    async fn rename_no_clobber(
        &self,
        connection: &ConnectionHandle,
        source: &RemotePath,
        target: &RemotePath,
    ) -> Result<RemoteRenameResult, CoreError>;
    async fn delete(
        &self,
        connection: &ConnectionHandle,
        path: &RemotePath,
    ) -> Result<RemoteFileMutationResult, CoreError>;
}

#[async_trait]
impl FileOperations for RemoteFileService {
    async fn list(
        &self,
        connection: &ConnectionHandle,
        directory: &RemoteDirectoryPath,
    ) -> Result<Vec<RemoteFileEntry>, CoreError> {
        RemoteFileService::list(self, connection, directory).await
    }

    async fn read(
        &self,
        connection: &ConnectionHandle,
        path: &RemotePath,
    ) -> Result<RemoteTextFile, CoreError> {
        RemoteFileService::read(self, connection, path).await
    }

    async fn write(
        &self,
        connection: &ConnectionHandle,
        path: &RemotePath,
        content: String,
        expected_sha256: &str,
    ) -> Result<RemoteFileWriteResult, CoreError> {
        RemoteFileService::write(self, connection, path, content, expected_sha256).await
    }

    async fn download(
        &self,
        connection: &ConnectionHandle,
        path: &RemotePath,
    ) -> Result<RemoteFileDownload, CoreError> {
        RemoteFileService::download(self, connection, path).await
    }

    async fn upload_batch(
        &self,
        connection: &ConnectionHandle,
        directory: &RemoteDirectoryPath,
        files: &[RemoteUploadFile],
    ) -> Result<RemoteUploadOutcome, CoreError> {
        RemoteFileService::upload_batch(self, connection, directory, files).await
    }

    async fn create_directory(
        &self,
        connection: &ConnectionHandle,
        path: &RemotePath,
    ) -> Result<RemoteFileMutationResult, CoreError> {
        RemoteFileService::create_directory(self, connection, path).await
    }

    async fn rename_no_clobber(
        &self,
        connection: &ConnectionHandle,
        source: &RemotePath,
        target: &RemotePath,
    ) -> Result<RemoteRenameResult, CoreError> {
        RemoteFileService::rename_no_clobber(self, connection, source, target).await
    }

    async fn delete(
        &self,
        connection: &ConnectionHandle,
        path: &RemotePath,
    ) -> Result<RemoteFileMutationResult, CoreError> {
        RemoteFileService::delete(self, connection, path).await
    }
}

pub(super) async fn list_remote_files(
    files: &dyn FileOperations,
    connection: &ConnectionHandle,
    directory: &RemoteDirectoryPath,
) -> Result<Vec<RemoteFileEntry>, CoreError> {
    files.list(connection, directory).await
}

pub(super) async fn read_remote_file(
    files: &dyn FileOperations,
    connection: &ConnectionHandle,
    path: &RemotePath,
) -> Result<RemoteTextFile, CoreError> {
    files.read(connection, path).await
}

pub(super) async fn write_remote_file(
    files: &dyn FileOperations,
    connection: &ConnectionHandle,
    path: &RemotePath,
    content: String,
    expected_sha256: &str,
) -> Result<RemoteFileWriteResult, CoreError> {
    files
        .write(connection, path, content, expected_sha256)
        .await
}

pub(super) async fn download_remote_file(
    files: &dyn FileOperations,
    connection: &ConnectionHandle,
    path: &RemotePath,
) -> Result<RemoteFileDownload, CoreError> {
    files.download(connection, path).await
}

pub(super) async fn upload_remote_files(
    files: &dyn FileOperations,
    connection: &ConnectionHandle,
    directory: &RemoteDirectoryPath,
    uploads: &[RemoteUploadFile],
) -> Result<RemoteUploadOutcome, CoreError> {
    files.upload_batch(connection, directory, uploads).await
}

pub(super) async fn create_remote_directory(
    files: &dyn FileOperations,
    connection: &ConnectionHandle,
    path: &RemotePath,
) -> Result<RemoteFileMutationResult, CoreError> {
    files.create_directory(connection, path).await
}

pub(super) async fn rename_remote_file(
    files: &dyn FileOperations,
    connection: &ConnectionHandle,
    source: &RemotePath,
    target: &RemotePath,
) -> Result<RemoteRenameResult, CoreError> {
    files.rename_no_clobber(connection, source, target).await
}

pub(super) async fn delete_remote_file(
    files: &dyn FileOperations,
    connection: &ConnectionHandle,
    path: &RemotePath,
) -> Result<RemoteFileMutationResult, CoreError> {
    files.delete(connection, path).await
}

#[tauri::command]
pub(crate) async fn file_list(
    app: AppHandle,
    connection: ConnectionHandle,
    path: RemoteDirectoryPath,
) -> Result<Vec<RemoteFileEntry>, CoreError> {
    let services = core_services(&app);
    list_remote_files(services.file_operations.as_ref(), &connection, &path).await
}

#[tauri::command]
pub(crate) async fn file_read(
    app: AppHandle,
    connection: ConnectionHandle,
    path: RemotePath,
) -> Result<RemoteTextFile, CoreError> {
    let services = core_services(&app);
    read_remote_file(services.file_operations.as_ref(), &connection, &path).await
}

#[tauri::command]
pub(crate) async fn file_write(
    app: AppHandle,
    connection: ConnectionHandle,
    path: RemotePath,
    content: String,
    expected_sha256: String,
) -> Result<RemoteFileWriteResult, CoreError> {
    let services = core_services(&app);
    write_remote_file(
        services.file_operations.as_ref(),
        &connection,
        &path,
        content,
        &expected_sha256,
    )
    .await
}

#[tauri::command]
pub(crate) async fn file_download(
    app: AppHandle,
    connection: ConnectionHandle,
    path: RemotePath,
) -> Result<RemoteFileDownload, CoreError> {
    let services = core_services(&app);
    download_remote_file(services.file_operations.as_ref(), &connection, &path).await
}

#[tauri::command]
pub(crate) async fn file_upload(
    app: AppHandle,
    connection: ConnectionHandle,
    directory: RemoteDirectoryPath,
    files: Vec<RemoteUploadFile>,
) -> Result<RemoteUploadOutcome, CoreError> {
    let services = core_services(&app);
    upload_remote_files(
        services.file_operations.as_ref(),
        &connection,
        &directory,
        &files,
    )
    .await
}

#[tauri::command]
pub(crate) async fn file_mkdir(
    app: AppHandle,
    connection: ConnectionHandle,
    path: RemotePath,
) -> Result<RemoteFileMutationResult, CoreError> {
    let services = core_services(&app);
    create_remote_directory(services.file_operations.as_ref(), &connection, &path).await
}

#[tauri::command]
pub(crate) async fn file_rename(
    app: AppHandle,
    connection: ConnectionHandle,
    source_path: RemotePath,
    target_path: RemotePath,
) -> Result<RemoteRenameResult, CoreError> {
    let services = core_services(&app);
    rename_remote_file(
        services.file_operations.as_ref(),
        &connection,
        &source_path,
        &target_path,
    )
    .await
}

#[tauri::command]
pub(crate) async fn file_delete(
    app: AppHandle,
    connection: ConnectionHandle,
    path: RemotePath,
) -> Result<RemoteFileMutationResult, CoreError> {
    let services = core_services(&app);
    delete_remote_file(services.file_operations.as_ref(), &connection, &path).await
}

fn core_services(app: &AppHandle) -> CoreServices {
    app.state::<CoreServices>().inner().clone()
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use async_trait::async_trait;
    use opspilot_domain::{CoreError, CoreErrorCode, Id};
    use opspilot_ssh_core::{
        ConnectionHandle, RemoteDirectoryPath, RemoteFileDownload, RemoteFileEntry, RemoteFileKind,
        RemoteFileMutationResult, RemoteFileWriteResult, RemotePath, RemoteRenameResult,
        RemoteTextFile, RemoteUploadFile, RemoteUploadOutcome, RenameStatus, UploadBatchStatus,
    };

    use super::{
        FileOperations, create_remote_directory, delete_remote_file, download_remote_file,
        list_remote_files, read_remote_file, rename_remote_file, upload_remote_files,
        write_remote_file,
    };

    #[derive(Default)]
    struct FakeFiles {
        calls: Mutex<Vec<String>>,
        list: Option<Result<Vec<RemoteFileEntry>, CoreError>>,
        read: Option<Result<RemoteTextFile, CoreError>>,
        write: Option<Result<RemoteFileWriteResult, CoreError>>,
        download: Option<Result<RemoteFileDownload, CoreError>>,
        upload: Option<Result<RemoteUploadOutcome, CoreError>>,
        create_directory: Option<Result<RemoteFileMutationResult, CoreError>>,
        rename: Option<Result<RemoteRenameResult, CoreError>>,
        delete: Option<Result<RemoteFileMutationResult, CoreError>>,
    }

    impl FakeFiles {
        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl FileOperations for FakeFiles {
        async fn list(
            &self,
            _connection: &ConnectionHandle,
            directory: &RemoteDirectoryPath,
        ) -> Result<Vec<RemoteFileEntry>, CoreError> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("list:{}", directory.as_str()));
            self.list.clone().expect("configured list")
        }

        async fn read(
            &self,
            _connection: &ConnectionHandle,
            path: &RemotePath,
        ) -> Result<RemoteTextFile, CoreError> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("read:{}", path.as_str()));
            self.read.clone().expect("configured read")
        }

        async fn write(
            &self,
            _connection: &ConnectionHandle,
            path: &RemotePath,
            content: String,
            expected_sha256: &str,
        ) -> Result<RemoteFileWriteResult, CoreError> {
            self.calls.lock().unwrap().push(format!(
                "write:{}:{}:{expected_sha256}",
                path.as_str(),
                content
            ));
            self.write.clone().expect("configured write")
        }

        async fn download(
            &self,
            _connection: &ConnectionHandle,
            path: &RemotePath,
        ) -> Result<RemoteFileDownload, CoreError> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("download:{}", path.as_str()));
            self.download.clone().expect("configured download")
        }

        async fn upload_batch(
            &self,
            _connection: &ConnectionHandle,
            directory: &RemoteDirectoryPath,
            files: &[RemoteUploadFile],
        ) -> Result<RemoteUploadOutcome, CoreError> {
            self.calls.lock().unwrap().push(format!(
                "upload:{}:{}",
                directory.as_str(),
                files
                    .iter()
                    .map(|file| format!("{}:{}", file.name, file.bytes.len()))
                    .collect::<Vec<_>>()
                    .join(",")
            ));
            self.upload.clone().expect("configured upload")
        }

        async fn create_directory(
            &self,
            _connection: &ConnectionHandle,
            path: &RemotePath,
        ) -> Result<RemoteFileMutationResult, CoreError> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("mkdir:{}", path.as_str()));
            self.create_directory
                .clone()
                .expect("configured create_directory")
        }

        async fn rename_no_clobber(
            &self,
            _connection: &ConnectionHandle,
            source: &RemotePath,
            target: &RemotePath,
        ) -> Result<RemoteRenameResult, CoreError> {
            self.calls.lock().unwrap().push(format!(
                "rename:{}:{}",
                source.as_str(),
                target.as_str()
            ));
            self.rename.clone().expect("configured rename")
        }

        async fn delete(
            &self,
            _connection: &ConnectionHandle,
            path: &RemotePath,
        ) -> Result<RemoteFileMutationResult, CoreError> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("delete:{}", path.as_str()));
            self.delete.clone().expect("configured delete")
        }
    }

    fn connection() -> ConnectionHandle {
        ConnectionHandle::new(Id::new(), Id::new())
    }

    const HASH: &str = "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03";

    #[tokio::test]
    async fn command_helpers_pass_validated_paths_and_hash_to_the_file_service() {
        let entry = RemoteFileEntry {
            name: "hello.txt".to_owned(),
            path: "/hello.txt".to_owned(),
            kind: RemoteFileKind::File,
            size: 6,
            modified_at: Some(42),
            permissions: Some(0o644),
        };
        let text = RemoteTextFile {
            path: "/hello.txt".to_owned(),
            text: "hello\n".to_owned(),
            sha256: HASH.to_owned(),
            size: 6,
            modified_at: Some(42),
        };
        let written = RemoteFileWriteResult {
            path: "/hello.txt".to_owned(),
            sha256: "bc6f1f5b8d6e02be0c4ef2f7d86d42b8c04c7609fa535e0ee04f22f28412eea1".to_owned(),
            size: 5,
            modified_at: Some(43),
            warning: None,
        };
        let download = RemoteFileDownload {
            path: "/hello.txt".to_owned(),
            bytes: b"hello\n".to_vec(),
            sha256: HASH.to_owned(),
        };
        let files = FakeFiles {
            list: Some(Ok(vec![entry.clone()])),
            read: Some(Ok(text.clone())),
            write: Some(Ok(written.clone())),
            download: Some(Ok(download.clone())),
            ..FakeFiles::default()
        };
        let connection = connection();

        let listed = list_remote_files(&files, &connection, &RemoteDirectoryPath::root())
            .await
            .unwrap();
        let read = read_remote_file(
            &files,
            &connection,
            &RemotePath::try_new("/hello.txt").unwrap(),
        )
        .await
        .unwrap();
        let saved = write_remote_file(
            &files,
            &connection,
            &RemotePath::try_new("/hello.txt").unwrap(),
            "next\n".to_owned(),
            HASH,
        )
        .await
        .unwrap();
        let downloaded = download_remote_file(
            &files,
            &connection,
            &RemotePath::try_new("/hello.txt").unwrap(),
        )
        .await
        .unwrap();

        assert_eq!(listed, vec![entry]);
        assert_eq!(read, text);
        assert_eq!(saved, written);
        assert_eq!(downloaded, download);
        assert_eq!(
            files.calls(),
            vec![
                "list:/".to_owned(),
                "read:/hello.txt".to_owned(),
                format!("write:/hello.txt:next\n:{HASH}"),
                "download:/hello.txt".to_owned(),
            ]
        );
    }

    #[tokio::test]
    async fn command_helpers_preserve_typed_file_errors() {
        let files = FakeFiles {
            read: Some(Err(CoreError::new(
                CoreErrorCode::Conflict,
                "remote file changed",
                false,
            ))),
            ..FakeFiles::default()
        };
        let error = read_remote_file(
            &files,
            &connection(),
            &RemotePath::try_new("/hello.txt").unwrap(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code(), CoreErrorCode::Conflict);
    }

    #[tokio::test]
    async fn upload_helper_passes_the_batch_and_returns_typed_residue() {
        let files = FakeFiles {
            upload: Some(Ok(RemoteUploadOutcome {
                status: UploadBatchStatus::FailedWithResidue,
                committed: vec!["/docs/one.txt".to_owned()],
                residual: vec!["/docs/one.txt".to_owned()],
                warning: Some("回滚未完全完成".to_owned()),
                error: Some(CoreError::new(
                    CoreErrorCode::Conflict,
                    "目标文件已存在",
                    false,
                )),
            })),
            ..FakeFiles::default()
        };
        let batch = vec![RemoteUploadFile {
            name: "one.txt".to_owned(),
            bytes: b"one".to_vec(),
        }];

        let outcome = upload_remote_files(
            &files,
            &connection(),
            &RemoteDirectoryPath::try_new("/docs").unwrap(),
            &batch,
        )
        .await
        .unwrap();

        assert_eq!(outcome.status, UploadBatchStatus::FailedWithResidue);
        assert_eq!(outcome.residual, vec!["/docs/one.txt"]);
        assert_eq!(files.calls(), vec!["upload:/docs:one.txt:3".to_owned()]);
    }

    #[tokio::test]
    async fn mutation_helpers_forward_validated_paths_and_typed_results() {
        let files = FakeFiles {
            create_directory: Some(Ok(RemoteFileMutationResult {
                path: "/docs/new".to_owned(),
                warning: None,
            })),
            rename: Some(Ok(RemoteRenameResult {
                status: RenameStatus::Partial,
                source_path: "/docs/old.txt".to_owned(),
                target_path: "/docs/new.txt".to_owned(),
                target_created: true,
                warning: Some("源文件未删除".to_owned()),
                error: Some(CoreError::new(
                    CoreErrorCode::Internal,
                    "unlink failed",
                    true,
                )),
            })),
            delete: Some(Ok(RemoteFileMutationResult {
                path: "/docs/old.txt".to_owned(),
                warning: None,
            })),
            ..FakeFiles::default()
        };
        let connection = connection();

        let created = create_remote_directory(
            &files,
            &connection,
            &RemotePath::try_new("/docs/new").unwrap(),
        )
        .await
        .unwrap();
        let renamed = rename_remote_file(
            &files,
            &connection,
            &RemotePath::try_new("/docs/old.txt").unwrap(),
            &RemotePath::try_new("/docs/new.txt").unwrap(),
        )
        .await
        .unwrap();
        let deleted = delete_remote_file(
            &files,
            &connection,
            &RemotePath::try_new("/docs/old.txt").unwrap(),
        )
        .await
        .unwrap();

        assert_eq!(created.path, "/docs/new");
        assert_eq!(renamed.status, RenameStatus::Partial);
        assert_eq!(deleted.path, "/docs/old.txt");
        assert_eq!(
            files.calls(),
            vec![
                "mkdir:/docs/new".to_owned(),
                "rename:/docs/old.txt:/docs/new.txt".to_owned(),
                "delete:/docs/old.txt".to_owned(),
            ]
        );
    }

    #[test]
    fn file_contract_serializes_camel_case_and_omits_absent_metadata() {
        let entry = RemoteFileEntry {
            name: "hello.txt".to_owned(),
            path: "/hello.txt".to_owned(),
            kind: RemoteFileKind::File,
            size: 6,
            modified_at: None,
            permissions: Some(0o644),
        };
        let value = serde_json::to_value(entry).unwrap();
        assert!(value.get("modifiedAt").is_none());
        assert!(value.get("modified_at").is_none());

        let written = RemoteFileWriteResult {
            path: "/hello.txt".to_owned(),
            sha256: HASH.to_owned(),
            size: 6,
            modified_at: None,
            warning: None,
        };
        let value = serde_json::to_value(written).unwrap();
        assert_eq!(value["sha256"], HASH);
        assert!(value.get("modifiedAt").is_none());
        assert!(value.get("warning").is_none());
    }

    #[test]
    fn text_and_download_contracts_serialize_with_the_shared_camel_case_shape() {
        let text = RemoteTextFile {
            path: "/hello.txt".to_owned(),
            text: "hello\n".to_owned(),
            sha256: HASH.to_owned(),
            size: 6,
            modified_at: Some(42),
        };
        let value = serde_json::to_value(text).unwrap();
        assert_eq!(value["path"], "/hello.txt");
        assert_eq!(value["text"], "hello\n");
        assert_eq!(value["sha256"], HASH);
        assert_eq!(value["size"], 6);
        assert_eq!(value["modifiedAt"], 42);

        let download = RemoteFileDownload {
            path: "/hello.txt".to_owned(),
            bytes: b"hello\n".to_vec(),
            sha256: HASH.to_owned(),
        };
        let value = serde_json::to_value(download).unwrap();
        assert_eq!(
            value["bytes"],
            serde_json::json!([104, 101, 108, 108, 111, 10])
        );
        assert_eq!(value["sha256"], HASH);
    }
}
