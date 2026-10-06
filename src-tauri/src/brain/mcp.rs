// Plugins externos pelo protocolo MCP (Model Context Protocol), via stdio: o Lumo inicia
// o servidor (ex.: `npx -y @modelcontextprotocol/server-filesystem ~`), lista as
// ferramentas dele e as oferece ao modelo como `plugin__ferramenta`.
// Config em <config do app>/plugins.json.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{oneshot, Mutex};

#[derive(Serialize, Deserialize, Clone)]
pub struct PluginCfg {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default = "yes")]
    pub enabled: bool,
    /// Ferramentas dele rodam sem pedir aprovação a cada uso
    #[serde(default)]
    pub trusted: bool,
}

fn yes() -> bool {
    true
}

#[derive(Clone)]
pub struct McpTool {
    pub plugin: String,
    pub name: String,
    pub description: String,
    pub schema: Value,
}

type Pending = Arc<StdMutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

struct Client {
    stdin: Mutex<tokio::process::ChildStdin>,
    pending: Pending,
    next: std::sync::atomic::AtomicU64,
    tools: Vec<McpTool>,
    _child: tokio::process::Child,
}

static CLIENTS: std::sync::OnceLock<Mutex<HashMap<String, Arc<Client>>>> = std::sync::OnceLock::new();
static ERRORS: StdMutex<Option<HashMap<String, String>>> = StdMutex::new(None);

fn clients() -> &'static Mutex<HashMap<String, Arc<Client>>> {
    CLIENTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn set_error(name: &str, err: Option<String>) {
    let mut g = ERRORS.lock().unwrap_or_else(|e| e.into_inner());
    let m = g.get_or_insert_with(HashMap::new);
    match err {
        Some(e) => m.insert(name.into(), e),
        None => m.remove(name),
    };
}

fn cfg_path() -> Option<std::path::PathBuf> {
    super::dir().map(|d| d.join("plugins.json"))
}

