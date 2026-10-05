// Modo Foco -> Não Perturbe do sistema (GNOME e KDE Plasma).
use serde::Serialize;
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

// ---------------------------------------------------------------------------
// Modo Foco -> Não Perturbe (KDE Plasma)
//
// O Plasma não expõe um "set DND" público e estável por D-Bus. O que existe é o
// atalho global "toggle do not disturb" (kglobalaccel), que é um TOGGLE. Por isso:
//   1) lemos o estado antes (propriedade org.freedesktop.Notifications.Inhibited);
//   2) só acionamos o toggle se o estado desejado for diferente do atual;
//   3) confirmamos lendo de novo; se não der para confirmar, dizemos isso (status
//      "unverified") em vez de fingir que funcionou;
//   4) nunca desligamos um Não Perturbe que o usuário já tinha ligado.
// Fora do KDE (ou sem busctl/qdbus) devolvemos "unsupported" e nada é alterado.
// ---------------------------------------------------------------------------
#[derive(Serialize)]
pub struct DndResult {
    pub status: String, // enabled | already_on | disabled | unverified | unsupported | failed
    pub message: String,
}

fn dnd_res(status: &str, message: &str) -> DndResult {
    DndResult { status: status.into(), message: message.into() }
}

// 0 = o Lumo não mexeu · 1 = o Lumo ligou e confirmou · 2 = o Lumo enviou o toggle sem confirmar
static DND_STATE: Mutex<u8> = Mutex::new(0);

const QDBUS_BINS: [&str; 3] = ["qdbus6", "qdbus", "qdbus-qt5"];
const SHORTCUT: &str = "toggle do not disturb";

fn run(cmd: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(cmd).args(args).output().ok()?;
    if out.status.success() {
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        None
    }
}

fn is_kde() -> bool {
    std::env::var("XDG_CURRENT_DESKTOP")
        .map(|v| v.to_uppercase().contains("KDE"))
        .unwrap_or(false)
}

fn dnd_read() -> Option<bool> {
    if let Some(s) = run(
        "busctl",
        &["--user", "get-property", "org.freedesktop.Notifications",
          "/org/freedesktop/Notifications", "org.freedesktop.Notifications", "Inhibited"],
    ) {
        return Some(s.ends_with("true")); // formato: "b true" / "b false"
    }
    for q in QDBUS_BINS {
        if let Some(s) = run(
            q,
            &["org.freedesktop.Notifications", "/org/freedesktop/Notifications",
              "org.freedesktop.Notifications.Inhibited"],
        ) {
            return Some(s == "true");
        }
    }
    None
}

fn dnd_toggle() -> bool {
    if run(
        "busctl",
        &["--user", "call", "org.kde.kglobalaccel", "/component/plasmashell",
          "org.kde.kglobalaccel.Component", "invokeShortcut", "s", SHORTCUT],
    )
    .is_some()
    {
        return true;
    }
    QDBUS_BINS.iter().any(|q| {
        run(q, &["org.kde.kglobalaccel", "/component/plasmashell", "invokeShortcut", SHORTCUT]).is_some()
    })
}

// ---- GNOME: "Não Perturbe" = org.gnome.desktop.notifications show-banners=false ----
// É um valor (não um toggle), então dá para ler, mudar e confirmar com segurança.
// Só desfazemos o que o Lumo mudou: se o usuário já estava em Não Perturbe, fica como está.

const GNOME_SCHEMA: &str = "org.gnome.desktop.notifications";

fn is_gnome() -> bool {
    std::env::var("XDG_CURRENT_DESKTOP")
        .map(|v| {
            let v = v.to_uppercase();
            v.contains("GNOME") || v.contains("UNITY") || v.contains("BUDGIE")
        })
        .unwrap_or(false)
}

fn gnome_banners() -> Option<bool> {
    run("gsettings", &["get", GNOME_SCHEMA, "show-banners"]).map(|s| s == "true")
}

fn gnome_set_banners(on: bool) -> bool {
    run("gsettings", &["set", GNOME_SCHEMA, "show-banners", if on { "true" } else { "false" }]).is_some()
}

