// Conta Google: OAuth de app desktop (loopback + PKCE), Gmail somente leitura
// (não lidos) e upload para o Drive sob ação do usuário.
//
// Escopos mínimos:
//   gmail.readonly — listar não lidos (remetente + assunto)
//   drive.file     — o Lumo só enxerga os arquivos que ele mesmo enviar
//
// Client ID/secret de um cliente OAuth do tipo "App para computador", em ordem:
//   1. Config → Contas no próprio Lumo (<config do app>/google-client.json, 0600)
//   2. LUMO_GOOGLE_CLIENT_ID / LUMO_GOOGLE_CLIENT_SECRET no ambiente
//   3. as mesmas variáveis no momento do build (embutidas no pacote)
// O refresh token fica em <config do app>/google.json com permissão 0600.
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
const USERINFO_URL: &str = "https://openidconnect.googleapis.com/v1/userinfo";
const SCOPES: &str = "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive.file";
const LOGIN_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Serialize, Deserialize, Clone)]
struct Saved {
    refresh_token: String,
    email: String,
}

struct Session {
    saved: Saved,
    access_token: String,
    expires_at: u64,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);

#[derive(Serialize, Deserialize, Clone, Default)]
struct ClientCreds {
    client_id: String,
    client_secret: String,
}

#[derive(Serialize)]
pub struct GoogleStatus {
    /// Client ID disponível (sem ele não dá para conectar)
    pub configured: bool,
    /// De onde veio o Client ID: "app" (Config) | "env" | "build" | null
    pub source: Option<String>,
    pub connected: bool,
    pub email: Option<String>,
}

#[derive(Serialize)]
pub struct MailSummary {
    pub id: String,
    pub thread_id: String,
    pub from: String,
    pub subject: String,
    pub snippet: String,
    /// Recebido em (ms desde 1970)
    pub date: u64,
}

#[derive(Serialize)]
pub struct Inbox {
    /// Não lidos na caixa de entrada (contagem real, não só os listados)
    pub total: u64,
    pub messages: Vec<MailSummary>,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn config_file(app: &AppHandle, name: &str) -> Option<std::path::PathBuf> {
    Some(app.path().app_config_dir().ok()?.join(name))
}

fn token_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    config_file(app, "google.json")
}

fn non_empty(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// (client_id, client_secret, origem)
fn client(app: &AppHandle) -> Option<(String, String, &'static str)> {
    let saved: Option<ClientCreds> = config_file(app, "google-client.json")
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok());
    if let Some(c) = saved.filter(|c| !c.client_id.trim().is_empty()) {
        return Some((c.client_id.trim().to_string(), c.client_secret.trim().to_string(), "app"));
    }
    if let Some(id) = non_empty(std::env::var("LUMO_GOOGLE_CLIENT_ID").ok()) {
        let secret = non_empty(std::env::var("LUMO_GOOGLE_CLIENT_SECRET").ok()).unwrap_or_default();
        return Some((id, secret, "env"));
    }
    let id = non_empty(option_env!("LUMO_GOOGLE_CLIENT_ID").map(str::to_string))?;
    let secret = non_empty(option_env!("LUMO_GOOGLE_CLIENT_SECRET").map(str::to_string)).unwrap_or_default();
    Some((id, secret, "build"))
}

fn write_private(path: &std::path::Path, data: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, data).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn load_saved(app: &AppHandle) -> Option<Saved> {
    serde_json::from_slice(&std::fs::read(token_file(app)?).ok()?).ok()
}

fn store_saved(app: &AppHandle, saved: &Saved) -> Result<(), String> {
    let path = token_file(app).ok_or("pasta de configuração indisponível")?;
    write_private(&path, &serde_json::to_vec(saved).map_err(|e| e.to_string())?)
}

fn random_token(bytes: usize) -> Result<String, String> {
    use std::io::Read;
    let mut buf = vec![0u8; bytes];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut buf))
        .map_err(|e| e.to_string())?;
    Ok(URL_SAFE_NO_PAD.encode(buf))
}

