// Ponte Lumo: o celular ou tablet conversa com este PC pela rede local.
//
// O PC serve o app móvel (pasta dist/mobile) e uma API pequena em http://<ip>:4646.
// O celular usa a IA configurada AQUI (as chaves nunca saem do PC), troca arquivos pela
// nuvem pessoal guardada no PC (cloud.rs) e controla mídia, links e área de transferência.
//
// Segurança:
//   • desligada por padrão; só sobe quando o usuário liga em Config → Celular;
//   • pareamento por PIN de 6 dígitos que expira em 10 min e é trocado após 5 erros;
//   • cada aparelho recebe um token próprio (só o hash fica em disco) e pode ser removido;
//   • no chat do celular nada roda sem aprovação: comandos e gravações pedem confirmação
//     na tela do celular, como no PC.
// Limite conhecido: é HTTP puro na rede local (sem TLS). Use em redes de confiança.

use crate::agent::{self, AgentEvent};
use crate::brain::orchestrator::{self, SendReq};
use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Query, Request};
use axum::http::{header, HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;
use tokio::sync::oneshot;

const PORT: u16 = 4646;
const PIN_TTL: u64 = 600;
const MAX_TRIES: u32 = 5;
const MAX_TEXT: usize = 20_000;

#[derive(Serialize, Deserialize, Clone)]
struct Device {
    id: String,
    name: String,
    token_hash: String,
    paired_at: u64,
}

#[derive(Serialize, Deserialize, Default)]
struct Saved {
    enabled: bool,
    devices: Vec<Device>,
}

#[derive(Default)]
struct State {
    saved: Saved,
    pin: Option<(String, u64)>,
    tries: u32,
    port: Option<u16>,
    stop: Option<oneshot::Sender<()>>,
    last_seen: HashMap<String, u64>,
}

static STATE: OnceLock<Mutex<State>> = OnceLock::new();
static APP: OnceLock<AppHandle> = OnceLock::new();
/// Uma conversa do celular por vez (o cérebro é um só)
static CHAT_BUSY: AtomicBool = AtomicBool::new(false);

fn state() -> std::sync::MutexGuard<'static, State> {
    STATE.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

pub(crate) fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn random_bytes(n: usize) -> Vec<u8> {
    use std::io::Read;
    let mut buf = vec![0u8; n];
    if std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut buf)).is_err() {
        // Sem /dev/urandom (não deveria acontecer no Linux): mistura relógio e endereço
        let seed = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let mut h = Sha256::new();
        h.update(seed.to_le_bytes());
        h.update((&buf as *const _ as usize).to_le_bytes());
        let d = h.finalize();
        for (i, b) in buf.iter_mut().enumerate() {
            *b = d[i % d.len()];
        }
    }
    buf
}

fn hash(token: &str) -> String {
    Sha256::digest(token.as_bytes()).iter().map(|b| format!("{:02x}", b)).collect()
}

fn new_pin() -> String {
    let b = random_bytes(4);
    format!("{:06}", u32::from_le_bytes([b[0], b[1], b[2], b[3]]) % 1_000_000)
}

fn config_file() -> Option<PathBuf> {
    crate::brain::dir().map(|d| d.join("bridge.json"))
}

fn persist(s: &State) {
    let Some(path) = config_file() else { return };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    if let Ok(text) = serde_json::to_string_pretty(&s.saved) {
        std::fs::write(&path, text).ok();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).ok();
        }
    }
}

pub(crate) fn changed() {
    if let Some(app) = APP.get() {
        app.emit("bridge-changed", ()).ok();
    }
}

/// Pasta da nuvem do celular neste PC (~/Lumo Nuvem)
pub fn shared_dir() -> PathBuf {
    crate::cloud::root()
}

