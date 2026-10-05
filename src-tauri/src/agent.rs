// Agente do chat: a IA pode executar comandos no terminal, ler e escrever arquivos
// para cumprir o que o usuário pediu ("instale este programa", "converta este PDF"…).
//
// Segurança:
//   • cada comando/escrita aparece no chat e só roda depois de o usuário aprovar
//     (no modo automático, comandos perigosos continuam pedindo aprovação);
//   • `sudo` pede a senha numa janela gráfica (zenity via SUDO_ASKPASS) — o Lumo nunca
//     vê nem guarda a senha;
//   • "Parar" cancela o passo atual e mata o comando em execução.
//
// Formatos: "openai" (ferramentas nativas: OpenAI, Groq, OpenRouter, Cerebras, Mistral,
// NVIDIA, Gemini e Ollama pelo endpoint compatível), "claude" (tool_use) e "text"
// (modelos sem ferramentas: o comando vem num bloco <run>…</run>).
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::ipc::Channel;
use tokio::io::{AsyncReadExt, BufReader};
use tokio::sync::oneshot;

const MAX_STEPS: usize = 25;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const OUTPUT_TO_MODEL: usize = 8000;
const READ_LIMIT: usize = 100_000;

#[derive(Deserialize)]
pub struct Turn {
    pub role: String, // "user" | "assistant"
    pub content: String,
}

#[derive(Deserialize)]
pub struct AgentRequest {
    pub format: String, // "openai" | "claude" | "text"
    pub label: String,  // nome do provedor (mensagens de erro)
    pub endpoint: Option<String>,
    pub api_key: Option<String>,
    pub model: String,
    pub history: Vec<Turn>,
    pub auto_approve: bool,
    /// Tempo máximo esperando cada resposta do modelo (s). Estourou → a interface
    /// tenta outro provedor/modelo.
    #[serde(default)]
    pub timeout_secs: Option<u64>,
    /// Personalidade da paleta ativa (tom das respostas) — vem da interface
    #[serde(default)]
    pub persona: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    /// Texto da IA (um passo inteiro)
    Text { text: String },
    /// A IA quer rodar um comando
    Command { id: String, command: String, reason: String, needs_approval: bool },
    /// Saída do comando, linha a linha
    Output { id: String, line: String },
    /// Fim do comando (`code` = None se recusado/cancelado)
    CommandDone { id: String, code: Option<i32>, approved: bool },
    /// A IA quer gravar um arquivo
    Write { id: String, path: String, preview: String, needs_approval: bool },
    WriteDone { id: String, approved: bool, error: Option<String> },
    /// A IA leu um arquivo
    Read { path: String },
    /// O provedor não suporta ferramentas: o Lumo trocou para o modo texto
    Notice { text: String },
}

static PENDING: Mutex<Option<HashMap<String, oneshot::Sender<bool>>>> = Mutex::new(None);
static CANCELLED: AtomicBool = AtomicBool::new(false);
static RUNNING_PID: AtomicU32 = AtomicU32::new(0);
static COUNTER: AtomicU32 = AtomicU32::new(0);

fn next_id() -> String {
    format!("cmd-{}", COUNTER.fetch_add(1, Ordering::Relaxed))
}

/// Resposta do usuário a um pedido de aprovação
#[tauri::command]
pub fn agent_approve(id: String, approved: bool) {
    if let Some(tx) = PENDING.lock().ok().and_then(|mut p| p.as_mut().and_then(|m| m.remove(&id))) {
        tx.send(approved).ok();
    }
}

/// Botão "Parar": recusa o que estiver pendente e mata o comando em execução
#[tauri::command]
pub fn agent_cancel() {
    CANCELLED.store(true, Ordering::Relaxed);
    if let Ok(mut p) = PENDING.lock() {
        if let Some(m) = p.as_mut() {
            for (_, tx) in m.drain() {
                tx.send(false).ok();
            }
        }
    }
    let pid = RUNNING_PID.swap(0, Ordering::Relaxed);
    if pid != 0 {
        // mata o grupo inteiro (bash + filhos)
        std::process::Command::new("kill").args(["-TERM", &format!("-{}", pid)]).status().ok();
    }
}