async fn post_token(params: &[(&str, &str)]) -> Result<Value, String> {
    let res = reqwest::Client::new()
        .post(TOKEN_URL)
        .form(params)
        .send()
        .await
        .map_err(|e| format!("Google indisponível: {}", e))?;
    let ok = res.status().is_success();
    let body: Value = res.json().await.map_err(|e| e.to_string())?;
    if !ok {
        let msg = body["error_description"].as_str().or(body["error"].as_str()).unwrap_or("erro desconhecido");
        return Err(format!("Google recusou: {}", msg));
    }
    Ok(body)
}

/// Access token válido (renova com o refresh token quando precisa)
async fn access_token(app: &AppHandle) -> Result<String, String> {
    let saved = {
        let guard = SESSION.lock().map_err(|e| e.to_string())?;
        if let Some(s) = guard.as_ref() {
            if s.expires_at > now() + 60 {
                return Ok(s.access_token.clone());
            }
            Some(s.saved.clone())
        } else {
            None
        }
    };
    let saved = saved.or_else(|| load_saved(app)).ok_or("Conta Google não conectada")?;
    let (id, secret, _) = client(app).ok_or("Client ID do Google não configurado (Config → Contas)")?;
    let mut params = vec![
        ("client_id", id.as_str()),
        ("refresh_token", saved.refresh_token.as_str()),
        ("grant_type", "refresh_token"),
    ];
    if !secret.is_empty() {
        params.push(("client_secret", secret.as_str()));
    }
    let body = post_token(&params).await?;
    let token = body["access_token"].as_str().ok_or("resposta sem access_token")?.to_string();
    let expires_at = now() + body["expires_in"].as_u64().unwrap_or(3600);
    *SESSION.lock().map_err(|e| e.to_string())? = Some(Session { saved, access_token: token.clone(), expires_at });
    Ok(token)
}

async fn get_json(app: &AppHandle, url: &str) -> Result<Value, String> {
    let token = access_token(app).await?;
    let res = reqwest::Client::new()
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let ok = res.status().is_success();
    let body: Value = res.json().await.map_err(|e| e.to_string())?;
    if !ok {
        return Err(body["error"]["message"].as_str().unwrap_or("erro do Google").to_string());
    }
    Ok(body)
}

#[tauri::command]
pub fn google_status(app: AppHandle) -> GoogleStatus {
    let email = SESSION
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|s| s.saved.email.clone()))
        .or_else(|| load_saved(&app).map(|s| s.email));
    let source = client(&app).map(|(_, _, s)| s.to_string());
    GoogleStatus { configured: source.is_some(), source, connected: email.is_some(), email }
}

/// Grava (ou apaga, com id vazio) o cliente OAuth informado em Config → Contas
#[tauri::command]
pub fn google_set_client(app: AppHandle, client_id: String, client_secret: String) -> Result<GoogleStatus, String> {
    let path = config_file(&app, "google-client.json").ok_or("pasta de configuração indisponível")?;
    let id = client_id.trim();
    if id.is_empty() {
        std::fs::remove_file(&path).ok();
    } else {
        if !id.ends_with(".apps.googleusercontent.com") {
            return Err("O Client ID termina com .apps.googleusercontent.com".into());
        }
        let creds = ClientCreds { client_id: id.to_string(), client_secret: client_secret.trim().to_string() };
        write_private(&path, &serde_json::to_vec(&creds).map_err(|e| e.to_string())?)?;
    }
    Ok(google_status(app))
}

