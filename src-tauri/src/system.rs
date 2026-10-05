// Integração com o desktop: ícone na bandeja, atalho global, notificações,
// iniciar com o sistema e log do frontend no terminal / lumo.log.
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt as _;

/// Evento único para a interface: "toggle" | "show" | "mute" | "tab:<aba>"
pub const ACTION_EVENT: &str = "lumo://action";

/// Atalho global padrão para abrir/fechar o painel
pub const TOGGLE_SHORTCUT: &str = "ctrl+alt+l";

pub fn emit_action(app: &AppHandle, action: &str) {
    if let Some(w) = app.get_webview_window("main") {
        w.show().ok();
    }
    app.emit(ACTION_EVENT, action).ok();
}

pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, "toggle", "Abrir / fechar painel (Ctrl+Alt+L)", true, None::<&str>)?;
    let mail = MenuItem::with_id(app, "tab:mail", "E-mails", true, None::<&str>)?;
    let linux = MenuItem::with_id(app, "tab:linux", "Sistema", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "tab:settings", "Configurações…", true, None::<&str>)?;
    let mute = MenuItem::with_id(app, "mute", "Silenciar / ativar som", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Sair do Lumo", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&toggle, &sep, &mail, &linux, &settings, &sep2, &mute, &quit])?;

    let mut tray = TrayIconBuilder::with_id("lumo")
        .tooltip("Lumo")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "quit" => app.exit(0),
            id => emit_action(app, id),
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// Notificação nativa (D-Bus) — funciona no GNOME Wayland também
#[tauri::command]
pub fn notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

// ---- Iniciar com o sistema (XDG autostart) ----------------------------------
// Implementação própria: o plugin oficial grava o caminho sem aspas, o que quebra
// quando ele tem espaços/parênteses (ex.: "minha pasta (1)").

fn autostart_file() -> Option<std::path::PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| std::path::Path::new(&h).join(".config")))?;
    Some(base.join("autostart").join("Lumo.desktop"))
}

/// Aspas no padrão Desktop Entry: "…" escapando " ` $ \
fn quote_exec(path: &str) -> String {
    let mut q = String::from("\"");
    for c in path.chars() {
        if matches!(c, '"' | '`' | '$' | '\\') {
            q.push('\\');
        }
        q.push(c);
    }
    q.push('"');
    q
}

/// Executável estável para o autostart e para o atalho do GNOME.
/// AppImage → $APPIMAGE · pacote instalado → ele mesmo · rodando da pasta do projeto
/// → prefere o instalado em /usr/bin. O binário de debug NUNCA serve: ele carrega a
/// interface de http://localhost:1420 (npm run desktop) e, sem o servidor, mostra só
/// uma página de erro — era isso que aparecia ao ligar o PC.
pub fn stable_exe() -> Result<String, String> {
    if let Ok(p) = std::env::var("APPIMAGE") {
        if !p.is_empty() {
            return Ok(p);
        }
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe = exe.to_string_lossy().into_owned();
    let in_project = exe.contains("/target/debug/") || exe.contains("/target/release/");
    if !in_project {
        return Ok(exe);
    }
    for c in ["/usr/bin/lumo-assistant", "/usr/local/bin/lumo-assistant"] {
        if std::path::Path::new(c).is_file() {
            return Ok(c.to_string());
        }
    }
    if exe.contains("/target/release/") {
        return Ok(exe); // o binário de release já embute a interface
    }
    Err("Instale o Lumo (./install.sh ou o .deb) para iniciar com o sistema — a versão de desenvolvimento depende do `npm run desktop`.".into())
}

fn write_autostart() -> Result<(), String> {
    let file = autostart_file().ok_or("pasta de configuração não encontrada")?;
    let exe = stable_exe()?;
    // Delay: a bandeja e o compositor ficam prontos antes do Lumo aparecer
    let content = format!(
        "[Desktop Entry]\nType=Application\nName=Lumo\nComment=Assistente de foco Lumo\nExec={} --autostart\nIcon=lumo-assistant\nTerminal=false\nStartupNotify=false\nX-GNOME-Autostart-enabled=true\nX-GNOME-Autostart-Delay=3\n",
        quote_exec(&exe)
    );
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&file, content).map_err(|e| e.to_string())
}

/// Se o autostart estiver ligado, regrava apontando para o executável estável.
/// Uma entrada antiga apontando para o binário de debug é removida se não houver
/// alternativa (ela só mostraria a página de erro no login).
pub fn refresh_autostart() {
    let Some(file) = autostart_file().filter(|f| f.exists()) else { return };
    if write_autostart().is_err() {
        let broken = std::fs::read_to_string(&file).map(|c| c.contains("/target/debug/")).unwrap_or(false);
        if broken {
            std::fs::remove_file(&file).ok();
        }
    }
}

#[tauri::command]
pub fn get_autostart() -> bool {
    autostart_file().is_some_and(|f| f.exists())
}