async fn ask(id: &str) -> bool {
    let (tx, rx) = oneshot::channel();
    if let Ok(mut p) = PENDING.lock() {
        p.get_or_insert_with(HashMap::new).insert(id.to_string(), tx);
    }
    rx.await.unwrap_or(false)
}

/// Comandos que sempre pedem aprovação, mesmo no modo automático
fn dangerous(cmd: &str) -> bool {
    let c = cmd.to_lowercase();
    ["rm -rf", "rm -fr", "mkfs", "dd if=", "shutdown", "reboot", "poweroff", ":(){", "chmod -r 777 /", "> /dev/sd", "wipefs", "fdisk", "parted", "userdel", "passwd"]
        .iter()
        .any(|p| c.contains(p))
        || c.contains("sudo")
}

// ---- execução -----------------------------------------------------------------------------

/// Script SUDO_ASKPASS: janela gráfica do zenity pedindo a senha
fn askpass() -> Option<String> {
    let path = std::env::temp_dir().join("lumo-askpass.sh");
    if !path.exists() {
        let script = "#!/bin/sh\nexec zenity --password --title='Lumo: senha de administrador' 2>/dev/null\n";
        std::fs::write(&path, script).ok()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).ok()?;
        }
    }
    Some(path.to_string_lossy().into_owned())
}

/// `sudo x` → `sudo -A x` (pede a senha pela janela gráfica)
fn graphical_sudo(cmd: &str) -> String {
    let mut out = String::new();
    let mut rest = cmd;
    while let Some(i) = rest.find("sudo ") {
        let boundary = i == 0 || rest[..i].ends_with(|c: char| c.is_whitespace() || "&|;(`$".contains(c));
        out.push_str(&rest[..i]);
        out.push_str(if boundary && !rest[i + 5..].trim_start().starts_with("-A") { "sudo -A " } else { "sudo " });
        rest = &rest[i + 5..];
    }
    out.push_str(rest);
    out
}

fn shorten(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_string();
    }
    // começo + fim: o fim costuma ter o erro/resultado
    let mut head = limit / 4;
    while !text.is_char_boundary(head) {
        head -= 1;
    }
    let mut tail = text.len() - (limit - head);
    while !text.is_char_boundary(tail) {
        tail += 1;
    }
    format!("{}\n[… {} bytes omitidos …]\n{}", &text[..head], tail - head, &text[tail..])
}

async fn run_shell(id: &str, command: &str, events: &Channel<AgentEvent>) -> (Option<i32>, String) {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
    let mut cmd = tokio::process::Command::new("bash");
    cmd.args(["-lc", &graphical_sudo(command)])
        .current_dir(&home)
        .env("DEBIAN_FRONTEND", "noninteractive")
        .env("TERM", "dumb")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true);
    if let Some(ap) = askpass() {
        cmd.env("SUDO_ASKPASS", ap);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return (None, format!("não consegui iniciar o comando: {}", e)),
    };
    RUNNING_PID.store(child.id().unwrap_or(0), Ordering::Relaxed);

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    for stream in [stdout.map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>), stderr.map(|s| Box::new(s) as Box<_>)]
        .into_iter()
        .flatten()
    {
        let tx = tx.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stream);
            let mut buf = Vec::new();
            // linhas terminadas em \n ou \r (barras de progresso do apt/wget)
            loop {
                let mut byte = [0u8; 1];
                match reader.read(&mut byte).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        if byte[0] == b'\n' || byte[0] == b'\r' {
                            if !buf.is_empty() {
                                tx.send(String::from_utf8_lossy(&buf).into_owned()).ok();
                                buf.clear();
                            }
                        } else {
                            buf.push(byte[0]);
                        }
                    }
                }
            }
            if !buf.is_empty() {
                tx.send(String::from_utf8_lossy(&buf).into_owned()).ok();
            }
        });
    }
    drop(tx);

    let mut collected = String::new();
    let wait = async {
        while let Some(line) = rx.recv().await {
            collected.push_str(&line);
            collected.push('\n');
            if collected.len() > 400_000 {
                collected = shorten(&collected, 200_000);
            }
            events.send(AgentEvent::Output { id: id.to_string(), line }).ok();
        }
        child.wait().await
    };
    let status = tokio::time::timeout(COMMAND_TIMEOUT, wait).await;
    RUNNING_PID.store(0, Ordering::Relaxed);
    match status {
        Ok(Ok(s)) => (s.code(), collected),
        Ok(Err(e)) => (None, format!("{}\n{}", collected, e)),
        Err(_) => (None, format!("{}\n[o comando passou de 20 minutos e foi encerrado]", collected)),
    }
}

