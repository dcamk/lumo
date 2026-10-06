// Janela do Lumo em modo "overlay" (Tauri 2 + GTK).
//
// O WebKitGTK deixa rastros e "pula" quando a janela transparente muda de tamanho no
// meio de uma animação. Por isso a janela tem um tamanho FIXO (o do painel aberto) e a
// pílula/painel são desenhados e animados dentro dela (anime.js). A parte
// transparente não pode roubar cliques: a "região de entrada" (input shape do X11/GDK)
// é ajustada para o retângulo visível — fora dele, o clique passa para a janela de baixo.
//
// A posição arrastada pelo usuário é salva (centro X + topo) e restaurada ao abrir.
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Position, Size, WebviewWindow};

/// Tamanho inicial (antes de a interface informar o tamanho real)
pub const INITIAL_SIZE: (f64, f64) = (640.0, 300.0);
const MIN_SIZE: (f64, f64) = (160.0, 60.0);
const MAX_SIZE: (f64, f64) = (1100.0, 700.0);

/// Moves causados pelo próprio Lumo não contam como "o usuário arrastou"
static LAST_PROGRAMMATIC_MS: AtomicU64 = AtomicU64::new(0);
/// A interface avisa quando o usuário começa a arrastar a janela; só esses moves são
/// salvos (o GNOME também move a janela sozinho, ex.: para baixo da barra do topo)
static USER_DRAG_MS: AtomicU64 = AtomicU64::new(0);
static MOVE_GENERATION: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[derive(Serialize, Deserialize, Clone, Copy)]
struct SavedPlace {
    /// Centro horizontal e topo, em px lógicos da tela
    center_x: f64,
    y: f64,
}

fn place_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    Some(app.path().app_config_dir().ok()?.join("window.json"))
}

fn load_place(app: &AppHandle) -> Option<SavedPlace> {
    serde_json::from_slice(&std::fs::read(place_file(app)?).ok()?).ok()
}

fn logical_screen(window: &WebviewWindow) -> Option<(f64, f64)> {
    let m = window.current_monitor().ok().flatten().or_else(|| window.primary_monitor().ok().flatten())?;
    let scale = m.scale_factor();
    Some((m.size().width as f64 / scale, m.size().height as f64 / scale))
}

fn set_pos(window: &WebviewWindow, x: f64, y: f64) {
    LAST_PROGRAMMATIC_MS.store(now_ms(), Ordering::Relaxed);
    window.set_position(Position::Logical(LogicalPosition { x, y })).ok();
}

/// Posição salva pelo usuário (presa à tela) ou topo central
pub fn place(window: &WebviewWindow, width: f64) {
    let Some((screen_w, screen_h)) = logical_screen(window) else { return };
    let saved = load_place(window.app_handle());
    let (cx, y) = saved.map(|p| (p.center_x, p.y)).unwrap_or((screen_w / 2.0, 0.0));
    let x = (cx - width / 2.0).clamp(-width / 2.0 + 80.0, screen_w - 80.0 - width / 2.0);
    let y = y.clamp(0.0, (screen_h - 60.0).max(0.0));
    set_pos(window, x, y);
}

/// Chamado em todo WindowEvent::Moved. Se foi o usuário arrastando, salva a posição
/// quando ele para (400 ms sem movimento).
pub fn on_moved(window: &WebviewWindow) {
    if now_ms().saturating_sub(LAST_PROGRAMMATIC_MS.load(Ordering::Relaxed)) < 800 {
        return;
    }
    // Só depois de um "começou a arrastar" recente (até 60 s de arraste)
    if now_ms().saturating_sub(USER_DRAG_MS.load(Ordering::Relaxed)) > 60_000 {
        return;
    }
    let generation = MOVE_GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    let w = window.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(400)).await;
        if MOVE_GENERATION.load(Ordering::Relaxed) != generation {
            return; // ainda arrastando
        }
        let (Ok(pos), Ok(size), Ok(scale)) = (w.outer_position(), w.outer_size(), w.scale_factor()) else { return };
        let (x, y) = (pos.x as f64 / scale, pos.y as f64 / scale);
        let width = size.width as f64 / scale;
        // Perto do topo "gruda" no topo
        let y = if y < 24.0 { 0.0 } else { y };
        let place = SavedPlace { center_x: x + width / 2.0, y };
        if y == 0.0 && (y - pos.y as f64 / scale).abs() > 0.5 {
            set_pos(&w, x, 0.0);
        }
        if let Some(file) = place_file(w.app_handle()) {
            if let Some(dir) = file.parent() {
                std::fs::create_dir_all(dir).ok();
            }
            std::fs::write(file, serde_json::to_vec(&place).unwrap_or_default()).ok();
        }
        USER_DRAG_MS.store(0, Ordering::Relaxed);
    });
}