/// Endereços IPv4 da rede local deste PC (o primeiro é o da rota padrão)
fn lan_ips() -> Vec<String> {
    let mut ips = Vec::new();
    // "Conectar" UDP não envia nada: só pergunta ao sistema qual interface sairia
    if let Ok(sock) = std::net::UdpSocket::bind("0.0.0.0:0") {
        if sock.connect("192.0.2.1:9").is_ok() {
            if let Ok(addr) = sock.local_addr() {
                if !addr.ip().is_loopback() && !addr.ip().is_unspecified() {
                    ips.push(addr.ip().to_string());
                }
            }
        }
    }
    if let Ok(out) = std::process::Command::new("hostname").arg("-I").output() {
        for ip in String::from_utf8_lossy(&out.stdout).split_whitespace() {
            if ip.parse::<std::net::Ipv4Addr>().map(|a| a.is_private()).unwrap_or(false) && !ips.iter().any(|i| i == ip) {
                ips.push(ip.to_string());
            }
        }
    }
    ips
}

fn hostname() -> String {
    std::fs::read_to_string("/proc/sys/kernel/hostname").map(|s| s.trim().to_string()).unwrap_or_else(|_| "PC".into())
}

// ---- Comandos da interface do PC ------------------------------------------------------

#[derive(Serialize)]
pub struct DeviceInfo {
    id: String,
    name: String,
    paired_at: u64,
    last_seen: u64,
}

#[derive(Serialize)]
pub struct BridgeStatus {
    enabled: bool,
    running: bool,
    port: u16,
    urls: Vec<String>,
    /// Link de pareamento (vai no QR): abre o app no celular já com o PIN
    pair_url: String,
    pin: String,
    pin_expires: u64,
    qr_svg: String,
    devices: Vec<DeviceInfo>,
    shared_dir: String,
}

fn qr_svg(text: &str) -> String {
    use qrcode::render::svg;
    qrcode::QrCode::new(text.as_bytes())
        .map(|q| q.render::<svg::Color>().min_dimensions(220, 220).quiet_zone(true).build())
        .unwrap_or_default()
}

fn status_of(s: &mut State) -> BridgeStatus {
    let running = s.port.is_some();
    let port = s.port.unwrap_or(PORT);
    // Com a ponte ligada sempre existe um PIN válido para parear mais um aparelho
    if running && s.pin.as_ref().map(|(_, exp)| *exp <= now()).unwrap_or(true) {
        s.pin = Some((new_pin(), now() + PIN_TTL));
        s.tries = 0;
    }
    let urls: Vec<String> = lan_ips().into_iter().map(|ip| format!("http://{}:{}", ip, port)).collect();
    let (pin, pin_expires) = s.pin.clone().filter(|_| running).unwrap_or_default();
    let pair_url = match (urls.first(), running) {
        (Some(u), true) => format!("{}/#pair={}", u, pin),
        _ => String::new(),
    };
    BridgeStatus {
        enabled: s.saved.enabled,
        running,
        port,
        qr_svg: if pair_url.is_empty() { String::new() } else { qr_svg(&pair_url) },
        pair_url,
        urls,
        pin,
        pin_expires,
        devices: s
            .saved
            .devices
            .iter()
            .map(|d| DeviceInfo { id: d.id.clone(), name: d.name.clone(), paired_at: d.paired_at, last_seen: s.last_seen.get(&d.id).copied().unwrap_or(0) })
            .collect(),
        shared_dir: shared_dir().to_string_lossy().into_owned(),
    }
}

#[tauri::command]
pub fn bridge_status() -> BridgeStatus {
    status_of(&mut state())
}

#[tauri::command]
pub async fn bridge_set(enabled: bool) -> Result<BridgeStatus, String> {
    {
        let mut s = state();
        s.saved.enabled = enabled;
        persist(&s);
    }
    if enabled {
        start().await?;
    } else {
        stop();
    }
    changed();
    Ok(bridge_status())
}

#[tauri::command]
pub fn bridge_new_pin() -> BridgeStatus {
    let mut s = state();
    s.pin = None;
    status_of(&mut s)
}

#[tauri::command]
pub fn bridge_forget(id: String) -> BridgeStatus {
    let mut s = state();
    s.saved.devices.retain(|d| d.id != id);
    s.last_seen.remove(&id);
    persist(&s);
    status_of(&mut s)
}

