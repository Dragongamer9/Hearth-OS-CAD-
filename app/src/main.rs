// Hearth OS CAD's window (Tauri: WebKitGTK on Linux). The design, the 3D view and the geometry engine are all in the
// page (ui/, built from web/); this side reads and writes files, lists folders for the page's own file picker, and
// keeps the settings file. `hearth-os-cad FILE` opens a design or a model.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine;
use serde_json::{json, Map, Value};
use std::path::PathBuf;
use tauri::{WebviewUrl, WebviewWindowBuilder};

struct Startup {
    file: Option<PathBuf>,
}

fn b64(b: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(b)
}
fn unb64(s: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD.decode(s).map_err(|_| "That file didn't come through.".to_string())
}

#[tauri::command]
fn init(start: tauri::State<Startup>) -> Value {
    json!({
        "file": start.file,
        "home": hearth_os_cad::home(),
        "models": hearth_os_cad::models_dir(),
        "platform": if cfg!(windows) { "windows" } else { "linux" },
    })
}

#[tauri::command(async)]
fn read_file(path: String) -> Result<String, String> {
    hearth_os_cad::read_file(std::path::Path::new(&path)).map(|b| b64(&b))
}

#[tauri::command(async)]
fn write_file(path: String, data: String) -> Result<(), String> {
    hearth_os_cad::write_file(std::path::Path::new(&path), &unb64(&data)?)
}

#[tauri::command(async)]
fn browse(dir: String) -> Result<Value, String> {
    let (dir, parent, entries) = hearth_os_cad::browse(&dir)?;
    Ok(json!({"dir": dir, "parent": parent, "entries": entries}))
}

#[tauri::command(async)]
fn settings_load() -> Result<Value, String> {
    hearth_os_cad::settings::load().map(Value::Object)
}

#[tauri::command(async)]
fn settings_save(patch: Map<String, Value>) -> Result<Value, String> {
    hearth_os_cad::settings::save(patch).map(Value::Object)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let fullscreen = args.iter().any(|a| a == "--fullscreen");
    let file = args.iter().find(|a| !a.starts_with("--")).map(|a| {
        let a = a.strip_prefix("file://").unwrap_or(a);
        std::fs::canonicalize(a).unwrap_or_else(|_| PathBuf::from(a))
    });
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    tauri::Builder::default()
        .manage(Startup { file })
        .invoke_handler(tauri::generate_handler![init, read_file, write_file, browse, settings_load, settings_save])
        .setup(move |app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Hearth OS CAD")
                .inner_size(1440.0, 900.0)
                .min_inner_size(900.0, 600.0)
                .fullscreen(fullscreen)
                .background_color(tauri::window::Color(47, 50, 55, 255))
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Hearth OS CAD couldn't start");
}