/// Abre o navegador para o consentimento e espera o retorno em 127.0.0.1
#[tauri::command]
pub async fn google_connect(app: AppHandle) -> Result<GoogleStatus, String> {
    let (id, secret, _) = client(&app).ok_or("Configure o Client ID do Google em Config → Contas.")?;
    let verifier = random_token(48)?;
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = random_token(16)?;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    let redirect = format!("http://127.0.0.1:{}", listener.local_addr().map_err(|e| e.to_string())?.port());

    let mut url = reqwest::Url::parse(AUTH_URL).map_err(|e| e.to_string())?;
    url.query_pairs_mut()
        .append_pair("client_id", &id)
        .append_pair("redirect_uri", &redirect)
        .append_pair("response_type", "code")
        .append_pair("scope", SCOPES)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &state)
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent");
    std::process::Command::new("xdg-open")
        .arg(url.as_str())
        .spawn()
        .map_err(|e| format!("Não consegui abrir o navegador: {}", e))?;

    // Espera o redirecionamento do Google (uma requisição GET /?code=…&state=…)
    let code = tokio::time::timeout(LOGIN_TIMEOUT, async {
        loop {
            let (mut sock, _) = listener.accept().await.map_err(|e| e.to_string())?;
            let mut buf = vec![0u8; 8192];
            let n = sock.read(&mut buf).await.map_err(|e| e.to_string())?;
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            let path = req.split_whitespace().nth(1).unwrap_or("/").to_string();
            let parsed = reqwest::Url::parse(&format!("http://localhost{}", path)).map_err(|e| e.to_string())?;
            let get = |k: &str| parsed.query_pairs().find(|(key, _)| key == k).map(|(_, v)| v.to_string());
            if get("code").is_none() && get("error").is_none() {
                continue; // ex.: /favicon.ico
            }
            let ok = get("state").as_deref() == Some(state.as_str()) && get("code").is_some();
            let page = if ok { "Lumo conectado ao Google. Pode fechar esta aba." } else { "Não foi possível conectar o Lumo. Pode fechar esta aba." };
            let html = format!("<!doctype html><meta charset=utf-8><title>Lumo</title><body style=\"font:16px system-ui;background:#000;color:#eee;display:grid;place-items:center;height:100vh;margin:0\">{}</body>", page);
            let resp = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", html.len(), html);
            sock.write_all(resp.as_bytes()).await.ok();
            if !ok {
                return Err(get("error").unwrap_or_else(|| "resposta inválida do Google".into()));
            }
            return Ok::<String, String>(get("code").unwrap_or_default());
        }
    })
    .await
    .map_err(|_| "Tempo esgotado esperando o login no navegador.".to_string())??;

    let mut params = vec![
        ("client_id", id.as_str()),
        ("code", code.as_str()),
        ("code_verifier", verifier.as_str()),
        ("redirect_uri", redirect.as_str()),
        ("grant_type", "authorization_code"),
    ];
    if !secret.is_empty() {
        params.push(("client_secret", secret.as_str()));
    }
    let body = post_token(&params).await?;
    let access = body["access_token"].as_str().ok_or("resposta sem access_token")?.to_string();
    let refresh = body["refresh_token"].as_str().ok_or("o Google não devolveu refresh token")?.to_string();
    let expires_at = now() + body["expires_in"].as_u64().unwrap_or(3600);

    let info: Value = reqwest::Client::new()
        .get(USERINFO_URL)
        .bearer_auth(&access)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let saved = Saved { refresh_token: refresh, email: info["email"].as_str().unwrap_or("conta Google").to_string() };
    store_saved(&app, &saved)?;
    *SESSION.lock().map_err(|e| e.to_string())? = Some(Session { saved, access_token: access, expires_at });
    Ok(google_status(app))
}

#[tauri::command]
pub async fn google_disconnect(app: AppHandle) -> Result<GoogleStatus, String> {
    let token = SESSION
        .lock()
        .ok()
        .and_then(|mut g| g.take().map(|s| s.saved.refresh_token))
        .or_else(|| load_saved(&app).map(|s| s.refresh_token));
    if let Some(t) = token {
        // Revoga no Google (melhor esforço) e apaga o arquivo local
        reqwest::Client::new().post(REVOKE_URL).form(&[("token", t)]).send().await.ok();
    }
    if let Some(path) = token_file(&app) {
        std::fs::remove_file(path).ok();
    }
    Ok(google_status(app))
}

/// Não lidos da caixa de entrada: contagem real + os 8 mais recentes
#[tauri::command]
pub async fn gmail_unread(app: AppHandle) -> Result<Inbox, String> {
    let inbox = gmail_query(&app, "is:unread in:inbox", 8).await?;
    let label = get_json(&app, "https://gmail.googleapis.com/gmail/v1/users/me/labels/INBOX").await?;
    let total = label["messagesUnread"].as_u64().unwrap_or(inbox.messages.len() as u64);
    Ok(Inbox { total, messages: inbox.messages })
}

/// Conta Google conectada? (sem rede)
pub fn connected() -> bool {
    let Some(app) = crate::brain::try_app() else { return false };
    SESSION.lock().map(|g| g.is_some()).unwrap_or(false) || load_saved(&app).is_some()
}