fn expand_home(path: &str) -> String {
    match path.strip_prefix("~/") {
        Some(rest) => format!("{}/{}", std::env::var("HOME").unwrap_or_default(), rest),
        None => path.to_string(),
    }
}

fn read_file_tool(path: &str) -> String {
    let path = expand_home(path);
    match std::fs::read(&path) {
        Ok(bytes) => {
            let looks_text = !bytes.iter().take(4096).any(|&b| b == 0);
            if looks_text {
                let text = String::from_utf8_lossy(&bytes[..bytes.len().min(READ_LIMIT)]).into_owned();
                if bytes.len() > READ_LIMIT {
                    format!("{}\n[… arquivo cortado em {} KB de {} KB]", text, READ_LIMIT / 1024, bytes.len() / 1024)
                } else {
                    text
                }
            } else {
                let kind = std::process::Command::new("file")
                    .args(["-b", &path])
                    .output()
                    .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                    .unwrap_or_default();
                format!(
                    "Arquivo binário ({}; {} KB). Use comandos para inspecionar (ex.: pdftotext \"{}\" -, unzip -l, identify, ffprobe).",
                    kind,
                    bytes.len() / 1024,
                    path
                )
            }
        }
        Err(e) => format!("Erro ao ler {}: {}", path, e),
    }
}

// ---- conversa com o modelo ---------------------------------------------------------------

fn system_prompt(format: &str, persona: Option<&str>) -> String {
    let env = |k: &str| std::env::var(k).unwrap_or_default();
    let distro = std::fs::read_to_string("/etc/os-release")
        .ok()
        .and_then(|s| s.lines().find_map(|l| l.strip_prefix("PRETTY_NAME=").map(|v| v.trim_matches('"').to_string())))
        .unwrap_or_else(|| "Linux".into());
    let arch = std::process::Command::new("uname").arg("-m").output().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
    let tools = if format == "text" {
        "Para executar um comando no terminal, responda com UM bloco exatamente assim (e nada depois dele):\n<run>\ncomando aqui\n</run>\nVocê receberá a saída na próxima mensagem. Para ler arquivos use cat/head/pdftotext. Quando terminar, responda normalmente, sem <run>."
    } else {
        "Ferramentas: run_command (executa no bash), read_file (lê arquivo de texto), write_file (grava arquivo)."
    };
    format!(
        "Você é o Lumo, assistente de produtividade que vive na área de trabalho Linux do usuário e TEM acesso ao terminal dele.\n\
Sistema: {distro} ({arch}), desktop {desktop} em {session}, usuário {user}, pasta pessoal {home}. Diretório de trabalho dos comandos: {home}.\n\
{tools}\n\n\
Regras:\n\
- Responda sempre em português do Brasil, de forma curta.\n\
- Quando o usuário pedir uma tarefa (instalar programa, converter arquivo, organizar pastas, ver informações do sistema…), FAÇA usando os comandos, um passo de cada vez, conferindo o resultado de cada um.\n\
- O usuário aprova cada comando; explique em uma frase o que o comando faz (campo reason).\n\
- Pode usar sudo normalmente: a senha é pedida numa janela gráfica. Nunca peça a senha no chat.\n\
- Comandos sempre não interativos: apt-get install -y, sem editores (nano/vim), sem pagers (use | cat ou --no-pager).\n\
- Para instalar programas, nesta ordem: apt (se existir no repositório), o .deb oficial (baixe com wget -O /tmp/nome.deb URL e instale com sudo apt-get install -y /tmp/nome.deb), flatpak (flathub), AppImage (salve em ~/Aplicativos, chmod +x). Para links do GitHub, descubra o arquivo certo pela API: curl -s https://api.github.com/repos/DONO/REPO/releases/latest e procure o asset .deb ou .AppImage para {arch}.\n\
- Depois de instalar, verifique (ex.: which programa ou dpkg -s pacote) e diga como abrir.\n\
- Nunca rode comandos destrutivos (apagar pastas do usuário, formatar, mexer em partições) sem o usuário pedir explicitamente.\n\
- Arquivos anexados vêm com o caminho completo: leia/inspecione antes de agir.\n\
- Ao terminar, resuma o que foi feito em 1–3 frases.{persona}",
        distro = distro,
        arch = arch,
        desktop = env("XDG_CURRENT_DESKTOP"),
        session = env("XDG_SESSION_TYPE"),
        user = env("USER"),
        home = env("HOME"),
        tools = tools,
        persona = persona
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(|p| format!("\n- Personalidade (só o TOM das respostas; não muda as regras acima): {}", p))
            .unwrap_or_default(),
    )
}