#[tauri::command]
pub fn bridge_open_shared() -> Result<(), String> {
    std::process::Command::new("xdg-open").arg(shared_dir()).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// No setup do app: carrega os aparelhos pareados e liga a ponte se estava ligada
pub fn init(app: &AppHandle) {
    APP.set(app.clone()).ok();
    let enabled = {
        let mut s = state();
        if let Some(saved) = config_file().and_then(|p| std::fs::read_to_string(p).ok()).and_then(|t| serde_json::from_str::<Saved>(&t).ok()) {
            s.saved = saved;
        }
        s.saved.enabled
    };
    if enabled {
        tauri::async_runtime::spawn(async {
            if let Err(e) = start().await {
                eprintln!("[Lumo/ponte] não consegui ligar: {}", e);
            }
        });
    }
}

async fn start() -> Result<u16, String> {
    if let Some(p) = state().port {
        return Ok(p);
    }
    let mut last_err = String::new();
    for port in PORT..PORT + 10 {
        match tokio::net::TcpListener::bind(("0.0.0.0", port)).await {
            Ok(listener) => {
                let (tx, rx) = oneshot::channel::<()>();
                {
                    let mut s = state();
                    s.port = Some(port);
                    s.stop = Some(tx);
                    s.pin = None;
                }
                tauri::async_runtime::spawn(async move {
                    let served = axum::serve(listener, router()).with_graceful_shutdown(async {
                        rx.await.ok();
                    });
                    if let Err(e) = served.await {
                        eprintln!("[Lumo/ponte] servidor parou: {}", e);
                    }
                    let mut s = state();
                    if s.port == Some(port) {
                        s.port = None;
                    }
                });
                eprintln!("[Lumo/ponte] ouvindo na porta {}", port);
                return Ok(port);
            }
            Err(e) => last_err = e.to_string(),
        }
    }
    Err(format!("nenhuma porta livre a partir de {}: {}", PORT, last_err))
}

fn stop() {
    let mut s = state();
    if let Some(tx) = s.stop.take() {
        tx.send(()).ok();
    }
    s.port = None;
    s.pin = None;
}

// ---- Servidor ---------------------------------------------------------------------------

fn router() -> Router {
    let api = Router::new()
        .route("/api/status", get(api_status))
        .route("/api/chat", post(api_chat))
        .route("/api/approve", post(api_approve))
        .route("/api/cancel", post(api_cancel))
        .route("/api/ask", post(api_ask))
        .route("/api/media", post(api_media))
        .route("/api/open", post(api_open))
        .route("/api/clipboard", get(api_clip_get).post(api_clip_set))
        .route("/api/ping", post(api_ping))
        .route("/api/cloud/list", get(crate::cloud::api_list))
        .route("/api/cloud/file", get(crate::cloud::api_file))
        .route("/api/cloud/upload", post(crate::cloud::api_upload).layer(DefaultBodyLimit::disable()))
        .route("/api/cloud/mkdir", post(crate::cloud::api_mkdir))
        .route("/api/cloud/rename", post(crate::cloud::api_rename))
        .route("/api/cloud/delete", post(crate::cloud::api_delete))
        .route("/api/db/{collection}", get(crate::cloud::api_db_list))
        .route("/api/db/{collection}/{id}", axum::routing::put(crate::cloud::api_db_put).delete(crate::cloud::api_db_delete))
        .route("/api/unpair", post(api_unpair))
        .layer(middleware::from_fn(auth));
    Router::new()
        .route("/api/hello", get(api_hello))
        .route("/api/pair", post(api_pair))
        .merge(api)
        .fallback(get(static_file))
        // O app nativo (Android) roda em outra origem; o acesso é por token, sem cookies
        .layer(tower_http::cors::CorsLayer::permissive())
}

pub(crate) fn err(code: StatusCode, msg: &str) -> Response {
    (code, Json(json!({ "error": msg }))).into_response()
}

#[derive(Deserialize)]
struct TokenQuery {
    t: Option<String>,
}

/// Id do aparelho autenticado (extensão do pedido)
#[derive(Clone)]
pub(crate) struct DeviceId(pub(crate) String);

async fn auth(Query(q): Query<TokenQuery>, headers: HeaderMap, mut req: Request, next: Next) -> Response {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::to_string)
        .or(q.t);
    let Some(token) = token.filter(|t| !t.is_empty()) else {
        return err(StatusCode::UNAUTHORIZED, "não pareado");
    };
    let h = hash(&token);
    let id = {
        let mut s = state();
        let id = s.saved.devices.iter().find(|d| d.token_hash == h).map(|d| d.id.clone());
        if let Some(id) = &id {
            s.last_seen.insert(id.clone(), now());
        }
        id
    };
    match id {
        Some(id) => {
            req.extensions_mut().insert(DeviceId(id));
            next.run(req).await
        }
        None => err(StatusCode::UNAUTHORIZED, "aparelho não reconhecido; pareie de novo"),
    }
}