#[tauri::command]
pub fn set_autostart(enabled: bool) -> Result<bool, String> {
    if enabled {
        write_autostart()?;
    } else if let Some(f) = autostart_file().filter(|f| f.exists()) {
        std::fs::remove_file(f).map_err(|e| e.to_string())?;
    }
    Ok(get_autostart())
}

// ---- Atalho de teclado no GNOME ------------------------------------------------
// No GNOME o atalho global do X11 (Ctrl+Alt+L) só funciona com uma janela X11 em foco.
// Um atalho personalizado do próprio GNOME funciona sempre: ele roda
// `lumo-assistant --toggle`, e a instância aberta recebe o pedido (single-instance).

const MEDIA_KEYS: &str = "org.gnome.settings-daemon.plugins.media-keys";
const CUSTOM_KEY: &str = "org.gnome.settings-daemon.plugins.media-keys.custom-keybinding";
const LUMO_KEY_PATH: &str = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/lumo/";
/// Mesmo atalho, no formato do GNOME
pub const GNOME_BINDING: &str = "<Control><Alt>l";

fn gsettings(args: &[&str]) -> Option<String> {
    let out = std::process::Command::new("gsettings").args(args).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// String no formato GVariant ('…'): sem isso o gsettings tenta interpretar o valor
/// (ex.: `"/usr/bin/x" --toggle` vira uma string seguida de lixo e é recusado)
fn gvariant_str(v: &str) -> String {
    format!("'{}'", v.replace('\\', "\\\\").replace('\'', "\\'"))
}

fn custom_paths() -> Option<Vec<String>> {
    let raw = gsettings(&["get", MEDIA_KEYS, "custom-keybindings"])?;
    // "@as []" ou "['/org/…/custom0/', '/org/…/lumo/']"
    Some(
        raw.trim_start_matches("@as")
            .trim()
            .trim_start_matches('[')
            .trim_end_matches(']')
            .split(',')
            .map(|s| s.trim().trim_matches('\'').to_string())
            .filter(|s| !s.is_empty())
            .collect(),
    )
}

pub fn is_gnome() -> bool {
    std::env::var("XDG_CURRENT_DESKTOP").map(|v| v.to_uppercase().contains("GNOME")).unwrap_or(false)
}

/// O atalho do GNOME para o Lumo existe
pub fn gnome_shortcut_installed() -> bool {
    custom_paths().is_some_and(|p| p.iter().any(|x| x == LUMO_KEY_PATH))
}

fn set_gnome_shortcut(enabled: bool) -> Result<(), String> {
    let mut paths = custom_paths().ok_or("gsettings indisponível (não é GNOME?)")?;
    paths.retain(|p| p != LUMO_KEY_PATH);
    if enabled {
        let exe = stable_exe().or_else(|_| {
            std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).map_err(|e| e.to_string())
        })?;
        let schema = format!("{}:{}", CUSTOM_KEY, LUMO_KEY_PATH);
        let command = format!("{} --toggle", quote_exec(&exe));
        for (k, v) in [("name", "Lumo: abrir / fechar painel"), ("command", command.as_str()), ("binding", GNOME_BINDING)] {
            gsettings(&["set", &schema, k, &gvariant_str(v)]).ok_or("não consegui gravar o atalho")?;
        }
        paths.push(LUMO_KEY_PATH.to_string());
    }
    let list = format!("[{}]", paths.iter().map(|p| format!("'{}'", p)).collect::<Vec<_>>().join(", "));
    gsettings(&["set", MEDIA_KEYS, "custom-keybindings", &list]).ok_or("não consegui gravar a lista de atalhos")?;
    Ok(())
}

/// Na primeira execução no GNOME cria o atalho; depois só mantém o caminho do
/// executável atualizado (ex.: troca do binário de dev pelo instalado).
pub fn ensure_gnome_shortcut(app: &AppHandle) {
    if !is_gnome() {
        return;
    }
    let Ok(dir) = app.path().app_config_dir() else { return };
    let marker = dir.join("gnome-shortcut-setup");
    if gnome_shortcut_installed() || !marker.exists() {
        if set_gnome_shortcut(true).is_ok() {
            std::fs::create_dir_all(&dir).ok();
            std::fs::write(&marker, "1").ok();
        }
    }
}

#[derive(serde::Serialize)]
pub struct ShortcutStatus {
    pub gnome: bool,
    pub installed: bool,
    pub binding: String,
}

#[tauri::command]
pub fn shortcut_status() -> ShortcutStatus {
    ShortcutStatus { gnome: is_gnome(), installed: is_gnome() && gnome_shortcut_installed(), binding: "Ctrl+Alt+L".into() }
}

#[tauri::command]
pub fn set_shortcut(enabled: bool) -> Result<ShortcutStatus, String> {
    set_gnome_shortcut(enabled)?;
    Ok(shortcut_status())
}

/// O console do WebView não aparece no binário instalado: diagnósticos vão para o stdout
#[tauri::command]
pub fn frontend_log(message: String) {
    println!("[Lumo/ui] {}", message);
}