fn tool_defs_openai() -> Value {
    json!([
        { "type": "function", "function": {
            "name": "run_command",
            "description": "Executa um comando no bash do usuário (Linux) e devolve a saída. O usuário aprova antes.",
            "parameters": { "type": "object", "properties": {
                "command": { "type": "string", "description": "Comando bash, não interativo" },
                "reason": { "type": "string", "description": "O que o comando faz, em uma frase curta em português" }
            }, "required": ["command", "reason"] } } },
        { "type": "function", "function": {
            "name": "read_file",
            "description": "Lê um arquivo de texto (até 100 KB).",
            "parameters": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] } } },
        { "type": "function", "function": {
            "name": "write_file",
            "description": "Cria ou substitui um arquivo de texto. O usuário aprova antes.",
            "parameters": { "type": "object", "properties": {
                "path": { "type": "string" }, "content": { "type": "string" }
            }, "required": ["path", "content"] } } }
    ])
}

fn tool_defs_claude() -> Value {
    let list = tool_defs_openai();
    Value::Array(
        list.as_array()
            .unwrap()
            .iter()
            .map(|t| {
                let f = &t["function"];
                json!({ "name": f["name"], "description": f["description"], "input_schema": f["parameters"] })
            })
            .collect(),
    )
}

struct Call {
    id: String,
    name: String,
    args: Value,
}

struct Step {
    text: String,
    calls: Vec<Call>,
}

fn base_url(req: &AgentRequest) -> String {
    req.endpoint
        .clone()
        .filter(|e| !e.trim().is_empty())
        .unwrap_or_else(|| "https://api.openai.com/v1".into())
        .trim()
        .trim_end_matches('/')
        .trim_end_matches("/chat/completions")
        .to_string()
}

async fn post(url: &str, headers: &[(&str, String)], body: &Value, label: &str, timeout: u64) -> Result<Value, String> {
    let mut rb = reqwest::Client::new().post(url).timeout(Duration::from_secs(timeout.max(5))).json(body);
    for (k, v) in headers {
        rb = rb.header(*k, v);
    }
    let res = rb.send().await.map_err(|e| {
        if e.is_timeout() {
            format!("tempo esgotado: {} demorou mais de {} s", label, timeout)
        } else {
            format!("Não consegui conectar ao {}: {}", label, e)
        }
    })?;
    let status = res.status();
    let v: Value = res.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        let msg = v["error"]["message"].as_str().or_else(|| v["error"].as_str()).unwrap_or("erro desconhecido");
        return Err(format!("HTTP {} — {} respondeu: {}", status.as_u16(), label, msg));
    }
    Ok(v)
}

async fn step_openai(req: &AgentRequest, messages: &[Value]) -> Result<Step, String> {
    let mut headers = vec![("X-Title", "Lumo".to_string())];
    if let Some(k) = req.api_key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
        headers.push(("Authorization", format!("Bearer {}", k)));
    }
    let body = json!({ "model": req.model, "messages": messages, "tools": tool_defs_openai(), "tool_choice": "auto" });
    let v = post(&format!("{}/chat/completions", base_url(req)), &headers, &body, &req.label, req.timeout_secs.unwrap_or(180)).await?;
    let msg = &v["choices"][0]["message"];
    let calls: Vec<Call> = msg["tool_calls"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|c| Call {
                    id: c["id"].as_str().unwrap_or("call").to_string(),
                    name: c["function"]["name"].as_str().unwrap_or("").to_string(),
                    args: c["function"]["arguments"]
                        .as_str()
                        .and_then(|s| serde_json::from_str(s).ok())
                        .unwrap_or_else(|| c["function"]["arguments"].clone()),
                })
                .collect()
        })
        .unwrap_or_default();
    let text = msg["content"].as_str().unwrap_or("").to_string();
    if calls.is_empty() {
        // Modelos locais às vezes escrevem a chamada no texto em vez de usar tool_calls
        if let Some((call, before)) = parse_inline_call(&text) {
            return Ok(Step { text: before, calls: vec![call] });
        }
    }
    Ok(Step { text, calls })
}