fn gnome_apply(enable: bool, state: &mut u8) -> DndResult {
    if enable {
        if *state != 0 {
            return dnd_res("enabled", "Não Perturbe ativado pelo Lumo.");
        }
        match gnome_banners() {
            None => return dnd_res("unsupported", "Não consegui ler o Não Perturbe do GNOME (gsettings). As notificações NÃO estão silenciadas."),
            Some(false) => return dnd_res("already_on", "O Não Perturbe já estava ativo; o Lumo não vai desligá-lo ao terminar."),
            Some(true) => {}
        }
        if gnome_set_banners(false) && gnome_banners() == Some(false) {
            *state = 1;
            dnd_res("enabled", "Não Perturbe do GNOME ativado até o fim do foco.")
        } else {
            dnd_res("failed", "Não consegui ativar o Não Perturbe do GNOME. As notificações NÃO estão silenciadas.")
        }
    } else {
        if *state == 0 {
            return dnd_res("disabled", "");
        }
        *state = 0;
        if gnome_set_banners(true) && gnome_banners() == Some(true) {
            dnd_res("disabled", "")
        } else {
            dnd_res("unverified", "Tentei desligar o Não Perturbe do GNOME, mas não consegui confirmar. Confira no menu do relógio.")
        }
    }
}

/// Garante que o Não Perturbe ligado pelo Lumo não fique preso ao sair do app
pub fn restore_on_exit() {
    if DND_STATE.lock().map(|s| *s != 0).unwrap_or(false) {
        dnd_apply(false);
    }
}

fn dnd_apply(enable: bool) -> DndResult {
    if is_gnome() {
        let mut state = match DND_STATE.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        return gnome_apply(enable, &mut state);
    }
    if !is_kde() {
        return if enable {
            dnd_res("unsupported", "Não Perturbe automático funciona no GNOME e no KDE Plasma. Aqui as notificações NÃO estão silenciadas.")
        } else {
            dnd_res("disabled", "")
        };
    }

    // Mutex segura a sequência inteira (ler -> alternar -> confirmar)
    let mut state = match DND_STATE.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };

    if enable {
        if *state != 0 {
            return dnd_res("enabled", "Não Perturbe ativado pelo Lumo.");
        }
        match dnd_read() {
            Some(true) => return dnd_res("already_on", "O Não Perturbe já estava ativo; o Lumo não vai desligá-lo ao terminar."),
            None => return dnd_res("unsupported", "Não consegui ler o estado do Não Perturbe (busctl/qdbus ausente ou sem D-Bus). Nada foi alterado e as notificações NÃO estão silenciadas."),
            Some(false) => {}
        }
        if !dnd_toggle() {
            return dnd_res("failed", "Não consegui acionar o atalho de Não Perturbe do Plasma. As notificações NÃO estão silenciadas.");
        }
        std::thread::sleep(Duration::from_millis(350));
        if dnd_read() == Some(true) {
            *state = 1;
            dnd_res("enabled", "Não Perturbe do KDE ativado.")
        } else {
            *state = 2;
            dnd_res("unverified", "Enviei o comando ao KDE, mas não consegui confirmar que o Não Perturbe ligou. Confira o sino no painel.")
        }
    } else {
        let cur = *state;
        match cur {
            0 => dnd_res("disabled", ""),
            1 => {
                let on = dnd_read() == Some(true);
                if on {
                    dnd_toggle();
                    std::thread::sleep(Duration::from_millis(350));
                }
                *state = 0;
                if dnd_read() == Some(false) {
                    dnd_res("disabled", "")
                } else {
                    dnd_res("unverified", "Tentei desligar o Não Perturbe, mas não consegui confirmar. Confira o sino no painel.")
                }
            }
            _ => {
                // Ligamos sem confirmação: desfazemos com UM toggle e avisamos que não dá para garantir
                dnd_toggle();
                *state = 0;
                dnd_res("unverified", "Enviei o comando para desligar o Não Perturbe, mas não consigo confirmar. Confira o sino no painel.")
            }
        }
    }
}

#[tauri::command]
pub async fn set_focus_dnd(enable: bool) -> Result<DndResult, String> {
    tauri::async_runtime::spawn_blocking(move || dnd_apply(enable))
        .await
        .map_err(|e| e.to_string())
}

