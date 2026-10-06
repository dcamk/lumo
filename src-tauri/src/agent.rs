// Execução de ferramentas do agente: terminal, arquivos e aprovações do usuário.
// O "cérebro" (provedores, orquestração, memória, skills, plugins) fica em src/brain/.
//
// Segurança:
//   • cada comando/escrita aparece no chat e só roda depois de o usuário aprovar
//     (no modo automático, comandos perigosos continuam pedindo aprovação);
//   • `sudo` pede a senha numa janela gráfica (zenity via SUDO_ASKPASS) — o Lumo nunca
//     vê nem guarda a senha;
//   • "Parar" cancela o passo atual e mata o comando em execução.

use serde::Serialize;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::ipc::Channel;
use tokio::io::{AsyncReadExt, BufReader};
use tokio::sync::oneshot;

const COMMAND_TIMEOUT: Duration = Duration::from_secs(20 * 60);
pub(crate) const OUTPUT_TO_MODEL: usize = 8000;
const READ_LIMIT: usize = 100_000;
#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    /// Texto da IA (um passo inteiro)
    Text { text: String },
    /// Pedaço de texto da resposta em andamento (o `Text` do fim do passo o substitui)
    TextDelta { text: String },
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
pub(crate) static CANCELLED: AtomicBool = AtomicBool::new(false);
static RUNNING_PID: AtomicU32 = AtomicU32::new(0);
pub(crate) static COUNTER: AtomicU32 = AtomicU32::new(0);

pub(crate) fn next_id() -> String {
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

pub(crate) async fn ask(id: &str) -> bool {
    let (tx, rx) = oneshot::channel();
    if let Ok(mut p) = PENDING.lock() {
        p.get_or_insert_with(HashMap::new).insert(id.to_string(), tx);
    }
    rx.await.unwrap_or(false)
}

/// Comandos que sempre pedem aprovação, mesmo no modo automático
pub(crate) fn dangerous(cmd: &str) -> bool {
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

pub(crate) fn shorten(text: &str, limit: usize) -> String {
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

pub(crate) async fn run_shell(id: &str, command: &str, events: &Channel<AgentEvent>) -> (Option<i32>, String) {
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

pub(crate) fn expand_home(path: &str) -> String {
    match path.strip_prefix("~/") {
        Some(rest) => format!("{}/{}", std::env::var("HOME").unwrap_or_default(), rest),
        None => path.to_string(),
    }
}

pub(crate) fn read_file_tool(path: &str) -> String {
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
