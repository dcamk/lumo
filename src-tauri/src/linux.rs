// Recursos de Linux para a aba "Linux": uso do sistema (/proc e /sys), player de
// mídia (MPRIS via D-Bus), ações rápidas (comandos do usuário) e abrir links.
use serde::Serialize;
use std::collections::HashMap;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use zbus::zvariant::{OwnedValue, Value};

// ---- Uso do sistema ------------------------------------------------------------

#[derive(Serialize, Default)]
pub struct SystemStats {
    pub cpu: f32,       // % (média de todos os núcleos desde a última leitura)
    pub mem_used: u64,  // bytes
    pub mem_total: u64, // bytes
    pub disk_used: u64, // bytes (partição /)
    pub disk_total: u64,
    pub temp: Option<f32>, // °C, o sensor mais quente
    pub battery: Option<u8>,
    pub charging: bool,
    pub net_down: u64, // bytes/s
    pub net_up: u64,
    pub uptime: u64, // segundos
    pub load: f32,   // média de 1 min
    pub cores: usize,
    pub top: Vec<ProcessInfo>,
}

#[derive(Serialize)]
pub struct ProcessInfo {
    pub name: String,
    pub cpu: f32,
    pub mem: f32,
}

#[derive(Serialize)]
pub struct SystemInfo {
    pub distro: String,
    pub kernel: String,
    pub desktop: String,
    pub session: String,
    pub hostname: String,
    pub user: String,
}

/// Leituras anteriores para calcular taxas (CPU e rede)
struct Prev {
    cpu: (u64, u64), // (ocupado, total)
    net: (u64, u64), // (rx, tx)
    at: Instant,
}
static PREV: Mutex<Option<Prev>> = Mutex::new(None);

fn read(path: &str) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

fn cpu_times() -> (u64, u64) {
    let stat = read("/proc/stat");
    let Some(line) = stat.lines().next() else { return (0, 0) };
    let v: Vec<u64> = line.split_whitespace().skip(1).filter_map(|n| n.parse().ok()).collect();
    let total: u64 = v.iter().sum();
    let idle = v.get(3).copied().unwrap_or(0) + v.get(4).copied().unwrap_or(0); // idle + iowait
    (total.saturating_sub(idle), total)
}

fn net_bytes() -> (u64, u64) {
    let mut rx = 0;
    let mut tx = 0;
    for line in read("/proc/net/dev").lines().skip(2) {
        let Some((iface, data)) = line.split_once(':') else { continue };
        let iface = iface.trim();
        if iface == "lo" || iface.starts_with("veth") || iface.starts_with("docker") || iface.starts_with("br-") {
            continue;
        }
        let v: Vec<u64> = data.split_whitespace().filter_map(|n| n.parse().ok()).collect();
        rx += v.first().copied().unwrap_or(0);
        tx += v.get(8).copied().unwrap_or(0);
    }
    (rx, tx)
}

fn meminfo() -> (u64, u64) {
    let info = read("/proc/meminfo");
    let field = |name: &str| {
        info.lines()
            .find(|l| l.starts_with(name))
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|n| n.parse::<u64>().ok())
            .unwrap_or(0)
            * 1024
    };
    let total = field("MemTotal:");
    (total.saturating_sub(field("MemAvailable:")), total)
}

fn disk_root() -> (u64, u64) {
    // df evita depender de libc/statvfs; -B1 = bytes
    let out = Command::new("df").args(["-B1", "--output=size,avail", "/"]).output();
    let Ok(out) = out else { return (0, 0) };
    let text = String::from_utf8_lossy(&out.stdout);
    let v: Vec<u64> = text.lines().nth(1).unwrap_or("").split_whitespace().filter_map(|n| n.parse().ok()).collect();
    match v.as_slice() {
        [size, avail] => (size.saturating_sub(*avail), *size),
        _ => (0, 0),
    }
}

fn temperature() -> Option<f32> {
    // hwmon cobre CPU (coretemp/k10temp), NVMe e GPU; thermal_zone é o plano B
    let mut best: Option<f32> = None;
    let consider = |best: &mut Option<f32>, milli: &str| {
        if let Ok(v) = milli.trim().parse::<f32>() {
            let c = v / 1000.0;
            if (5.0..130.0).contains(&c) && best.map_or(true, |b| c > b) {
                *best = Some(c);
            }
        }
    };
    if let Ok(dirs) = std::fs::read_dir("/sys/class/hwmon") {
        for d in dirs.flatten() {
            for i in 1..=8 {
                let p = d.path().join(format!("temp{}_input", i));
                if let Ok(s) = std::fs::read_to_string(p) {
                    consider(&mut best, &s);
                }
            }
        }
    }
    if best.is_none() {
        if let Ok(dirs) = std::fs::read_dir("/sys/class/thermal") {
            for d in dirs.flatten() {
                if d.file_name().to_string_lossy().starts_with("thermal_zone") {
                    consider(&mut best, &read(&d.path().join("temp").to_string_lossy()));
                }
            }
        }
    }
    best
}