/// Busca e-mails pela sintaxe do Gmail (usada pelo agente e pela contagem de não lidos)
pub async fn gmail_query(app: &AppHandle, query: &str, max: usize) -> Result<Inbox, String> {
    let app = app.clone();
    let q: String = reqwest::Url::parse_with_params("http://x/", &[("q", query)]).map(|u| u.query().unwrap_or("").trim_start_matches("q=").to_string()).unwrap_or_default();
    let list = get_json(&app, &format!("https://gmail.googleapis.com/gmail/v1/users/me/messages?q={}&maxResults={}", q, max)).await?;
    let ids: Vec<String> = list["messages"]
        .as_array()
        .map(|a| a.iter().filter_map(|m| m["id"].as_str().map(str::to_string)).collect())
        .unwrap_or_default();

    // Metadados em paralelo (uma requisição por e-mail)
    let mut tasks = Vec::new();
    for id in ids {
        let app = app.clone();
        tasks.push(tauri::async_runtime::spawn(async move {
            let url = format!(
                "https://gmail.googleapis.com/gmail/v1/users/me/messages/{}?format=metadata&metadataHeaders=From&metadataHeaders=Subject",
                id
            );
            get_json(&app, &url).await.map(|msg| (id, msg))
        }));
    }
    let mut messages = Vec::new();
    for t in tasks {
        let Ok(Ok((id, msg))) = t.await else { continue };
        let header = |name: &str| {
            msg["payload"]["headers"]
                .as_array()
                .and_then(|hs| hs.iter().find(|h| h["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(name))))
                .and_then(|h| h["value"].as_str())
                .unwrap_or("")
                .to_string()
        };
        // "Fulano <fulano@x.com>" → "Fulano"; só o endereço → o endereço
        let from_raw = header("From");
        let from = from_raw.split('<').next().unwrap_or("").trim().trim_matches('"').to_string();
        let from = if from.is_empty() { from_raw.trim_matches(|c| c == '<' || c == '>').to_string() } else { from };
        messages.push(MailSummary {
            id,
            thread_id: msg["threadId"].as_str().unwrap_or("").to_string(),
            from,
            subject: header("Subject"),
            snippet: decode_entities(msg["snippet"].as_str().unwrap_or("")),
            date: msg["internalDate"].as_str().and_then(|d| d.parse().ok()).unwrap_or(0),
        });
    }
    messages.sort_by(|a, b| b.date.cmp(&a.date));
    let total = messages.len() as u64;
    Ok(Inbox { total, messages })
}

/// O snippet do Gmail vem com entidades HTML (&#39; &amp; …)
fn decode_entities(s: &str) -> String {
    s.replace("&#39;", "'")
        .replace("&quot;", "\"")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
}

/// Envia um arquivo para o Drive (escopo drive.file). Devolve o link de visualização.
/// `path` = arquivo do disco (arrastado para o Lumo); senão `data_base64`.
#[tauri::command]
pub async fn drive_upload(
    app: AppHandle,
    name: String,
    mime: String,
    data_base64: Option<String>,
    path: Option<String>,
) -> Result<String, String> {
    let token = access_token(&app).await?;
    let data = match (path, data_base64) {
        (Some(p), _) => std::fs::read(&p).map_err(|e| format!("não consegui ler {}: {}", p, e))?,
        (None, Some(b)) => STANDARD.decode(b).map_err(|e| e.to_string())?,
        (None, None) => return Err("nada para enviar".into()),
    };
    let boundary = format!("lumo-{}", random_token(12)?);
    let meta = serde_json::json!({ "name": name }).to_string();
    let mut body = Vec::with_capacity(data.len() + 512);
    body.extend_from_slice(
        format!("--{b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta}\r\n--{b}\r\nContent-Type: {mime}\r\n\r\n", b = boundary, meta = meta, mime = mime)
            .as_bytes(),
    );
    body.extend_from_slice(&data);
    body.extend_from_slice(format!("\r\n--{}--\r\n", boundary).as_bytes());

    let res = reqwest::Client::new()
        .post("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink")
        .bearer_auth(token)
        .header("Content-Type", format!("multipart/related; boundary={}", boundary))
        .body(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let ok = res.status().is_success();
    let v: Value = res.json().await.map_err(|e| e.to_string())?;
    if !ok {
        return Err(v["error"]["message"].as_str().unwrap_or("falha no upload").to_string());
    }
    Ok(v["webViewLink"].as_str().unwrap_or("").to_string())
}