/// A interface chama ao apertar o botão numa área de arraste
#[tauri::command]
pub fn begin_user_move() {
    USER_DRAG_MS.store(now_ms(), Ordering::Relaxed);
}

/// Esquece a posição arrastada e volta ao topo central
#[tauri::command]
pub fn reset_window_position(app: AppHandle) -> Result<(), String> {
    if let Some(f) = place_file(&app) {
        std::fs::remove_file(f).ok();
    }
    if let Some(w) = app.get_webview_window("main") {
        let width = w.outer_size().ok().map(|s| s.width as f64 / w.scale_factor().unwrap_or(1.0)).unwrap_or(INITIAL_SIZE.0);
        place(&w, width);
    }
    Ok(())
}

#[tauri::command]
pub fn has_saved_position(app: AppHandle) -> bool {
    load_place(&app).is_some()
}

/// Tamanho fixo do overlay (o maior estado: painel aberto). Só muda quando o
/// "Tamanho do Lumo" ou o tamanho do painel mudam — nunca durante uma animação.
#[tauri::command]
pub fn set_overlay_size(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else { return Ok(()) };
    let w = width.clamp(MIN_SIZE.0, MAX_SIZE.0).round();
    let h = height.clamp(MIN_SIZE.1, MAX_SIZE.1).round();
    let current = window.outer_size().ok().zip(window.scale_factor().ok()).map(|(s, k)| (s.width as f64 / k, s.height as f64 / k));
    if current.is_some_and(|(cw, ch)| (cw - w).abs() < 1.0 && (ch - h).abs() < 1.0) {
        return Ok(());
    }
    window.set_resizable(true).ok();
    window.set_min_size(None::<Size>).ok();
    window.set_max_size(None::<Size>).ok();
    // Não volta para "não redimensionável" aqui: o GTK travaria no tamanho antigo
    // antes de o gerenciador de janelas aplicar o novo
    window.set_size(Size::Logical(LogicalSize { width: w, height: h })).map_err(|e| e.to_string())?;
    place(&window, w);
    Ok(())
}

/// Recorta a janela no formato da casca (retângulo com os cantos de baixo
/// arredondados), para cliques E para o que aparece na tela.
///
/// Por que também o desenho: quando uma área da janela transparente volta a ficar
/// transparente (a casca encolhe), o WebKitGTK pinta "transparente por cima" e o que
/// estava ali continua — os rastros. Com a janela recortada a cada quadro da animação,
/// nada fora da casca chega à tela. Px lógicos, relativos à janela.
#[tauri::command]
pub fn set_window_shape(app: AppHandle, x: f64, y: f64, width: f64, height: f64, radius: f64) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let Some(window) = app.get_webview_window("main") else { return Ok(()) };
        let w = window.clone();
        window
            .run_on_main_thread(move || {
                use gtk::prelude::WidgetExt;
                let Ok(gtk_win) = w.gtk_window() else { return };
                let region = rounded_bottom(x, y, width, height, radius);
                gtk_win.shape_combine_region(Some(&region));
                gtk_win.input_shape_combine_region(Some(&region));
                // Repinta a janela inteira: sem isso o que ficou fora da casca pode
                // continuar na tela até o próximo redesenho completo
                gtk_win.queue_draw();
            })
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "linux"))]
    let _ = (app, x, y, width, height, radius);
    Ok(())
}

/// Região = corpo + uma faixa por linha nos cantos de baixo (arredondados)
#[cfg(target_os = "linux")]
fn rounded_bottom(x: f64, y: f64, width: f64, height: f64, radius: f64) -> gtk::cairo::Region {
    let (x, y) = (x.floor() as i32, y.floor() as i32);
    let (w, h) = (width.ceil().max(1.0) as i32, height.ceil().max(1.0) as i32);
    let r = (radius.round() as i32).clamp(0, (w / 2).min(h));
    let mut rects = vec![gtk::cairo::RectangleInt::new(x, y, w, h - r)];
    for j in 0..r {
        let dy = j as f64 + 0.5;
        let rf = r as f64;
        let inset = (rf - (rf * rf - dy * dy).max(0.0).sqrt()).round() as i32;
        rects.push(gtk::cairo::RectangleInt::new(x + inset, y + h - r + j, (w - inset * 2).max(0), 1));
    }
    gtk::cairo::Region::create_rectangles(&rects)
}

#[tauri::command]
pub fn get_screen_bounds(app: AppHandle) -> Result<(f64, f64), String> {
    Ok(app
        .get_webview_window("main")
        .and_then(|w| logical_screen(&w))
        .unwrap_or((1920.0, 1080.0)))
}

#[tauri::command]
pub fn set_always_on_top(app: AppHandle, enabled: bool) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.set_always_on_top(enabled).map_err(|e| e.to_string())?;
    }
    Ok(())
}
