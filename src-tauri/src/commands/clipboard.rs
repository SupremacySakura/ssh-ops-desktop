use arboard::{Clipboard, Error as ClipboardError};
use opspilot_domain::{CoreError, CoreErrorCode};
use tauri::AppHandle;

const MAX_CLIPBOARD_TEXT_BYTES: usize = 4 * 1024 * 1024;

#[tauri::command]
pub(crate) async fn clipboard_read_text(app: AppHandle) -> Result<String, CoreError> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = sender.send(read_system_clipboard());
    })
    .map_err(|_| clipboard_unavailable())?;
    receiver.await.map_err(|_| clipboard_unavailable())?
}

fn read_system_clipboard() -> Result<String, CoreError> {
    let mut clipboard = Clipboard::new().map_err(|_| clipboard_unavailable())?;
    match clipboard.get_text() {
        Ok(text) => validate_clipboard_text(text),
        Err(ClipboardError::ContentNotAvailable) => Ok(String::new()),
        Err(_) => Err(clipboard_unavailable()),
    }
}

fn validate_clipboard_text(text: String) -> Result<String, CoreError> {
    if text.len() > MAX_CLIPBOARD_TEXT_BYTES {
        return Err(CoreError::new(
            CoreErrorCode::Validation,
            "剪贴板内容超过 4 MiB，无法读取",
            false,
        ));
    }
    Ok(text)
}

fn clipboard_unavailable() -> CoreError {
    CoreError::new(
        CoreErrorCode::CapabilityUnavailable,
        "无法读取系统剪贴板",
        true,
    )
}

#[cfg(test)]
mod tests {
    use opspilot_domain::CoreErrorCode;

    use super::{MAX_CLIPBOARD_TEXT_BYTES, validate_clipboard_text};

    #[test]
    fn accepts_text_at_or_below_the_limit() {
        let text = "echo harbor".to_owned();
        assert_eq!(validate_clipboard_text(text.clone()).expect("text"), text);

        let boundary = "a".repeat(MAX_CLIPBOARD_TEXT_BYTES);
        assert_eq!(
            validate_clipboard_text(boundary.clone()).expect("boundary"),
            boundary,
        );
    }

    #[test]
    fn rejects_text_above_the_limit_with_a_fixed_message() {
        let error = validate_clipboard_text("a".repeat(MAX_CLIPBOARD_TEXT_BYTES + 1))
            .expect_err("oversized clipboard must be rejected");

        assert_eq!(error.code(), CoreErrorCode::Validation);
        assert_eq!(error.message(), "剪贴板内容超过 4 MiB，无法读取");
        assert!(!error.is_retryable());
    }
}