async fn api_hello() -> Response {
    Json(json!({ "app": "lumo", "name": hostname(), "version": env!("CARGO_PKG_VERSION") })).into_response()
}

#[derive(Deserialize)]
struct PairReq {
    pin: String,
    name: String,
}

async fn api_pair(Json(req): Json<PairReq>) -> Response {
    let mut s = state();
    let valid = s.pin.as_ref().filter(|(_, exp)| *exp > now()).map(|(p, _)| p.clone());
    let Some(pin) = valid else {
        return err(StatusCode::FORBIDDEN, "PIN expirado; gere outro no PC");
    };
    if req.pin.trim() != pin {
        s.tries += 1;
        if s.tries >= MAX_TRIES {
            // Muitas tentativas: invalida o PIN (o PC mostra um novo)
            s.pin = None;
            s.tries = 0;
            drop(s);
            changed();
            return err(StatusCode::FORBIDDEN, "PIN errado muitas vezes; use o novo PIN do PC");
        }
        return err(StatusCode::FORBIDDEN, "PIN incorreto");
    }
    let token = base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, random_bytes(32));
    let id = hash(&token)[..12].to_string();
    let name: String = req.name.trim().chars().take(40).collect();
    let name = if name.is_empty() { "Celular".to_string() } else { name };
    s.saved.devices.push(Device { id: id.clone(), name: name.clone(), token_hash: hash(&token), paired_at: now() });
    s.last_seen.insert(id.clone(), now());
    // PIN de uso único
    s.pin = None;
    s.tries = 0;
    persist(&s);
    drop(s);
    changed();
    notify("Celular conectado", &format!("{} agora fala com o Lumo deste PC.", name));
    Json(json!({ "token": token, "id": id, "name": hostname() })).into_response()
}

async fn api_unpair(axum::Extension(DeviceId(id)): axum::Extension<DeviceId>) -> Response {
    bridge_forget(id);
    changed();
    Json(json!({ "ok": true })).into_response()
}

pub(crate) fn notify(title: &str, body: &str) {
    if let Some(app) = APP.get() {
        crate::system::notify(app.clone(), title.into(), body.into()).ok();
    }
}

async fn api_status() -> Response {
    let stats = crate::linux::system_stats().await;
    let media = crate::linux::media_status().await;
    Json(json!({ "name": hostname(), "version": env!("CARGO_PKG_VERSION"), "stats": stats, "media": media })).into_response()
}

#[derive(Deserialize)]
struct ChatReq {
    text: String,
    #[serde(default)]
    persona: Option<String>,
}

/// Libera a vez do chat quando a conversa termina (mesmo se a tarefa for abortada)
struct ChatTurn;
impl Drop for ChatTurn {
    fn drop(&mut self) {
        CHAT_BUSY.store(false, Ordering::Release);
    }
}

