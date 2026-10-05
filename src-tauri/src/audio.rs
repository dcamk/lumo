// Saída de áudio nativa. O Web Audio do WebKitGTK depende do GStreamer e do estado
// do AudioContext, que às vezes fica "suspended" ou sai no dispositivo errado. Aqui a
// interface sintetiza o som (OfflineAudioContext, sem tocar), manda o WAV uma vez e
// o Rust toca pelo servidor de som do sistema (pw-play / paplay / aplay).
use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};

static SOUNDS: Mutex<Option<HashMap<String, PathBuf>>> = Mutex::new(None);

#[derive(Clone, Copy)]
enum Player {
    PwPlay,
    Paplay,
    Aplay,
}

fn which(bin: &str) -> bool {
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|d| d.join(bin).is_file()))
        .unwrap_or(false)
}

/// PipeWire de verdade → pw-play; PulseAudio (padrão do Ubuntu 22.04) → paplay
fn player() -> Option<Player> {
    static P: OnceLock<Option<Player>> = OnceLock::new();
    *P.get_or_init(|| {
        let pipewire = Command::new("pactl")
            .arg("info")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains("PipeWire"))
            .unwrap_or(false);
        if pipewire && which("pw-play") {
            Some(Player::PwPlay)
        } else if which("paplay") {
            Some(Player::Paplay)
        } else if which("pw-play") {
            Some(Player::PwPlay)
        } else if which("aplay") {
            Some(Player::Aplay)
        } else {
            None
        }
    })
}

fn sound_dir() -> PathBuf {
    std::env::temp_dir().join(format!("lumo-sounds-{}", std::process::id()))
}

/// Toca um som já sintetizado. `wav` (base64) só precisa vir na primeira vez;
/// depois o arquivo fica em cache pelo nome. `volume` de 0 a 1.
#[tauri::command]
pub fn play_sound(name: String, wav: Option<String>, volume: f64) -> Result<bool, String> {
    let player = player().ok_or("nenhum player de áudio (pw-play/paplay/aplay)")?;
    let mut guard = SOUNDS.lock().map_err(|e| e.to_string())?;
    let cache = guard.get_or_insert_with(HashMap::new);
    if let Some(data) = wav {
        let bytes = STANDARD.decode(data).map_err(|e| e.to_string())?;
        let dir = sound_dir();
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let safe: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
        let path = dir.join(format!("{}.wav", safe));
        std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
        cache.insert(name.clone(), path);
    }
    let Some(path) = cache.get(&name).cloned() else {
        return Ok(false); // a interface manda o WAV e tenta de novo
    };
    drop(guard);

    let v = volume.clamp(0.0, 1.0);
    let mut cmd = match player {
        Player::PwPlay => {
            let mut c = Command::new("pw-play");
            c.arg(format!("--volume={:.3}", v)).arg(&path);
            c
        }
        Player::Paplay => {
            let mut c = Command::new("paplay");
            c.arg(format!("--volume={}", (v * 65536.0) as u32)).arg("--client-name=Lumo").arg(&path);
            c
        }
        Player::Aplay => {
            let mut c = Command::new("aplay");
            c.arg("-q").arg(&path);
            c
        }
    };
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    // Recolhe o processo quando terminar (sem zumbis)
    std::thread::spawn(move || {
        child.wait().ok();
    });
    Ok(true)
}

/// Qual player o Lumo está usando (para o diagnóstico em Config)
#[tauri::command]
pub fn audio_backend() -> String {
    match player() {
        Some(Player::PwPlay) => "PipeWire (pw-play)".into(),
        Some(Player::Paplay) => "PulseAudio (paplay)".into(),
        Some(Player::Aplay) => "ALSA (aplay)".into(),
        None => "nenhum".into(),
    }
}

/// Apaga os WAVs temporários ao sair
pub fn cleanup() {
    std::fs::remove_dir_all(sound_dir()).ok();
}