/// `<tool_call>{"name":…,"arguments":…}</tool_call>` ou um bloco ```json com o mesmo formato
fn parse_inline_call(text: &str) -> Option<(Call, String)> {
    let (start, inner) = if let Some(a) = text.find("<tool_call>") {
        let b = text[a..].find("</tool_call>").map(|e| a + e)?;
        (a, &text[a + 11..b])
    } else {
        let a = text.find("```json")?;
        let b = text[a + 7..].find("```").map(|e| a + 7 + e)?;
        (a, &text[a + 7..b])
    };
    let v: Value = serde_json::from_str(inner.trim()).ok()?;
    let name = v["name"].as_str()?.to_string();
    if !matches!(name.as_str(), "run_command" | "read_file" | "write_file") {
        return None;
    }
    let args = match &v["arguments"] {
        Value::String(s) => serde_json::from_str(s).unwrap_or(Value::Null),
        Value::Null => v["parameters"].clone(),
        other => other.clone(),
    };
    Some((Call { id: format!("inline-{}", COUNTER.fetch_add(1, Ordering::Relaxed)), name, args }, text[..start].trim().to_string()))
}

async fn step_claude(req: &AgentRequest, system: &str, messages: &[Value]) -> Result<(Step, Value), String> {
    let key = req.api_key.clone().unwrap_or_default();
    let headers = vec![("x-api-key", key), ("anthropic-version", "2023-06-01".to_string())];
    let body = json!({ "model": req.model, "max_tokens": 8000, "system": system, "messages": messages, "tools": tool_defs_claude() });
    let v = post("https://api.anthropic.com/v1/messages", &headers, &body, &req.label, req.timeout_secs.unwrap_or(180)).await?;
    let content = v["content"].clone();
    let mut text = String::new();
    let mut calls = Vec::new();
    for block in content.as_array().cloned().unwrap_or_default() {
        match block["type"].as_str() {
            Some("text") => text.push_str(block["text"].as_str().unwrap_or("")),
            Some("tool_use") => calls.push(Call {
                id: block["id"].as_str().unwrap_or("").to_string(),
                name: block["name"].as_str().unwrap_or("").to_string(),
                args: block["input"].clone(),
            }),
            _ => {}
        }
    }
    Ok((Step { text, calls }, content))
}

/// Modo texto: extrai o primeiro <run>…</run> (ou um bloco ```bash no fim da resposta,
/// que é como muitos modelos locais "pedem" para rodar algo)
fn parse_run(text: &str) -> Option<(String, String)> {
    let Some(start) = text.find("<run>") else {
        let t = text.trim_end();
        if !t.ends_with("```") {
            return None;
        }
        let open = t[..t.len() - 3].rfind("```")?;
        let block = &t[open + 3..t.len() - 3];
        let (lang, body) = block.split_once('\n')?;
        if !matches!(lang.trim(), "bash" | "sh" | "shell" | "run") {
            return None;
        }
        let command = body.trim().to_string();
        return (!command.is_empty() && command.lines().count() <= 6).then(|| (command, t[..open].trim().to_string()));
    };
    let end = text[start..].find("</run>").map(|e| start + e)?;
    let command = text[start + 5..end].trim().trim_start_matches("```bash").trim_start_matches("```").trim_end_matches("```").trim().to_string();
    let before = text[..start].trim().to_string();
    (!command.is_empty()).then_some((command, before))
}

/// Modelos pequenos às vezes repetem a mesma chamada; a repetição devolve o resultado
/// anterior sem rodar nem perguntar de novo
async fn execute_once(call: &Call, auto: bool, events: &Channel<AgentEvent>, done: &mut HashMap<String, String>) -> String {
    let sig = format!("{}:{}", call.name, call.args);
    if let Some(prev) = done.get(&sig) {
        return format!("Isto já foi feito nesta tarefa (não repita). Resultado anterior:\n{}", prev);
    }
    let out = execute(call, auto, events).await;
    done.insert(sig, out.clone());
    out
}

