// Terminal da aba "Terminal": um bash de verdade num pseudoterminal (PTY).
//
// A interface (xterm.js) manda o que você digita e recebe a saída em base64. O bash
// sobe com um rc do Lumo que, a cada comando concluído, emite uma sequência invisível
// OSC 777 com o código de saída, o número no histórico e o comando — é assim que a IA
// "lê" o que está sendo executado e sugere uma correção quando algo falha.
//
// A sessão sobrevive à troca de abas: ao voltar, a interface recebe o histórico da tela.
use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;

/// Quanto da saída guardar para redesenhar a tela ao voltar para a aba
const SCROLLBACK: usize = 400_000;

const RC: &str = r#"# rc do terminal do Lumo: carrega o seu ~/.bashrc e avisa o Lumo de cada comando
[ -f ~/.bashrc ] && . ~/.bashrc
__lumo_last=""
__lumo_hook() {
  local code=$? entry num cmd
  entry=$(HISTTIMEFORMAT= builtin history 1)
  num=$(printf '%s' "$entry" | awk '{print $1}')
  # 1ª chamada: só anota (o histórico antigo é carregado depois do rc)
  if [ -z "$__lumo_ready" ]; then __lumo_ready=1; __lumo_last="$num"; return $code; fi
  [ "$num" = "$__lumo_last" ] && return $code
  __lumo_last="$num"
  cmd=$(printf '%s' "$entry" | sed 's/^ *[0-9]* *//')
  printf '\033]777;lumo;%s;%s;%s\007' "$code" "$num" "$(printf '%s' "$cmd" | base64 -w0)"
  return $code
}
PROMPT_COMMAND="__lumo_hook${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
"#;

struct Session {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    scrollback: Arc<Mutex<Vec<u8>>>,
    channel: Arc<Mutex<Option<Channel<String>>>>,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 }
}

/// Abre o terminal (ou volta a ele). Devolve a tela até aqui (base64) para redesenhar.
/// Mensagens no canal: saída em base64; "" = o shell terminou.
#[tauri::command]
pub fn term_open(cols: u16, rows: u16, on_data: Channel<String>) -> Result<String, String> {
    let mut guard = SESSION.lock().map_err(|e| e.to_string())?;
    if let Some(s) = guard.as_mut() {
        if s.child.try_wait().ok().flatten().is_none() {
            *s.channel.lock().map_err(|e| e.to_string())? = Some(on_data);
            s.master.resize(size(cols, rows)).ok();
            let snap = s.scrollback.lock().map_err(|e| e.to_string())?.clone();
            return Ok(STANDARD.encode(snap));
        }
        *guard = None; // o shell anterior terminou: abre outro
    }

    let pty = native_pty_system().openpty(size(cols, rows)).map_err(|e| e.to_string())?;
    let rc = std::env::temp_dir().join("lumo-terminal.bashrc");
    std::fs::write(&rc, RC).map_err(|e| e.to_string())?;
    let mut cmd = CommandBuilder::new("bash");
    cmd.args(["--rcfile", &rc.to_string_lossy(), "-i"]);
    cmd.cwd(std::env::var("HOME").unwrap_or_else(|_| "/".into()));
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("LUMO_TERMINAL", "1");
    let child = pty.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pty.slave);

    let mut reader = pty.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pty.master.take_writer().map_err(|e| e.to_string())?;
    let scrollback = Arc::new(Mutex::new(Vec::new()));
    let channel = Arc::new(Mutex::new(Some(on_data)));

    let (sb, ch) = (scrollback.clone(), channel.clone());
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if let Ok(mut s) = sb.lock() {
                        s.extend_from_slice(&buf[..n]);
                        if s.len() > SCROLLBACK {
                            let cut = s.len() - SCROLLBACK;
                            s.drain(..cut);
                        }
                    }
                    if let Some(c) = ch.lock().ok().and_then(|g| g.clone()) {
                        c.send(STANDARD.encode(&buf[..n])).ok();
                    }
                }
            }
        }
        if let Some(c) = ch.lock().ok().and_then(|g| g.clone()) {
            c.send(String::new()).ok();
        }
    });

    *guard = Some(Session { writer, master: pty.master, child, scrollback, channel });
    Ok(String::new())
}

/// O que você digitou (ou o comando sugerido pela IA)
#[tauri::command]
pub fn term_write(data: String) -> Result<(), String> {
    let mut guard = SESSION.lock().map_err(|e| e.to_string())?;
    let s = guard.as_mut().ok_or("terminal fechado")?;
    s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    s.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn term_resize(cols: u16, rows: u16) -> Result<(), String> {
    if let Some(s) = SESSION.lock().map_err(|e| e.to_string())?.as_ref() {
        s.master.resize(size(cols, rows)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Encerra o shell (o próximo term_open abre um novo)
#[tauri::command]
pub fn term_close() {
    if let Ok(mut g) = SESSION.lock() {
        if let Some(mut s) = g.take() {
            s.child.kill().ok();
        }
    }
}

/// Fecha o shell ao sair do Lumo
pub fn cleanup() {
    term_close();
}