fn battery() -> (Option<u8>, bool) {
    let Ok(dirs) = std::fs::read_dir("/sys/class/power_supply") else { return (None, false) };
    for d in dirs.flatten() {
        let p = d.path();
        if read(&p.join("type").to_string_lossy()).trim() != "Battery" {
            continue;
        }
        let cap = read(&p.join("capacity").to_string_lossy()).trim().parse::<u8>().ok();
        let status = read(&p.join("status").to_string_lossy());
        return (cap, matches!(status.trim(), "Charging" | "Full"));
    }
    (None, false)
}

fn top_processes() -> Vec<ProcessInfo> {
    let out = Command::new("ps").args(["-eo", "comm,%cpu,%mem", "--sort=-%cpu", "--no-headers"]).output();
    let Ok(out) = out else { return vec![] };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| {
            let mut parts = l.split_whitespace().rev();
            let mem = parts.next()?.replace(',', ".").parse().ok()?;
            let cpu = parts.next()?.replace(',', ".").parse().ok()?;
            let name: Vec<&str> = parts.rev().collect();
            Some(ProcessInfo { name: name.join(" "), cpu, mem })
        })
        .filter(|p| p.name != "ps")
        .take(3)
        .collect()
}

fn collect_stats() -> SystemStats {
    let cpu_now = cpu_times();
    let net_now = net_bytes();
    let now = Instant::now();
    let (mut cpu, mut down, mut up) = (0.0, 0, 0);
    {
        let mut prev = PREV.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(p) = prev.as_ref() {
            let busy = cpu_now.0.saturating_sub(p.cpu.0) as f32;
            let total = cpu_now.1.saturating_sub(p.cpu.1) as f32;
            if total > 0.0 {
                cpu = (busy / total * 100.0).clamp(0.0, 100.0);
            }
            let secs = now.duration_since(p.at).as_secs_f64().max(0.001);
            down = (net_now.0.saturating_sub(p.net.0) as f64 / secs) as u64;
            up = (net_now.1.saturating_sub(p.net.1) as f64 / secs) as u64;
        }
        *prev = Some(Prev { cpu: cpu_now, net: net_now, at: now });
    }
    let (mem_used, mem_total) = meminfo();
    let (disk_used, disk_total) = disk_root();
    let (battery, charging) = battery();
    let uptime = read("/proc/uptime").split_whitespace().next().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0) as u64;
    let load = read("/proc/loadavg").split_whitespace().next().and_then(|s| s.parse().ok()).unwrap_or(0.0);
    SystemStats {
        cpu,
        mem_used,
        mem_total,
        disk_used,
        disk_total,
        temp: temperature(),
        battery,
        charging,
        net_down: down,
        net_up: up,
        uptime,
        load,
        cores: std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1),
        top: top_processes(),
    }
}

#[tauri::command]
pub async fn system_stats() -> SystemStats {
    tauri::async_runtime::spawn_blocking(collect_stats).await.unwrap_or_default()
}

#[tauri::command]
pub fn system_info() -> SystemInfo {
    let os = read("/etc/os-release");
    let distro = os
        .lines()
        .find_map(|l| l.strip_prefix("PRETTY_NAME="))
        .map(|s| s.trim_matches('"').to_string())
        .unwrap_or_else(|| "Linux".into());
    let env = |k: &str| std::env::var(k).unwrap_or_default();
    SystemInfo {
        distro,
        kernel: read("/proc/sys/kernel/osrelease").trim().to_string(),
        desktop: env("XDG_CURRENT_DESKTOP"),
        session: env("XDG_SESSION_TYPE"),
        hostname: read("/proc/sys/kernel/hostname").trim().to_string(),
        user: env("USER"),
    }
}

// ---- Mídia (MPRIS) ----------------------------------------------------------------

const MPRIS_PREFIX: &str = "org.mpris.MediaPlayer2.";
const MPRIS_PATH: &str = "/org/mpris/MediaPlayer2";
const MPRIS_PLAYER: &str = "org.mpris.MediaPlayer2.Player";

#[derive(Serialize)]
pub struct MediaStatus {
    pub player: String,
    pub playing: bool,
    pub title: String,
    pub artist: String,
}

fn player_proxy<'a>(conn: &'a zbus::blocking::Connection, name: &'a str) -> Option<zbus::blocking::Proxy<'a>> {
    zbus::blocking::Proxy::new(conn, name.to_string(), MPRIS_PATH, MPRIS_PLAYER).ok()
}

fn value_text(v: &OwnedValue) -> String {
    match &**v {
        Value::Str(s) => s.to_string(),
        Value::Array(a) => a
            .iter()
            .filter_map(|i| if let Value::Str(s) = i { Some(s.to_string()) } else { None })
            .collect::<Vec<_>>()
            .join(", "),
        _ => String::new(),
    }
}

fn read_player(conn: &zbus::blocking::Connection, name: &str) -> Option<MediaStatus> {
    let proxy = player_proxy(conn, name)?;
    let status: String = proxy.get_property("PlaybackStatus").ok()?;
    if status == "Stopped" {
        return None;
    }
    let meta: HashMap<String, OwnedValue> = proxy.get_property("Metadata").unwrap_or_default();
    let get = |k: &str| meta.get(k).map(value_text).unwrap_or_default();
    let player = name.trim_start_matches(MPRIS_PREFIX).split('.').next().unwrap_or("").to_string();
    Some(MediaStatus { player, playing: status == "Playing", title: get("xesam:title"), artist: get("xesam:artist") })
}