/// Executa uma chamada de ferramenta (com aprovação) e devolve o resultado para o modelo
async fn execute(call: &Call, auto: bool, events: &Channel<AgentEvent>) -> String {
    if CANCELLED.load(Ordering::Relaxed) {
        return "Cancelado pelo usuário.".into();
    }
    match call.name.as_str() {
        "run_command" => {
            let command = call.args["command"].as_str().unwrap_or("").trim().to_string();
            if command.is_empty() {
                return "Erro: comando vazio.".into();
            }
            let id = next_id();
            let needs = !auto || dangerous(&command);
            events
                .send(AgentEvent::Command {
                    id: id.clone(),
                    command: command.clone(),
                    reason: call.args["reason"].as_str().unwrap_or("").to_string(),
                    needs_approval: needs,
                })
                .ok();
            if needs && !ask(&id).await {
                events.send(AgentEvent::CommandDone { id, code: None, approved: false }).ok();
                return "O usuário RECUSOU este comando. Não tente de novo; pergunte o que ele prefere ou siga outro caminho.".into();
            }
            let (code, output) = run_shell(&id, &command, events).await;
            events.send(AgentEvent::CommandDone { id, code, approved: true }).ok();
            let output = if output.trim().is_empty() { "(sem saída)".to_string() } else { shorten(&output, OUTPUT_TO_MODEL) };
            match code {
                Some(c) => format!("Código de saída: {}\n{}", c, output),
                None => format!("Comando interrompido.\n{}", output),
            }
        }
        "read_file" => {
            let path = call.args["path"].as_str().unwrap_or("").to_string();
            events.send(AgentEvent::Read { path: path.clone() }).ok();
            read_file_tool(&path)
        }
        "write_file" => {
            let path = expand_home(call.args["path"].as_str().unwrap_or(""));
            let content = call.args["content"].as_str().unwrap_or("").to_string();
            let id = next_id();
            let preview: String = content.chars().take(600).collect();
            let needs = !auto || std::path::Path::new(&path).exists();
            events.send(AgentEvent::Write { id: id.clone(), path: path.clone(), preview, needs_approval: needs }).ok();
            if needs && !ask(&id).await {
                events.send(AgentEvent::WriteDone { id, approved: false, error: None }).ok();
                return "O usuário RECUSOU gravar este arquivo.".into();
            }
            if let Some(dir) = std::path::Path::new(&path).parent() {
                std::fs::create_dir_all(dir).ok();
            }
            let result = std::fs::write(&path, content);
            let error = result.as_ref().err().map(|e| e.to_string());
            events.send(AgentEvent::WriteDone { id, approved: true, error: error.clone() }).ok();
            match error {
                None => format!("Arquivo gravado: {}", path),
                Some(e) => format!("Erro ao gravar {}: {}", path, e),
            }
        }
        other => format!("Ferramenta desconhecida: {}", other),
    }
}

fn tools_unsupported(err: &str) -> bool {
    let e = err.to_lowercase();
    e.contains("http 4") && (e.contains("tool") || e.contains("function"))
}

