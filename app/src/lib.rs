//! Hearth OS CAD without the window: reading and writing model files (as bytes; the page does the geometry), the
//! folder listing for the page's own file picker, and the settings file.

pub mod settings;

use serde::Serialize;
use std::path::{Path, PathBuf};

/// Big scans can be large, but past this the window would struggle to hold them.
pub const MAX_FILE_BYTES: u64 = 768 * 1024 * 1024;

pub fn home() -> PathBuf {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from).unwrap_or_else(std::env::temp_dir)
}

/// Where designs and models go first: ~/Models if it's there, then ~/Documents, then home.
pub fn models_dir() -> PathBuf {
    for d in ["Models", "Documents"] {
        let p = home().join(d);
        if p.is_dir() {
            return p;
        }
    }
    home()
}

pub fn read_file(path: &Path) -> Result<Vec<u8>, String> {
    let m = std::fs::metadata(path).map_err(|_| "That file isn't there.".to_string())?;
    if !m.is_file() {
        return Err("That isn't a file.".into());
    }
    if m.len() > MAX_FILE_BYTES {
        return Err("That file is too big to open.".into());
    }
    std::fs::read(path).map_err(|e| e.to_string())
}

/// Writes a whole file in one go: to a hidden file next to it first, then swapped in, so a crash or a full disk
/// never leaves half a file behind. Never writes over a folder.
pub fn write_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if path.is_dir() {
        return Err("That's a folder.".into());
    }
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).filter(|n| !n.is_empty()).ok_or("Give the file a name.")?;
    let parent = path.parent().filter(|p| !p.as_os_str().is_empty()).ok_or("Pick a folder to save in.")?;
    if !parent.is_dir() {
        return Err("That folder isn't there.".into());
    }
    let tmp = parent.join(format!(".{name}.hearth-os-cad-tmp"));
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

#[derive(Serialize, Debug)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub dir: bool,
    pub size: u64,
}

/// A folder for the page's file picker: folders first, then files (hidden ones left out). The page filters by type.
pub fn browse(dir: &str) -> Result<(String, Option<String>, Vec<Entry>), String> {
    let d = if dir.trim().is_empty() { models_dir() } else { PathBuf::from(dir.trim()) };
    let d = std::fs::canonicalize(&d).map_err(|_| "That folder isn't there.".to_string())?;
    if !d.is_dir() {
        return Err("That isn't a folder.".into());
    }
    let mut v: Vec<Entry> = std::fs::read_dir(&d)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                return None;
            }
            let p = e.path();
            let md = std::fs::metadata(&p).ok()?;
            Some(Entry { name, path: p.display().to_string(), dir: md.is_dir(), size: if md.is_file() { md.len() } else { 0 } })
        })
        .collect();
    v.sort_by(|a, b| (!a.dir, a.name.to_lowercase()).cmp(&(!b.dir, b.name.to_lowercase())));
    Ok((d.display().to_string(), d.parent().map(|p| p.display().to_string()), v))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("hearth-os-cad-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn files_round_trip() {
        let d = tmpdir("files");
        write_file(&d.join("a.stl"), b"solid x").unwrap();
        assert_eq!(read_file(&d.join("a.stl")).unwrap(), b"solid x");
        write_file(&d.join("a.stl"), b"solid y").unwrap();
        assert_eq!(read_file(&d.join("a.stl")).unwrap(), b"solid y");
        assert!(write_file(&d, b"x").is_err(), "over a folder");
        assert!(write_file(&d.join("missing/a.stl"), b"x").is_err());
        assert!(read_file(&d.join("nope.stl")).is_err());
        std::fs::create_dir_all(d.join("sub")).unwrap();
        std::fs::write(d.join(".hidden"), b"x").unwrap();
        let (_, _, e) = browse(&d.display().to_string()).unwrap();
        let names: Vec<_> = e.iter().map(|x| x.name.as_str()).collect();
        assert_eq!(names, vec!["sub", "a.stl"]);
        assert!(!d.read_dir().unwrap().flatten().any(|e| e.file_name().to_string_lossy().contains("tmp")), "no temp files left");
        let _ = std::fs::remove_dir_all(&d);
    }
}
