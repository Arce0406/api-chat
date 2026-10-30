//! API 金鑰存在作業系統的鑰匙圈（macOS 鑰匙圈、Windows 認證管理員），不存在檔案或網頁資料裡。

use keyring_core::{Entry, Error};

pub const SERVICE: &str = "io.github.arce0406.apichat";
pub const ACCOUNT: &str = "anthropic-api-key";

/// 啟動時選定這個平台的鑰匙圈。不支援的平台（例如 Linux 開發版）回傳原因，介面會顯示出來。
pub fn init() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let store = apple_native_keyring_store::keychain::Store::new().map_err(describe)?;
        keyring_core::set_default_store(store);
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        let store = windows_native_keyring_store::Store::new().map_err(describe)?;
        keyring_core::set_default_store(store);
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        // 開發版在 Linux 上做畫面測試用：存在記憶體，關掉就消失。正式版不會編進這段。
        #[cfg(debug_assertions)]
        if std::env::var("API_CHAT_DEV_MEMORY_KEYCHAIN").as_deref() == Ok("1") {
            keyring_core::set_default_store(keyring_core::mock::Store::new().map_err(describe)?);
            return Ok(());
        }
        Err("這個作業系統的鑰匙圈還不支援，目前只支援 Windows 與 macOS。".into())
    }
}

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT).map_err(describe)
}

pub fn get() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(Error::NoEntry) => Ok(None),
        Err(error) => Err(describe(error)),
    }
}

pub fn set(key: &str) -> Result<(), String> {
    entry()?.set_password(key).map_err(describe)
}

pub fn remove() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(error) => Err(describe(error)),
    }
}

/// 錯誤訊息只帶原因，不帶金鑰內容
fn describe(error: Error) -> String {
    match error {
        Error::NoDefaultStore => "鑰匙圈還沒準備好，請重新開啟 App。".into(),
        Error::NoStorageAccess(_) => "無法存取系統鑰匙圈，請確認有允許 API Chat 使用鑰匙圈。".into(),
        other => format!("系統鑰匙圈回傳錯誤：{other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 用 keyring-core 內建的 mock 鑰匙圈測流程；真正的 macOS／Windows 鑰匙圈要在實機確認
    #[test]
    fn set_get_remove_round_trip() {
        keyring_core::set_default_store(keyring_core::mock::Store::new().unwrap());
        assert_eq!(get().unwrap(), None);
        set("sk-ant-test-1").unwrap();
        assert_eq!(get().unwrap().as_deref(), Some("sk-ant-test-1"));
        set("sk-ant-test-2").unwrap();
        assert_eq!(get().unwrap().as_deref(), Some("sk-ant-test-2"));
        remove().unwrap();
        assert_eq!(get().unwrap(), None);
        // 沒有金鑰時刪除也算成功
        remove().unwrap();
        keyring_core::unset_default_store();
    }
}
