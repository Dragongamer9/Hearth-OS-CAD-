//! Settings that are always remembered and never change by themselves.
//!
//! - One file, `~/.config/hearth-os-cad/settings.json` (`$HEARTH_OS_CAD_SETTINGS` for tests).
//! - Saving merges only the keys that changed into what's on disk, so nothing else is ever lost.
//! - Writes are atomic (temp file, then rename) and the previous good file is kept as `settings.json.bak`.
//! - If the file can't be read as settings, the `.bak` is used; if that fails too, saving refuses rather than
//!   writing defaults over it.

use serde_json::{Map, Value};
use std::path::PathBuf;

pub fn path() -> PathBuf {
    if let Some(p) = std::env::var_os("HEARTH_OS_CAD_SETTINGS") {
        return PathBuf::from(p);
    }
    let conf = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| crate::home().join(".config"));
    conf.join("hearth-os-cad").join("settings.json")
}

fn bak_of(p: &PathBuf) -> PathBuf {
    let mut s = p.clone().into_os_string();
    s.push(".bak");
    PathBuf::from(s)
}

fn parse(bytes: &[u8]) -> Option<Map<String, Value>> {
    match serde_json::from_slice::<Value>(bytes) {
        Ok(Value::Object(m)) => Some(m),
        _ => None,
    }
}

/// What's saved. Ok(empty) when there's no file yet; Err when a file is there but neither it nor its backup can be
/// read (so the caller knows not to save over it).
pub fn load_from(p: &PathBuf) -> Result<Map<String, Value>, String> {
    match std::fs::read(p) {
        Ok(b) => {
            if let Some(m) = parse(&b) {
                return Ok(m);
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return match std::fs::read(bak_of(p)) {
                Ok(b) => parse(&b).ok_or_else(|| "The settings backup can't be read.".to_string()),
                Err(_) => Ok(Map::new()),
            };
        }
        Err(e) => return Err(format!("The settings file can't be read: {e}")),
    }
    match std::fs::read(bak_of(p)) {
        Ok(b) => parse(&b).ok_or_else(|| "The settings file is damaged and so is its backup; they were left as they are.".to_string()),
        Err(_) => Err("The settings file is damaged; it was left as it is.".into()),
    }
}

pub fn load() -> Result<Map<String, Value>, String> {
    load_from(&path())
}

/// Merges `patch` into the saved settings and writes them. Returns everything now saved.
pub fn save_to(p: &PathBuf, patch: Map<String, Value>) -> Result<Map<String, Value>, String> {
    let mut all = load_from(p)?;
    for (k, v) in patch {
        all.insert(k, v);
    }
    let dir = p.parent().ok_or("No folder for settings.")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let text = serde_json::to_vec_pretty(&Value::Object(all.clone())).map_err(|e| e.to_string())?;
    if let Ok(old) = std::fs::read(p) {
        if parse(&old).is_some() {
            let _ = std::fs::write(bak_of(p), &old);
        }
    }
    let tmp = dir.join(".settings.json.tmp");
    std::fs::write(&tmp, &text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, p).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(all)
}

pub fn save(patch: Map<String, Value>) -> Result<Map<String, Value>, String> {
    save_to(&path(), patch)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn obj(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn remembered_merged_and_never_overwritten() {
        let d = std::env::temp_dir().join(format!("hearth-os-cad-settings-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let p = d.join("settings.json");
        assert!(load_from(&p).unwrap().is_empty(), "no file yet");
        save_to(&p, obj(json!({"snap": 1, "style": "edges"}))).unwrap();
        let all = save_to(&p, obj(json!({"snap": 5}))).unwrap();
        assert_eq!(all["style"], "edges", "other settings kept");
        assert_eq!(load_from(&p).unwrap()["snap"], 5);
        assert!(bak_of(&p).exists(), "backup kept");
        // A damaged file: the backup is used, and saving merges into the backup's settings.
        std::fs::write(&p, b"{not json").unwrap();
        assert_eq!(load_from(&p).unwrap()["style"], "edges");
        // Damaged file and damaged backup: refuse to save over them.
        std::fs::write(bak_of(&p), b"also broken").unwrap();
        assert!(load_from(&p).is_err());
        assert!(save_to(&p, obj(json!({"snap": 2}))).is_err());
        assert_eq!(std::fs::read(&p).unwrap(), b"{not json", "left as it was");
        let _ = std::fs::remove_dir_all(&d);
    }
}
