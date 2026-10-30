//! API 金鑰存在使用者資料夾的一個檔案（只有自己的帳號能讀），和命令列工具 ai-call、use-api 共用。
//! 位置與格式和 cli/shared/key-file.ts 相同：預設 ~/.config/api-chat/anthropic.env，內容一行 ANTHROPIC_API_KEY=<金鑰>。

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub const KEY_VARIABLE: &str = "ANTHROPIC_API_KEY";

/// API_CHAT_KEY_FILE 可指定完整路徑；否則 $XDG_CONFIG_HOME/api-chat/anthropic.env，再否則 ~/.config/api-chat/anthropic.env
pub fn key_file_path(env: impl Fn(&str) -> Option<String>, home: &Path) -> PathBuf {
    if let Some(path) = env("API_CHAT_KEY_FILE").filter(|v| !v.is_empty()) {
        return PathBuf::from(path);
    }
    let config_home = env("XDG_CONFIG_HOME").filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(|| home.join(".config"));
    config_home.join("api-chat").join("anthropic.env")
}

/// 解析 KEY=VALUE（忽略空行、# 註解、export 前綴、成對引號），和命令列工具的 parseEnvFile 相同
fn parse_value(content: &str, variable: &str) -> Option<String> {
    let mut found = None;
    // 記事本、PowerShell 存成「UTF-8 含 BOM」時開頭會多一個看不見的字元
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    for raw in content.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = match line.strip_prefix("export") {
            Some(rest) if rest.starts_with(char::is_whitespace) => rest.trim_start(),
            _ => line,
        };
        let Some((name, value)) = line.split_once('=') else { continue };
        if name.trim() != variable {
            continue;
        }
        let mut value = value.trim();
        if value.len() >= 2 {
            let first = value.as_bytes()[0];
            if (first == b'"' || first == b'\'') && value.as_bytes()[value.len() - 1] == first {
                value = &value[1..value.len() - 1];
            }
        }
        found = Some(value.to_string());
    }
    found.filter(|v| !v.is_empty())
}

fn is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path).map(|m| m.file_type().is_symlink()).unwrap_or(false)
}

pub fn read(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(content) => Ok(parse_value(&content, KEY_VARIABLE)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) if e.kind() == std::io::ErrorKind::InvalidData => {
            Err(format!("金鑰檔 {} 不是 UTF-8 文字檔", path.display()))
        }
        Err(e) => Err(format!("讀不到金鑰檔 {}：{e}", path.display())),
    }
}

pub fn write(path: &Path, key: &str) -> Result<(), String> {
    // 只接受可見的 ASCII，避免換行等字元寫進檔案變成別的設定
    if key.is_empty() || !key.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
        return Err("金鑰格式不正確。".into());
    }
    // 連結通常指向使用者另外管理的機密檔，不替使用者覆寫（和 use-api setup 相同）
    if is_symlink(path) {
        return Err(format!("{} 是連結，請直接修改它指向的檔案。", path.display()));
    }
    if let Some(dir) = path.parent() {
        create_private_dir(dir).map_err(|e| format!("無法建立資料夾 {}：{e}", dir.display()))?;
    }
    // 先寫到暫存檔再改名蓋過去：中途出錯也不會留下空的金鑰檔
    let temp = path.with_extension(format!("env.tmp-{}", std::process::id()));
    let result = write_private_file(&temp, &format!("{KEY_VARIABLE}={key}\n")).and_then(|()| fs::rename(&temp, path));
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.map_err(|e| format!("無法寫入 {}：{e}", path.display()))
}

/// 刪除金鑰檔；是連結時只刪連結本身。原本就沒有也算成功。
pub fn remove(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("無法刪除 {}：{e}", path.display())),
    }
}

#[cfg(unix)]
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)
}

#[cfg(not(unix))]
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    // Windows：使用者資料夾底下的檔案預設只有自己的帳號（和系統管理員）能讀
    fs::create_dir_all(dir)
}

#[cfg(unix)]
fn write_private_file(path: &Path, content: &str) -> std::io::Result<()> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let mut file = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path)?;
    // 檔案原本就存在時，mode 不會套用，另外改一次
    file.set_permissions(fs::Permissions::from_mode(0o600))?;
    file.write_all(content.as_bytes())
}

