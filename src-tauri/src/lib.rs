//! 桌面版外殼：視窗、金鑰檔、存檔。介面與 API 呼叫都在網頁畫面（TypeScript）裡。

mod keystore;

use std::path::PathBuf;

use tauri::webview::NewWindowResponse;
use tauri::{Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

fn key_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let home = app.path().home_dir().map_err(|e| format!("找不到使用者資料夾：{e}"))?;
    Ok(keystore::key_file_path(|name| std::env::var(name).ok(), &home))
}

#[tauri::command(async)]
fn get_api_key(app: tauri::AppHandle) -> Result<Option<String>, String> {
    keystore::read(&key_path(&app)?)
}

#[tauri::command(async)]
fn set_api_key(app: tauri::AppHandle, key: String) -> Result<(), String> {
    keystore::write(&key_path(&app)?, &key)
}

#[tauri::command(async)]
fn remove_api_key(app: tauri::AppHandle) -> Result<(), String> {
    keystore::remove(&key_path(&app)?)
}

/// 給設定頁顯示金鑰存在哪
#[tauri::command(async)]
fn api_key_location(app: tauri::AppHandle) -> Result<String, String> {
    Ok(key_path(&app)?.display().to_string())
}

/// 跳出「另存新檔」讓使用者選位置，再寫入文字。使用者取消時回傳 false。
#[tauri::command]
async fn save_text_file(app: tauri::AppHandle, file_name: String, content: String) -> Result<bool, String> {
    let picked = app
        .dialog()
        .file()
        .set_file_name(&file_name)
        .add_filter("Markdown", &["md"])
        .blocking_save_file();
    let Some(path) = picked else { return Ok(false) };
    let path = path.into_path().map_err(|e| format!("無法使用這個位置：{e}"))?;
    std::fs::write(&path, content).map_err(|e| format!("無法寫入檔案：{e}"))?;
    Ok(true)
}

/// 視窗只能顯示 App 自己的畫面。回覆裡的連結由畫面攔下、改用系統瀏覽器開；
/// 萬一有漏網的換頁（例如拖進檔案、被誘導的連結），在這裡擋掉。
pub fn is_app_url(url: &Url) -> bool {
    match url.scheme() {
        // macOS／Linux：tauri://localhost
        "tauri" => url.host_str() == Some("localhost") && url.port().is_none(),
        // Windows：http://tauri.localhost（不帶 port）
        "http" | "https" if url.host_str() == Some("tauri.localhost") => cfg!(windows) && url.port().is_none(),
        // 開發模式：Vite 開發伺服器
        "http" if cfg!(debug_assertions) => {
            matches!(url.host_str(), Some("127.0.0.1") | Some("localhost")) && url.port() == Some(5310)
        }
        _ => false,
    }
}

/// 可以交給系統瀏覽器（或郵件程式）開的連結
pub fn is_external_link(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "mailto") && !is_app_url(url)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![get_api_key, set_api_key, remove_api_key, api_key_location, save_text_file])
        .setup(|app| {
            let handle = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("API Chat")
                .inner_size(1180.0, 800.0)
                .min_inner_size(720.0, 520.0)
                // 拖放交給網頁畫面處理（輸入框可以拖檔案進來）
                .disable_drag_drop_handler()
                .on_navigation(|url| is_app_url(url))
                // 不在 App 裡開新視窗（例如中鍵點連結）；一般連結改用系統瀏覽器開
                .on_new_window(move |url, _features| {
                    if is_external_link(&url) {
                        let _ = handle.opener().open_url(url.as_str(), None::<&str>);
                    }
                    NewWindowResponse::Deny
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("API Chat 啟動失敗");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn only_app_pages_can_load() {
        assert!(is_app_url(&url("tauri://localhost/index.html")));
        assert_eq!(is_app_url(&url("http://tauri.localhost/")), cfg!(windows));
        assert!(!is_app_url(&url("http://tauri.localhost:8080/")));
        assert!(!is_app_url(&url("http://tauri.localhost@evil.example/")));
        assert!(!is_app_url(&url("https://evil.example/")));
        assert!(!is_app_url(&url("https://tauri.localhost.evil.example/")));
        assert!(!is_app_url(&url("file:///C:/Users/a/secret.txt")));
        assert!(!is_app_url(&url("tauri://evil/")));
        assert!(!is_app_url(&url("http://127.0.0.1:8080/")));
        assert!(!is_app_url(&url("javascript:alert(1)")));
    }

    #[test]
    fn only_web_and_mail_links_go_to_the_browser() {
        assert!(is_external_link(&url("https://www.anthropic.com/")));
        assert!(is_external_link(&url("mailto:a@example.com")));
        assert!(!is_external_link(&url("file:///etc/passwd")));
        assert!(!is_external_link(&url("javascript:alert(1)")));
        assert!(!is_external_link(&url("smb://server/share")));
        assert!(!is_external_link(&url("tauri://localhost/index.html")));
    }
}