pub fn load() -> Vec<PluginCfg> {
    cfg_path().and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save(list: &[PluginCfg]) -> Result<(), String> {
    let p = cfg_path().ok_or("pasta de configuração indisponível")?;
    std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(p, serde_json::to_vec_pretty(list).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

fn sanitize(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect()
}

impl Client {
    async fn request(&self, method: &str, params: Value, timeout: u64) -> Result<Value, String> {
        let id = self.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap_or_else(|e| e.into_inner()).insert(id, tx);
        let line = format!("{}\n", json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        {
            let mut w = self.stdin.lock().await;
            w.write_all(line.as_bytes()).await.map_err(|e| format!("plugin fora do ar: {}", e))?;
            w.flush().await.ok();
        }
        match tokio::time::timeout(Duration::from_secs(timeout), rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => Err("o plugin encerrou".into()),
            Err(_) => {
                self.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
                Err("tempo esgotado esperando o plugin".into())
            }
        }
    }

    async fn notify(&self, method: &str) {
        let line = format!("{}\n", json!({ "jsonrpc": "2.0", "method": method }));
        let mut w = self.stdin.lock().await;
        w.write_all(line.as_bytes()).await.ok();
        w.flush().await.ok();
    }
}

async fn start(cfg: &PluginCfg) -> Result<Arc<Client>, String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut cmd = tokio::process::Command::new("bash");
    // bash -lc: pega o PATH do usuário (npx, uvx, node via nvm/proto…)
    let line = std::iter::once(cfg.command.clone()).chain(cfg.args.iter().map(|a| shell_quote(&crate::agent::expand_home(a)))).collect::<Vec<_>>().join(" ");
    cmd.args(["-lc", &line]).current_dir(&home).envs(&cfg.env).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| format!("não consegui iniciar: {}", e))?;
    let stdin = child.stdin.take().ok_or("sem stdin")?;
    let stdout = child.stdout.take().ok_or("sem stdout")?;
    let pending: Pending = Arc::new(StdMutex::new(HashMap::new()));
    let p2 = pending.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            let Some(id) = v["id"].as_u64() else { continue }; // notificações/pedidos do servidor: ignorados
            if let Some(tx) = p2.lock().unwrap_or_else(|e| e.into_inner()).remove(&id) {
                let r = if v["error"].is_null() { Ok(v["result"].clone()) } else { Err(v["error"]["message"].as_str().unwrap_or("erro do plugin").to_string()) };
                tx.send(r).ok();
            }
        }
        // saiu: acorda quem ainda esperava
        p2.lock().unwrap_or_else(|e| e.into_inner()).clear();
    });
    let mut client = Client { stdin: Mutex::new(stdin), pending, next: 1.into(), tools: vec![], _child: child };
    client
        .request(
            "initialize",
            json!({ "protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": { "name": "lumo", "version": env!("CARGO_PKG_VERSION") } }),
            90, // npx pode baixar o pacote na primeira vez
        )
        .await?;
    client.notify("notifications/initialized").await;
    let listed = client.request("tools/list", json!({}), 30).await?;
    client.tools = listed["tools"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|t| {
                    Some(McpTool {
                        plugin: cfg.name.clone(),
                        name: t["name"].as_str()?.to_string(),
                        description: t["description"].as_str().unwrap_or("").chars().take(400).collect(),
                        schema: if t["inputSchema"].is_object() { t["inputSchema"].clone() } else { json!({ "type": "object", "properties": {} }) },
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(Arc::new(client))
}

fn shell_quote(s: &str) -> String {
    if s.chars().all(|c| c.is_ascii_alphanumeric() || "-_./:@=+,".contains(c)) {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

async fn ensure(cfg: &PluginCfg) -> Result<Arc<Client>, String> {
    if let Some(c) = clients().lock().await.get(&cfg.name) {
        return Ok(c.clone());
    }
    match start(cfg).await {
        Ok(c) => {
            set_error(&cfg.name, None);
            clients().lock().await.insert(cfg.name.clone(), c.clone());
            Ok(c)
        }
        Err(e) => {
            set_error(&cfg.name, Some(e.clone()));
            Err(e)
        }
    }
}

/// Inicia em segundo plano os plugins ativos (para as ferramentas já estarem prontas)
pub fn spawn_autostart() {
    tauri::async_runtime::spawn(async {
        for cfg in load().into_iter().filter(|c| c.enabled) {
            ensure(&cfg).await.ok();
        }
    });
}

/// Ferramentas de todos os plugins ativos que estão no ar (não espera os que ainda estão subindo)
pub async fn tools() -> Vec<McpTool> {
    let map = clients().lock().await;
    let enabled: Vec<String> = load().into_iter().filter(|c| c.enabled).map(|c| c.name).collect();
    map.iter().filter(|(n, _)| enabled.contains(n)).flat_map(|(_, c)| c.tools.clone()).collect()
}

pub fn exposed_name(t: &McpTool) -> String {
    let n = format!("{}__{}", sanitize(&t.plugin), sanitize(&t.name));
    n.chars().take(64).collect()
}

pub fn is_trusted(plugin: &str) -> bool {
    load().iter().any(|c| c.name == plugin && c.trusted)
}

/// Resolve o nome exposto ao modelo e chama a ferramenta
pub async fn call(exposed: &str, args: Value) -> Result<(String, String, String), String> {
    let tool = tools().await.into_iter().find(|t| exposed_name(t) == exposed).ok_or_else(|| format!("ferramenta {} não encontrada", exposed))?;
    let client = clients().lock().await.get(&tool.plugin).cloned().ok_or("plugin não está rodando")?;
    let res = client.request("tools/call", json!({ "name": tool.name, "arguments": args }), 120).await?;
    let mut out = String::new();
    for c in res["content"].as_array().cloned().unwrap_or_default() {
        match c["type"].as_str() {
            Some("text") => out.push_str(c["text"].as_str().unwrap_or("")),
            Some(other) => out.push_str(&format!("[conteúdo {} omitido]", other)),
            None => {}
        }
        out.push('\n');
    }
    if res["isError"].as_bool().unwrap_or(false) {
        out = format!("ERRO do plugin: {}", out);
    }
    Ok((tool.plugin, tool.name, out))
}

#[derive(Serialize)]
pub struct PluginStatus {
    #[serde(flatten)]
    pub cfg: PluginCfg,
    pub running: bool,
    pub tools: Vec<String>,
    pub error: String,
}

pub async fn status() -> Vec<PluginStatus> {
    let map = clients().lock().await;
    let errors = ERRORS.lock().unwrap_or_else(|e| e.into_inner()).clone().unwrap_or_default();
    load()
        .into_iter()
        .map(|cfg| {
            let c = map.get(&cfg.name);
            PluginStatus { running: c.is_some(), tools: c.map(|c| c.tools.iter().map(|t| t.name.clone()).collect()).unwrap_or_default(), error: errors.get(&cfg.name).cloned().unwrap_or_default(), cfg }
        })
        .collect()
}

pub async fn add(cfg: PluginCfg) -> Result<(), String> {
    let name = sanitize(cfg.name.trim());
    if name.is_empty() || cfg.command.trim().is_empty() {
        return Err("Informe um nome e o comando do plugin.".into());
    }
    let cfg = PluginCfg { name, ..cfg };
    let mut list = load();
    list.retain(|c| c.name != cfg.name);
    list.push(cfg.clone());
    save(&list)?;
    clients().lock().await.remove(&cfg.name);
    if cfg.enabled {
        // a primeira inicialização pode baixar o pacote: o erro aparece na lista
        tauri::async_runtime::spawn(async move {
            ensure(&cfg).await.ok();
        });
    }
    Ok(())
}

pub async fn remove(name: &str) -> Result<(), String> {
    let mut list = load();
    list.retain(|c| c.name != name);
    save(&list)?;
    clients().lock().await.remove(name);
    set_error(name, None);
    Ok(())
}

pub async fn set_enabled(name: &str, enabled: bool) -> Result<(), String> {
    let mut list = load();
    let Some(c) = list.iter_mut().find(|c| c.name == name) else { return Err("plugin não encontrado".into()) };
    c.enabled = enabled;
    let cfg = c.clone();
    save(&list)?;
    if enabled {
        tauri::async_runtime::spawn(async move {
            ensure(&cfg).await.ok();
        });
    } else {
        clients().lock().await.remove(name);
    }
    Ok(())
}

pub async fn set_trusted(name: &str, trusted: bool) -> Result<(), String> {
    let mut list = load();
    if let Some(c) = list.iter_mut().find(|c| c.name == name) {
        c.trusted = trusted;
    }
    save(&list)
}