/// Conversa com o cérebro do PC. Resposta em NDJSON: um evento do agente por linha
/// (os mesmos do chat do PC) e, no fim, {"type":"end"} ou {"type":"error"}.
async fn api_chat(Json(req): Json<ChatReq>) -> Response {
    let text: String = req.text.trim().chars().take(MAX_TEXT).collect();
    if text.is_empty() {
        return err(StatusCode::BAD_REQUEST, "mensagem vazia");
    }
    if CHAT_BUSY.swap(true, Ordering::AcqRel) {
        return err(StatusCode::CONFLICT, "já estou respondendo outra mensagem do celular");
    }
    let turn = ChatTurn;
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let events_tx = tx.clone();
    let events = Channel::<AgentEvent>::new(move |body| {
        let line = match body {
            InvokeResponseBody::Json(s) => s,
            InvokeResponseBody::Raw(b) => String::from_utf8_lossy(&b).into_owned(),
        };
        // Celular saiu no meio: não deixa um pedido de aprovação esperando para sempre
        if events_tx.send(line + "\n").is_err() {
            agent::agent_cancel();
        }
        Ok(())
    });
    tauri::async_runtime::spawn(async move {
        let _turn = turn;
        let result = orchestrator::brain_send(SendReq { text, auto_approve: false, persona: req.persona }, events).await;
        let end = match result {
            Ok(()) => json!({ "type": "end" }),
            Err(e) => json!({ "type": "error", "text": e }),
        };
        tx.send(end.to_string() + "\n").ok();
    });
    let stream = tokio_stream::wrappers::UnboundedReceiverStream::new(rx).map(Ok::<_, std::convert::Infallible>);
    Response::builder()
        .header(header::CONTENT_TYPE, "application/x-ndjson; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-cache")
        .header("x-accel-buffering", "no")
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "falha ao abrir a resposta"))
}

#[derive(Deserialize)]
struct ApproveReq {
    id: String,
    approved: bool,
}

async fn api_approve(Json(req): Json<ApproveReq>) -> Response {
    agent::agent_approve(req.id, req.approved);
    Json(json!({ "ok": true })).into_response()
}

async fn api_cancel() -> Response {
    agent::agent_cancel();
    Json(json!({ "ok": true })).into_response()
}

#[derive(Deserialize)]
struct AskReq {
    prompt: String,
}

async fn api_ask(Json(req): Json<AskReq>) -> Response {
    let prompt: String = req.prompt.chars().take(MAX_TEXT).collect();
    match orchestrator::brain_ask(prompt).await {
        Ok(text) => Json(json!({ "text": text })).into_response(),
        Err(e) => err(StatusCode::BAD_GATEWAY, &e),
    }
}

#[derive(Deserialize)]
struct MediaReq {
    action: String,
}

async fn api_media(Json(req): Json<MediaReq>) -> Response {
    match crate::linux::media_control(req.action).await {
        Ok(()) => Json(json!({ "media": crate::linux::media_status().await })).into_response(),
        Err(e) => err(StatusCode::BAD_REQUEST, &e),
    }
}

#[derive(Deserialize)]
struct OpenReq {
    url: String,
}

async fn api_open(Json(req): Json<OpenReq>) -> Response {
    match crate::linux::open_url(req.url.trim().to_string()) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => err(StatusCode::BAD_REQUEST, &e),
    }
}

/// Primeiro programa de área de transferência disponível (Wayland ou X11)
fn clip_tool(write: bool) -> Option<(&'static str, Vec<&'static str>)> {
    let wayland = std::env::var("WAYLAND_DISPLAY").is_ok();
    let candidates: Vec<(&str, Vec<&str>)> = match (write, wayland) {
        (true, true) => vec![("wl-copy", vec![]), ("xclip", vec!["-selection", "clipboard"]), ("xsel", vec!["-ib"])],
        (true, false) => vec![("xclip", vec!["-selection", "clipboard"]), ("xsel", vec!["-ib"]), ("wl-copy", vec![])],
        (false, true) => vec![("wl-paste", vec!["-n"]), ("xclip", vec!["-selection", "clipboard", "-o"]), ("xsel", vec!["-ob"])],
        (false, false) => vec![("xclip", vec!["-selection", "clipboard", "-o"]), ("xsel", vec!["-ob"]), ("wl-paste", vec!["-n"])],
    };
    candidates.into_iter().find(|(bin, _)| {
        std::process::Command::new("sh").args(["-c", &format!("command -v {} >/dev/null", bin)]).status().map(|s| s.success()).unwrap_or(false)
    })
}

