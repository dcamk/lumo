// Posição global do cursor para os olhos do Lumo seguirem o mouse na tela toda.
//
// Fontes, em ordem:
//   1. Extensão do GNOME Shell "lumo-cursor@lumo.app" (D-Bus org.lumo.Cursor) —
//      única forma de saber onde o mouse está no GNOME Wayland sobre qualquer app.
//   2. X11 (XQueryPointer via `mouse_position`) — funciona na sessão Xorg; no
//      Wayland só é atualizada quando o mouse passa sobre janelas X11.
use serde::Serialize;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

pub const EXT_UUID: &str = "lumo-cursor@lumo.app";
const EXT_JS: &str = include_str!("../gnome-extension/extension.js");
const EXT_METADATA: &str = include_str!("../gnome-extension/metadata.json");

const DBUS_NAME: &str = "org.lumo.Cursor";
const DBUS_PATH: &str = "/org/lumo/Cursor";

/// Depois de uma falha da extensão, só tenta de novo após este intervalo
const EXT_RETRY_MS: u64 = 5000;
static EXT_FAILED_AT: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub(crate) fn session_bus() -> Option<&'static zbus::blocking::Connection> {
    static CONN: OnceLock<Option<zbus::blocking::Connection>> = OnceLock::new();
    CONN.get_or_init(|| zbus::blocking::Connection::session().ok()).as_ref()
}

/// Posição pela extensão do GNOME (px lógicos da tela)
fn from_extension() -> Option<(f64, f64)> {
    if now_ms().saturating_sub(EXT_FAILED_AT.load(Ordering::Relaxed)) < EXT_RETRY_MS {
        return None;
    }
    let pos = session_bus().and_then(|conn| {
        let reply = conn
            .call_method(Some(DBUS_NAME), DBUS_PATH, Some(DBUS_NAME), "GetPosition", &())
            .ok()?;
        reply.body().deserialize::<(i32, i32)>().ok()
    });
    match pos {
        Some((x, y)) => Some((x as f64, y as f64)),
        None => {
            EXT_FAILED_AT.store(now_ms(), Ordering::Relaxed);
            None
        }
    }
}

/// Posição pelo X11 (px físicos da tela)
fn from_x11() -> Option<(f64, f64)> {
    use mouse_position::mouse_position::Mouse;
    match Mouse::get_mouse_position() {
        Mouse::Position { x, y } => Some((x as f64, y as f64)),
        Mouse::Error => None,
    }
}

/// Cursor em px lógicos RELATIVOS à área da janela (igual a clientX/Y do JS),
/// mesmo com o mouse fora dela.
#[tauri::command]
pub async fn get_cursor_in_window(app: AppHandle) -> Result<(f64, f64), String> {
    let window = app.get_webview_window("main").ok_or("janela indisponível")?;
    let origin = window.inner_position().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let (ox, oy) = (origin.x as f64 / scale, origin.y as f64 / scale);

    // D-Bus/X11 bloqueiam: fora da thread principal
    let found = tauri::async_runtime::spawn_blocking(|| {
        from_extension().map(|p| (p, true)).or_else(|| from_x11().map(|p| (p, false)))
    })
    .await
    .map_err(|e| e.to_string())?;

    match found {
        Some(((x, y), true)) => Ok((x - ox, y - oy)),
        Some(((x, y), false)) => Ok((x / scale - ox, y / scale - oy)),
        None => Err("cursor indisponível".into()),
    }
}

// ---- Instalação da extensão ----------------------------------------------------

#[derive(Serialize)]
pub struct ExtensionStatus {
    /// "gnome-wayland" | "gnome-x11" | "outro"
    pub session: String,
    pub installed: bool,
    pub enabled: bool,
    /// A extensão está rodando agora (respondeu no D-Bus)
    pub active: bool,
}

fn extension_dir() -> Option<std::path::PathBuf> {
    let data = std::env::var_os("XDG_DATA_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| std::path::Path::new(&h).join(".local/share")))?;
    Some(data.join("gnome-shell/extensions").join(EXT_UUID))
}

/// Lê a lista de extensões habilitadas do GNOME ("['a', 'b']" ou "@as []")
fn enabled_extensions() -> Vec<String> {
    let out = Command::new("gsettings")
        .args(["get", "org.gnome.shell", "enabled-extensions"])
        .output();
    let Ok(out) = out else { return vec![] };
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .trim_start_matches("@as")
        .trim()
        .trim_matches(|c| c == '[' || c == ']')
        .split(',')
        .map(|s| s.trim().trim_matches('\'').to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn session_kind() -> String {
    let desktop = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default().to_uppercase();
    if !desktop.contains("GNOME") {
        return "outro".into();
    }
    match std::env::var("XDG_SESSION_TYPE").as_deref() {
        Ok("wayland") => "gnome-wayland".into(),
        _ => "gnome-x11".into(),
    }
}

#[tauri::command]
pub async fn cursor_extension_status() -> ExtensionStatus {
    tauri::async_runtime::spawn_blocking(|| {
        EXT_FAILED_AT.store(0, Ordering::Relaxed); // força uma tentativa agora
        ExtensionStatus {
            session: session_kind(),
            installed: extension_dir().is_some_and(|d| d.join("extension.js").exists()),
            enabled: enabled_extensions().iter().any(|e| e == EXT_UUID),
            active: from_extension().is_some(),
        }
    })
    .await
    .unwrap_or(ExtensionStatus { session: "outro".into(), installed: false, enabled: false, active: false })
}

/// Copia a extensão para ~/.local/share/gnome-shell/extensions e a habilita.
/// No Wayland o GNOME só carrega extensões novas depois de sair e entrar na sessão.
#[tauri::command]
pub async fn install_cursor_extension() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let dir = extension_dir().ok_or("pasta de dados do usuário não encontrada")?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        std::fs::write(dir.join("extension.js"), EXT_JS).map_err(|e| e.to_string())?;
        std::fs::write(dir.join("metadata.json"), EXT_METADATA).map_err(|e| e.to_string())?;

        // Caminho oficial; falha se o Shell ainda não "viu" a extensão (Wayland)
        let enabled_now = Command::new("gnome-extensions")
            .args(["enable", EXT_UUID])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);

        if !enabled_now {
            // Deixa habilitada para o próximo login
            let mut list = enabled_extensions();
            if !list.iter().any(|e| e == EXT_UUID) {
                list.push(EXT_UUID.to_string());
                let value = format!(
                    "[{}]",
                    list.iter().map(|e| format!("'{}'", e)).collect::<Vec<_>>().join(", ")
                );
                Command::new("gsettings")
                    .args(["set", "org.gnome.shell", "enabled-extensions", &value])
                    .status()
                    .map_err(|e| e.to_string())?;
            }
        }

        EXT_FAILED_AT.store(0, Ordering::Relaxed);
        Ok(if from_extension().is_some() {
            "Extensão ativa: os olhos já seguem o cursor na tela toda.".to_string()
        } else {
            "Extensão instalada. Saia da sessão e entre de novo para o GNOME carregá-la.".to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
