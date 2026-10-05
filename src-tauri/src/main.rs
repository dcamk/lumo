#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent;
mod api;
mod audio;
mod cursor;
mod focus;
mod google;
mod linux;
mod secret;
mod system;
mod terminal;
mod window;

use std::time::Duration;
use tauri::Manager;

/// Pedido vindo da linha de comando: `--toggle`, `--tab=<aba>` (ações do menu de apps)
/// ou `--ask=<pedido>` / `--ask <pedido>` (abre o chat e envia — bom para atalhos)
fn cli_action(args: &[String]) -> Option<String> {
    if args.iter().any(|a| a == "--toggle") {
        return Some("toggle".into());
    }
    if let Some(i) = args.iter().position(|a| a == "--ask" || a.starts_with("--ask=")) {
        let text = match args[i].strip_prefix("--ask=") {
            Some(t) => t.to_string(),
            None => args[i + 1..].join(" "),
        };
        if !text.trim().is_empty() {
            return Some(format!("ask:{}", text.trim()));
        }
    }
    args.iter()
        .find_map(|a| a.strip_prefix("--tab="))
        .filter(|t| matches!(*t, "tasks" | "focus" | "chat" | "mail" | "linux" | "settings"))
        .map(|t| format!("tab:{}", t))
}

/// Ajustes de ambiente que precisam acontecer ANTES do GTK/WebKit iniciar.
fn prepare_linux_env() {
    #[cfg(target_os = "linux")]
    {
        let unset = |k: &str| std::env::var_os(k).is_none();

        // Wayland não deixa o app posicionar a própria janela (nem "sempre no topo").
        // Rodando via XWayland o Lumo nasce no topo central e fica acima das janelas.
        // Para manter Wayland nativo: LUMO_WAYLAND=1
        let wayland = std::env::var("XDG_SESSION_TYPE").map(|v| v == "wayland").unwrap_or(false);
        if wayland && unset("GDK_BACKEND") && std::env::var("LUMO_WAYLAND").as_deref() != Ok("1") {
            std::env::set_var("GDK_BACKEND", "x11");
        }

        // O renderizador DMABUF do WebKitGTK (2.42+) quebra janelas transparentes em
        // muitas GPUs (fundo preto, rastros ao redimensionar).
        if unset("WEBKIT_DISABLE_DMABUF_RENDERER") {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }

        // Último recurso para drivers problemáticos: LUMO_SAFE_RENDER=1
        // (desliga a composição acelerada do WebKit).
        if std::env::var("LUMO_SAFE_RENDER").as_deref() == Ok("1") && unset("WEBKIT_DISABLE_COMPOSITING_MODE") {
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        }
    }
}

fn main() {
    prepare_linux_env();

    tauri::Builder::default()
        // Precisa ser o primeiro plugin: uma segunda execução não abre outro Lumo,
        // só repassa o pedido. `lumo-assistant --toggle` abre/fecha o painel
        // (útil para criar um atalho de teclado no GNOME Wayland).
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let action = cli_action(&args).unwrap_or_else(|| "show".into());
            system::emit_action(app, &action);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        system::emit_action(app, "toggle");
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            window::set_overlay_size,
            window::set_window_shape,
            window::reset_window_position,
            window::begin_user_move,
            window::has_saved_position,
            window::get_screen_bounds,
            audio::play_sound,
            audio::audio_backend,
            agent::agent_run,
            agent::agent_approve,
            agent::agent_cancel,
            agent::inspect_paths,
            terminal::term_open,
            terminal::term_write,
            terminal::term_resize,
            terminal::term_close,
            cursor::get_cursor_in_window,
            cursor::cursor_extension_status,
            cursor::install_cursor_extension,
            google::google_status,
            google::google_set_client,
            google::google_connect,
            google::google_disconnect,
            google::gmail_unread,
            google::drive_upload,
            focus::set_focus_dnd,
            window::set_always_on_top,
            secret::get_stored_api_key,
            secret::save_stored_api_key,
            api::dispatch_ai_stream,
            api::list_models,
            api::ollama_models,
            linux::system_stats,
            linux::system_info,
            linux::media_status,
            linux::media_control,
            linux::run_command,
            linux::open_url,
            system::notify,
            system::get_autostart,
            system::set_autostart,
            system::shortcut_status,
            system::set_shortcut,
            system::frontend_log
        ])
        .setup(|app| {
            system::build_tray(app.handle()).ok();
            system::refresh_autostart();
            // GNOME: atalho do próprio sistema (funciona com qualquer app em foco).
            // Se ele existe, o atalho do X11 fica de fora para não abrir e fechar duas vezes.
            system::ensure_gnome_shortcut(app.handle());
            if !(system::is_gnome() && system::gnome_shortcut_installed()) {
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                if let Err(e) = app.global_shortcut().register(system::TOGGLE_SHORTCUT) {
                    eprintln!("[Lumo] atalho {} indisponível: {}", system::TOGGLE_SHORTCUT, e);
                }
            }

            let Some(win) = app.get_webview_window("main") else {
                return Ok(());
            };

            // Libera o Web Audio sem exigir gesto do usuário (WebKitGTK)
            #[cfg(target_os = "linux")]
            win.with_webview(|webview| {
                use webkit2gtk::{SettingsExt, WebViewExt};
                if let Some(settings) = WebViewExt::settings(&webview.inner()) {
                    settings.set_enable_webaudio(true);
                    settings.set_media_playback_requires_user_gesture(false);
                }
            })
            .ok();

            // Sempre no topo por padrão. Desative com LUMO_ALWAYS_ON_TOP=0
            let aot = std::env::var("LUMO_ALWAYS_ON_TOP")
                .map(|v| !(v == "0" || v.eq_ignore_ascii_case("false")))
                .unwrap_or(true);
            win.set_always_on_top(aot).ok();

            // A janela nasce invisível: posiciona no topo central e só então mostra
            // (evita o "pulo" do centro da tela para o topo).
            // Overlay de tamanho fixo (a interface ajusta logo depois) e só a área
            // visível recebe cliques; nasce na posição salva ou no topo central
            win.set_size(tauri::Size::Logical(tauri::LogicalSize { width: window::INITIAL_SIZE.0, height: window::INITIAL_SIZE.1 })).ok();
            window::place(&win, window::INITIAL_SIZE.0);
            win.show().ok();

            // Alguns gerenciadores de janela ignoram a posição antes do primeiro "map"
            let w = win.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(250)).await;
                window::place(&w, window::INITIAL_SIZE.0);
            });

            // Aberto por uma ação do menu (ex.: "E-mails"): espera a interface carregar
            let args: Vec<String> = std::env::args().collect();
            if let Some(action) = cli_action(&args).filter(|a| a != "toggle") {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(1500)).await;
                    system::emit_action(&handle, &action);
                });
            }
            Ok(())
        })
        .on_window_event(|w, event| {
            if let tauri::WindowEvent::Moved(_) = event {
                if let Some(win) = w.app_handle().get_webview_window(w.label()) {
                    window::on_moved(&win);
                }
            }
            // O overlay nunca maximiza (duplo clique na área de arraste, atalhos do WM)
            if let tauri::WindowEvent::Resized(_) = event {
                if w.is_maximized().unwrap_or(false) {
                    w.unmaximize().ok();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("erro ao iniciar o assistente Lumo no Linux")
        .run(|_app, event| {
            // Não deixa o Não Perturbe ligado pelo Lumo preso depois de sair
            if let tauri::RunEvent::Exit = event {
                focus::restore_on_exit();
                audio::cleanup();
                terminal::cleanup();
            }
        });
}