#[cfg(not(unix))]
fn write_private_file(path: &Path, content: &str) -> std::io::Result<()> {
    let mut file = fs::OpenOptions::new().write(true).create(true).truncate(true).open(path)?;
    file.write_all(content.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("api-chat-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn path_follows_override_then_xdg_then_home() {
        let home = Path::new("/home/u");
        let none = |_: &str| None;
        assert_eq!(key_file_path(none, home), PathBuf::from("/home/u/.config/api-chat/anthropic.env"));
        let xdg = |k: &str| (k == "XDG_CONFIG_HOME").then(|| "/x".to_string());
        assert_eq!(key_file_path(xdg, home), PathBuf::from("/x/api-chat/anthropic.env"));
        let empty_xdg = |k: &str| (k == "XDG_CONFIG_HOME").then(String::new);
        assert_eq!(key_file_path(empty_xdg, home), PathBuf::from("/home/u/.config/api-chat/anthropic.env"));
        let file = |k: &str| (k == "API_CHAT_KEY_FILE").then(|| "/k.env".to_string());
        assert_eq!(key_file_path(file, home), PathBuf::from("/k.env"));
    }

    #[test]
    fn parses_like_the_command_line_tools() {
        assert_eq!(parse_value("ANTHROPIC_API_KEY=sk-a\n", KEY_VARIABLE).as_deref(), Some("sk-a"));
        assert_eq!(parse_value("# c\nexport ANTHROPIC_API_KEY='sk-b'\n", KEY_VARIABLE).as_deref(), Some("sk-b"));
        assert_eq!(parse_value("ANTHROPIC_API_KEY = \"sk-c\"\r\n", KEY_VARIABLE).as_deref(), Some("sk-c"));
        assert_eq!(parse_value("OTHER=1\nANTHROPIC_API_KEY=\n", KEY_VARIABLE), None);
        assert_eq!(parse_value("ANTHROPIC_API_KEY_OLD=x\n", KEY_VARIABLE), None);
        assert_eq!(parse_value("\u{feff}ANTHROPIC_API_KEY=sk-bom\r\n", KEY_VARIABLE).as_deref(), Some("sk-bom"));
        assert_eq!(parse_value("export\tANTHROPIC_API_KEY=sk-tab\n", KEY_VARIABLE).as_deref(), Some("sk-tab"));
        assert_eq!(parse_value("exportANTHROPIC_API_KEY=x\n", KEY_VARIABLE), None);
        assert_eq!(parse_value("ANTHROPIC_API_KEY=a=b\nANTHROPIC_API_KEY=sk-last\n", KEY_VARIABLE).as_deref(), Some("sk-last"));
    }

    #[test]
    fn write_read_remove_round_trip() {
        let dir = temp_dir("roundtrip");
        let path = dir.join("nested").join("anthropic.env");
        assert_eq!(read(&path).unwrap(), None);
        write(&path, "sk-ant-test-1").unwrap();
        assert_eq!(read(&path).unwrap().as_deref(), Some("sk-ant-test-1"));
        write(&path, "sk-ant-test-2").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "ANTHROPIC_API_KEY=sk-ant-test-2\n");
        remove(&path).unwrap();
        assert_eq!(read(&path).unwrap(), None);
        remove(&path).unwrap();
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn unreadable_file_is_reported_not_treated_as_missing() {
        let dir = temp_dir("utf16");
        let path = dir.join("anthropic.env");
        // Windows PowerShell 5.1 用 > 寫出的 UTF-16
        let utf16: Vec<u8> = "ANTHROPIC_API_KEY=sk".encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        fs::write(&path, [&[0xff, 0xfe][..], &utf16].concat()).unwrap();
        assert!(read(&path).unwrap_err().contains("不是 UTF-8"));
        // 重新輸入金鑰會覆寫成正常的檔案，暫存檔不會留下
        write(&path, "sk-ant-fixed").unwrap();
        assert_eq!(read(&path).unwrap().as_deref(), Some("sk-ant-fixed"));
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_keys_that_could_inject_lines() {
        let dir = temp_dir("inject");
        let path = dir.join("anthropic.env");
        assert!(write(&path, "sk-a\nOTHER=1").is_err());
        assert!(write(&path, "sk a").is_err());
        assert!(write(&path, "").is_err());
        assert!(!path.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn file_is_private_and_symlinks_are_not_overwritten() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("perm");
        let path = dir.join("private").join("anthropic.env");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "x").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        write(&path, "sk-ant-x").unwrap();
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        let fresh = dir.join("fresh").join("anthropic.env");
        write(&fresh, "sk-ant-y").unwrap();
        assert_eq!(fs::metadata(fresh.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);

        let target = dir.join("real.env");
        fs::write(&target, "ANTHROPIC_API_KEY=sk-real\n").unwrap();
        let link = dir.join("link.env");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert_eq!(read(&link).unwrap().as_deref(), Some("sk-real"));
        assert!(write(&link, "sk-new").is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "ANTHROPIC_API_KEY=sk-real\n");
        remove(&link).unwrap();
        assert!(target.exists(), "刪除連結不能刪到它指向的檔案");
        fs::remove_dir_all(dir).unwrap();
    }
}