async fn api_clip_get() -> Response {
    let Some((bin, args)) = clip_tool(false) else {
        return err(StatusCode::NOT_IMPLEMENTED, "instale wl-clipboard ou xclip no PC");
    };
    let out = tokio::process::Command::new(bin).args(args).output().await;
    match out {
        Ok(o) => Json(json!({ "text": String::from_utf8_lossy(&o.stdout).chars().take(MAX_TEXT).collect::<String>() })).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

#[derive(Deserialize)]
struct ClipReq {
    text: String,
}

async fn api_clip_set(Json(req): Json<ClipReq>) -> Response {
    let text: String = req.text.chars().take(MAX_TEXT).collect();
    let Some((bin, args)) = clip_tool(true) else {
        return err(StatusCode::NOT_IMPLEMENTED, "instale wl-clipboard ou xclip no PC");
    };
    let child = tokio::process::Command::new(bin)
        .args(args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    };
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(text.as_bytes()).await.ok();
    }
    // wl-copy/xclip ficam vivos servindo a seleção: não espera por eles
    tauri::async_runtime::spawn(async move {
        child.wait().await.ok();
    });
    notify("Texto do celular", "Copiado para a área de transferência.");
    Json(json!({ "ok": true })).into_response()
}

#[derive(Deserialize)]
struct PingReq {
    #[serde(default)]
    text: String,
}

/// "Chamar o PC": aviso na pílula e notificação do sistema
async fn api_ping(axum::Extension(DeviceId(id)): axum::Extension<DeviceId>, Json(req): Json<PingReq>) -> Response {
    let name = state().saved.devices.iter().find(|d| d.id == id).map(|d| d.name.clone()).unwrap_or_else(|| "Celular".into());
    let text: String = req.text.replace('|', "/").chars().take(200).collect();
    let text = if text.trim().is_empty() { "Oi! 👋".to_string() } else { text };
    if let Some(app) = APP.get() {
        crate::system::emit_action(app, &format!("notice:{} | {}", name, text));
    }
    Json(json!({ "ok": true })).into_response()
}

// ---- App móvel (arquivos estáticos) ------------------------------------------------------

pub(crate) fn mime_of(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "webmanifest" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        "pdf" => "application/pdf",
        "txt" | "md" => "text/plain; charset=utf-8",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

/// Serve o app móvel (build em dist/mobile). Rotas sem extensão caem no index.html dele.
async fn static_file(req: Request) -> Response {
    let Some(app) = APP.get() else {
        return err(StatusCode::SERVICE_UNAVAILABLE, "iniciando");
    };
    let path = req.uri().path().trim_start_matches('/');
    let is_file = path.rsplit('/').next().map(|last| last.contains('.')).unwrap_or(false);
    let key = if path.contains("..") || !is_file {
        "/mobile/index.html".to_string()
    } else if path.starts_with("assets/") {
        // Os assets gerados (dist/assets) são compartilhados com o app do PC
        format!("/{}", path)
    } else {
        format!("/mobile/{}", path)
    };
    let Some(asset) = app.asset_resolver().get(key.clone()) else {
        return err(StatusCode::NOT_FOUND, "app móvel não encontrado (rode npm run build)");
    };
    // O Tauri devolve o index.html do PC quando não acha o arquivo: aqui isso é 404
    let mime = mime_of(&key);
    let looks_html = asset.bytes().iter().take(64).map(|b| b.to_ascii_lowercase()).collect::<Vec<_>>().starts_with(b"<!doctype html");
    if looks_html && !mime.starts_with("text/html") {
        return err(StatusCode::NOT_FOUND, "arquivo não encontrado");
    }
    let cache = if path.starts_with("assets/") { "public, max-age=31536000, immutable" } else { "no-cache" };
    Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, cache)
        .body(Body::from(asset.bytes().to_vec()))
        .unwrap_or_else(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "falha"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ponta a ponta sem o app: sobe o servidor, pareia com o PIN e troca um arquivo
    #[tokio::test]
    async fn pareia_e_troca_arquivo() {
        let home = std::env::temp_dir().join(format!("lumo-ponte-{}", now()));
        std::fs::create_dir_all(&home).unwrap();
        std::env::set_var("HOME", &home);
        state().pin = Some(("123456".into(), now() + 60));

        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, router()).await.unwrap() });
        let http = reqwest::Client::new();

        let hello: serde_json::Value = http.get(format!("{}/api/hello", base)).send().await.unwrap().json().await.unwrap();
        assert_eq!(hello["app"], "lumo");

        // Sem token: barrado
        assert_eq!(http.get(format!("{}/api/cloud/list", base)).send().await.unwrap().status(), 401);
        // PIN errado
        let bad = http.post(format!("{}/api/pair", base)).json(&json!({"pin": "000000", "name": "Teste"})).send().await.unwrap();
        assert_eq!(bad.status(), 403);
        // PIN certo
        let ok: serde_json::Value = http.post(format!("{}/api/pair", base)).json(&json!({"pin": "123456", "name": "Teste"})).send().await.unwrap().json().await.unwrap();
        let token = ok["token"].as_str().unwrap().to_string();
        // PIN é de uso único
        let again = http.post(format!("{}/api/pair", base)).json(&json!({"pin": "123456", "name": "Outro"})).send().await.unwrap();
        assert_eq!(again.status(), 403);

        // Envio com nome malicioso fica preso na nuvem
        let up: serde_json::Value = http
            .post(format!("{}/api/cloud/upload?path=fotos", base))
            .bearer_auth(&token)
            .header("x-file-name", crate::cloud::urlencode("../../Relatório.txt"))
            .body("olá do celular")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(up["name"], "Relatório.txt");
        assert_eq!(up["path"], "fotos/Relatório.txt");

        let list: serde_json::Value = http.get(format!("{}/api/cloud/list?path=fotos", base)).bearer_auth(&token).send().await.unwrap().json().await.unwrap();
        assert_eq!(list["entries"][0]["name"], "Relatório.txt");
        let fora = http.get(format!("{}/api/cloud/list?path=..", base)).bearer_auth(&token).send().await.unwrap();
        assert_eq!(fora.status(), 400);

        // Download por ?t= (link direto no navegador do celular)
        let body = http
            .get(format!("{}/api/cloud/file?path={}&t={}", base, crate::cloud::urlencode("fotos/Relatório.txt"), token))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert_eq!(body, "olá do celular");

        // Apagar manda para a lixeira da nuvem
        http.post(format!("{}/api/cloud/delete", base)).bearer_auth(&token).json(&json!({"path": "fotos/Relatório.txt"})).send().await.unwrap();
        assert!(shared_dir().join(".lixeira/Relatório.txt").exists());

        // Banco de dados: grava, lista, apaga
        let put = http.put(format!("{}/api/db/notas/n1", base)).bearer_auth(&token).json(&json!({"data": {"texto": "comprar pão"}})).send().await.unwrap();
        assert_eq!(put.status(), 200);
        let docs: serde_json::Value = http.get(format!("{}/api/db/notas", base)).bearer_auth(&token).send().await.unwrap().json().await.unwrap();
        assert_eq!(docs["docs"][0]["data"]["texto"], "comprar pão");
        http.delete(format!("{}/api/db/notas/n1", base)).bearer_auth(&token).send().await.unwrap();
        let docs: serde_json::Value = http.get(format!("{}/api/db/notas", base)).bearer_auth(&token).send().await.unwrap().json().await.unwrap();
        assert_eq!(docs["docs"].as_array().unwrap().len(), 0);
        assert_eq!(http.put(format!("{}/api/db/..%2Fx/n1", base)).bearer_auth(&token).json(&json!({"data": 1})).send().await.unwrap().status(), 400);

        // Desparear derruba o token
        http.post(format!("{}/api/unpair", base)).bearer_auth(&token).send().await.unwrap();
        assert_eq!(http.get(format!("{}/api/cloud/list", base)).bearer_auth(&token).send().await.unwrap().status(), 401);
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn pin_tem_seis_digitos() {
        for _ in 0..50 {
            let p = new_pin();
            assert_eq!(p.len(), 6);
            assert!(p.chars().all(|c| c.is_ascii_digit()));
        }
    }
}