/// Executa a conversa com ferramentas até a IA terminar (ou MAX_STEPS)
#[tauri::command]
pub async fn agent_run(req: AgentRequest, events: Channel<AgentEvent>) -> Result<(), String> {
    CANCELLED.store(false, Ordering::Relaxed);
    let mut format = req.format.clone();
    let mut started = false;
    let mut done: HashMap<String, String> = HashMap::new();

    'restart: loop {
        let system = system_prompt(&format, req.persona.as_deref());
        // Histórico no formato do provedor
        let mut oa: Vec<Value> = vec![json!({ "role": "system", "content": system })];
        let mut cl: Vec<Value> = Vec::new();
        for t in &req.history {
            let role = if t.role == "assistant" { "assistant" } else { "user" };
            oa.push(json!({ "role": role, "content": t.content }));
            cl.push(json!({ "role": role, "content": t.content }));
        }

        for _ in 0..MAX_STEPS {
            if CANCELLED.load(Ordering::Relaxed) {
                return Ok(());
            }
            match format.as_str() {
                "claude" => {
                    let (step, content) = step_claude(&req, &system, &cl).await?;
                    started = true;
                    if !step.text.trim().is_empty() {
                        events.send(AgentEvent::Text { text: step.text.clone() }).ok();
                    }
                    if step.calls.is_empty() {
                        return Ok(());
                    }
                    cl.push(json!({ "role": "assistant", "content": content }));
                    let mut results = Vec::new();
                    for call in &step.calls {
                        let out = execute_once(call, req.auto_approve, &events, &mut done).await;
                        results.push(json!({ "type": "tool_result", "tool_use_id": call.id, "content": out }));
                    }
                    cl.push(json!({ "role": "user", "content": results }));
                }
                "text" => {
                    let mut headers = vec![];
                    if let Some(k) = req.api_key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
                        headers.push(("Authorization", format!("Bearer {}", k)));
                    }
                    let body = json!({ "model": req.model, "messages": oa });
                    let v = post(&format!("{}/chat/completions", base_url(&req)), &headers, &body, &req.label, req.timeout_secs.unwrap_or(180)).await?;
                    started = true;
                    let text = v["choices"][0]["message"]["content"].as_str().unwrap_or("").to_string();
                    oa.push(json!({ "role": "assistant", "content": text }));
                    match parse_run(&text) {
                        Some((command, before)) => {
                            if !before.is_empty() {
                                events.send(AgentEvent::Text { text: before.clone() }).ok();
                            }
                            let call = Call { id: String::new(), name: "run_command".into(), args: json!({ "command": command, "reason": before }) };
                            let out = execute_once(&call, req.auto_approve, &events, &mut done).await;
                            oa.push(json!({ "role": "user", "content": format!("Resultado do comando:\n{}", out) }));
                        }
                        None => {
                            events.send(AgentEvent::Text { text }).ok();
                            return Ok(());
                        }
                    }
                }
                _ => {
                    let step = match step_openai(&req, &oa).await {
                        Ok(s) => s,
                        Err(e) if !started && tools_unsupported(&e) => {
                            events.send(AgentEvent::Notice { text: format!("{} não aceita ferramentas; usando o modo texto.", req.label) }).ok();
                            format = "text".into();
                            continue 'restart;
                        }
                        Err(e) => return Err(e),
                    };
                    started = true;
                    if !step.text.trim().is_empty() {
                        events.send(AgentEvent::Text { text: step.text.clone() }).ok();
                    }
                    if step.calls.is_empty() {
                        return Ok(());
                    }
                    oa.push(json!({
                        "role": "assistant",
                        "content": if step.text.is_empty() { Value::Null } else { Value::String(step.text.clone()) },
                        "tool_calls": step.calls.iter().map(|c| json!({
                            "id": c.id, "type": "function",
                            "function": { "name": c.name, "arguments": c.args.to_string() }
                        })).collect::<Vec<_>>(),
                    }));
                    for call in &step.calls {
                        let out = execute_once(call, req.auto_approve, &events, &mut done).await;
                        oa.push(json!({ "role": "tool", "tool_call_id": call.id, "content": out }));
                    }
                }
            }
        }
        events.send(AgentEvent::Text { text: "Parei aqui: foram muitos passos seguidos. Quer que eu continue?".into() }).ok();
        return Ok(());
    }
}

// ---- arquivos soltos na janela -------------------------------------------------------------

#[derive(Serialize)]
pub struct DroppedFile {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub kind: String,
    pub is_dir: bool,
}

/// Informações de um arquivo arrastado para o Lumo (para a tela "o que faço com isso?")
#[tauri::command]
pub fn inspect_paths(paths: Vec<String>) -> Vec<DroppedFile> {
    paths
        .into_iter()
        .map(|p| {
            let meta = std::fs::metadata(&p).ok();
            let kind = std::process::Command::new("file")
                .args(["-b", "--mime-type", &p])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .unwrap_or_default();
            DroppedFile {
                name: std::path::Path::new(&p).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.clone()),
                size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                is_dir: meta.as_ref().is_some_and(|m| m.is_dir()),
                kind,
                path: p,
            }
        })
        .collect()
}