/// Player ativo: o primeiro tocando; senão o primeiro pausado
fn active_player() -> Option<(String, MediaStatus)> {
    let conn = crate::cursor::session_bus()?;
    let dbus = zbus::blocking::fdo::DBusProxy::new(conn).ok()?;
    let names: Vec<String> = dbus
        .list_names()
        .ok()?
        .into_iter()
        .map(|n| n.to_string())
        .filter(|n| n.starts_with(MPRIS_PREFIX))
        .collect();
    let mut fallback = None;
    for name in names {
        let Some(st) = read_player(conn, &name) else { continue };
        if st.playing {
            return Some((name, st));
        }
        fallback.get_or_insert((name, st));
    }
    fallback
}

#[tauri::command]
pub async fn media_status() -> Option<MediaStatus> {
    tauri::async_runtime::spawn_blocking(|| active_player().map(|(_, s)| s)).await.ok().flatten()
}

/// "PlayPause" | "Next" | "Previous"
#[tauri::command]
pub async fn media_control(action: String) -> Result<(), String> {
    if !matches!(action.as_str(), "PlayPause" | "Next" | "Previous") {
        return Err("ação de mídia inválida".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let (name, _) = active_player().ok_or("nenhum player aberto")?;
        let conn = crate::cursor::session_bus().ok_or("D-Bus indisponível")?;
        let proxy = player_proxy(conn, &name).ok_or("player indisponível")?;
        proxy.call_method(action.as_str(), &()).map(|_| ()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- Ações rápidas ------------------------------------------------------------------

const OUTPUT_LIMIT: usize = 4000;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(20);

/// Primeiro emulador de terminal disponível e o argumento que executa um comando
fn terminal() -> Option<(&'static str, &'static [&'static str])> {
    const CANDIDATES: [(&str, &[&str]); 8] = [
        ("gnome-terminal", &["--"]),
        ("kgx", &["--"]),
        ("ptyxis", &["--"]),
        ("konsole", &["-e"]),
        ("xfce4-terminal", &["-x"]),
        ("tilix", &["-e"]),
        ("alacritty", &["-e"]),
        ("x-terminal-emulator", &["-e"]),
    ];
    CANDIDATES.into_iter().find(|(bin, _)| which(bin))
}

fn which(bin: &str) -> bool {
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|d| d.join(bin).is_file()))
        .unwrap_or(false)
}

/// Executa um comando definido pelo usuário. `mode`:
///   "terminal" — abre num terminal (interativos como `sudo apt upgrade`) e volta na hora
///   "launch"   — abre um programa desacoplado do Lumo (ex.: gnome-system-monitor)
///   "output"   — roda em segundo plano e devolve a saída (até 20 s)
#[tauri::command]
pub async fn run_command(command: String, mode: String) -> Result<String, String> {
    let command = command.trim().to_string();
    if mode == "launch" {
        if command.is_empty() {
            return Err("comando vazio".into());
        }
        // setsid: o programa não morre junto com o Lumo
        Command::new("setsid")
            .args(["-f", "sh", "-c", &command])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(String::new());
    }
    if mode == "terminal" {
        let (bin, flag) = terminal().ok_or("nenhum terminal encontrado")?;
        let mut cmd = Command::new(bin);
        cmd.args(flag);
        if command.is_empty() {
            // só abre o terminal
            let mut plain = Command::new(bin);
            plain.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
            plain.spawn().map_err(|e| e.to_string())?;
            return Ok(String::new());
        }
        let script = format!("{}; echo; read -n 1 -s -r -p 'Lumo: pressione uma tecla para fechar…'", command);
        cmd.args(["bash", "-c", &script]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        cmd.spawn().map_err(|e| format!("não consegui abrir o terminal: {}", e))?;
        return Ok(String::new());
    }
    if command.is_empty() {
        return Err("comando vazio".into());
    }
    let child = tokio::process::Command::new("sh")
        .args(["-c", &command])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| e.to_string())?;
    let out = tokio::time::timeout(COMMAND_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| "o comando passou de 20 s e foi encerrado".to_string())?
        .map_err(|e| e.to_string())?;
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    let err = String::from_utf8_lossy(&out.stderr);
    if !err.trim().is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(err.trim_end());
    }
    let mut text = text.trim_end().to_string();
    if text.len() > OUTPUT_LIMIT {
        let mut cut = OUTPUT_LIMIT;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        text.push_str("\n[…]");
    }
    if out.status.success() {
        Ok(text)
    } else {
        Err(if text.is_empty() { format!("saiu com código {}", out.status.code().unwrap_or(-1)) } else { text })
    }
}

/// Abre um link no navegador padrão (só http/https/mailto)
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://") || url.starts_with("mailto:")) {
        return Err("link não permitido".into());
    }
    Command::new("xdg-open")
        .arg(&url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}
