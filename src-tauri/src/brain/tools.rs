// Ferramentas do agente: terminal, arquivos, memória, skills, Gmail e plugins MCP.
// Tudo que altera algo (comando, gravação, instalar skill, plugin) passa pela aprovação
// do usuário, a menos que o modo automático esteja ligado (comandos perigosos e com
// sudo sempre perguntam).
use super::llm::{Call, ToolDef};
use super::{mcp, memory, skills};
use crate::agent::{self, AgentEvent};
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use tauri::ipc::Channel;

pub struct Ctx {
    pub events: Channel<AgentEvent>,
    pub auto: bool,
    /// O que aconteceu na tarefa (falas e comandos), para a memória da conversa
    pub transcript: Mutex<Vec<String>>,
}

impl Ctx {
    pub fn record(&self, line: String) {
        self.transcript.lock().unwrap_or_else(|e| e.into_inner()).push(line);
    }
}

fn def(name: &str, description: &str, schema: Value) -> ToolDef {
    ToolDef { name: name.into(), description: description.into(), schema }
}

fn obj(props: Value, required: &[&str]) -> Value {
    json!({ "type": "object", "properties": props, "required": required })
}

pub async fn defs(can_delegate: bool) -> Vec<ToolDef> {
    let s = json!({ "type": "string" });
    let mut v = vec![
        def("run_command", "Executa um comando no bash do usuário (Linux) e devolve a saída. O usuário aprova antes.",
            obj(json!({ "command": { "type": "string", "description": "Comando bash, não interativo" }, "reason": { "type": "string", "description": "O que o comando faz, em uma frase curta em português" } }), &["command", "reason"])),
        def("read_file", "Lê um arquivo de texto (até 100 KB).", obj(json!({ "path": s }), &["path"])),
        def("write_file", "Cria ou substitui um arquivo de texto. O usuário aprova antes.", obj(json!({ "path": s, "content": s }), &["path", "content"])),
        def("remember", "Guarda na memória permanente um fato duradouro sobre o usuário (preferência, nome, projeto, hábito). Nunca guarde senhas ou tokens.", obj(json!({ "fact": s }), &["fact"])),
        def("recall", "Busca na memória permanente por palavras-chave.", obj(json!({ "query": s }), &["query"])),
        def("forget", "Apaga um fato da memória pelo id.", obj(json!({ "id": { "type": "integer" } }), &["id"])),
        def("use_skill", "Carrega as instruções completas de uma skill instalada.", obj(json!({ "name": s }), &["name"])),
        def("install_skill", "Instala uma skill (pasta com SKILL.md): caminho local, URL de um SKILL.md ou repositório do GitHub (dono/repo ou dono/repo/subpasta). O usuário aprova antes.", obj(json!({ "source": s }), &["source"])),
    ];
    if can_delegate {
        v.push(def(
            "delegate",
            "Entrega uma tarefa a um agente especialista (roda em outro provedor/modelo) e devolve o relatório dele. A tarefa precisa ser autossuficiente: o agente não vê a conversa.",
            obj(json!({
                "agent": { "type": "string", "enum": ["coder", "long", "fast", "local"], "description": "coder = código e análise técnica · long = documentos/contexto muito grandes · fast = respostas rápidas, resumos, traduções · local = dados privados (só roda no PC)" },
                "task": s,
                "context": { "type": "string", "description": "Trechos da conversa/arquivos que o agente precisa (opcional)" }
            }), &["agent", "task"]),
        ));
    }
    if crate::google::connected() {
        v.push(def("gmail_search", "Busca e-mails na conta Google conectada (somente leitura). Sintaxe do Gmail, ex.: 'is:unread', 'from:ana', 'newer_than:2d'.",
            obj(json!({ "query": s, "max": { "type": "integer", "description": "até 15" } }), &["query"])));
    }
    for t in mcp::tools().await {
        v.push(ToolDef { name: mcp::exposed_name(&t), description: format!("[plugin {}] {}", t.plugin, t.description), schema: t.schema });
    }
    v
}

/// Mostra o pedido no chat e espera o aval. `None` = recusado.
/// `force` = pergunta mesmo no modo automático.
async fn approve(ctx: &Ctx, label: String, reason: String, force: bool) -> Option<String> {
    ask_user(ctx, label, reason, force || !ctx.auto).await
}

async fn ask_user(ctx: &Ctx, label: String, reason: String, needs: bool) -> Option<String> {
    let id = agent::next_id();
    ctx.events.send(AgentEvent::Command { id: id.clone(), command: label, reason, needs_approval: needs }).ok();
    if needs && !agent::ask(&id).await {
        ctx.events.send(AgentEvent::CommandDone { id, code: None, approved: false }).ok();
        return None;
    }
    Some(id)
}

const REFUSED: &str = "O usuário RECUSOU. Não tente de novo; pergunte o que ele prefere ou siga outro caminho.";

pub async fn execute(ctx: &Ctx, call: &Call) -> String {
    if agent::CANCELLED.load(Ordering::Relaxed) {
        return "Cancelado pelo usuário.".into();
    }
    let arg = |k: &str| call.args[k].as_str().unwrap_or("").trim().to_string();
    match call.name.as_str() {
        "run_command" => {
            let command = arg("command");
            if command.is_empty() {
                return "Erro: comando vazio.".into();
            }
            let Some(id) = approve(ctx, command.clone(), arg("reason"), agent::dangerous(&command)).await else { return REFUSED.into() };
            let (code, output) = agent::run_shell(&id, &command, &ctx.events).await;
            ctx.events.send(AgentEvent::CommandDone { id, code, approved: true }).ok();
            let tail: Vec<&str> = output.lines().rev().take(8).collect::<Vec<_>>().into_iter().rev().collect();
            ctx.record(format!("[executei] $ {} → {}{}", command, code.map_or("interrompido".into(), |c| if c == 0 { "ok".into() } else { format!("código {}", c) }), if tail.is_empty() { String::new() } else { format!("\n{}", tail.join("\n")) }));
            let output = if output.trim().is_empty() { "(sem saída)".to_string() } else { agent::shorten(&output, agent::OUTPUT_TO_MODEL) };
            match code {
                Some(c) => format!("Código de saída: {}\n{}", c, output),
                None => format!("Comando interrompido.\n{}", output),
            }
        }
        "read_file" => {
            let path = arg("path");
            ctx.events.send(AgentEvent::Read { path: path.clone() }).ok();
            agent::read_file_tool(&path)
        }
        "write_file" => {
            let path = agent::expand_home(&arg("path"));
            let content = call.args["content"].as_str().unwrap_or("").to_string();
            let id = agent::next_id();
            let needs = !ctx.auto || std::path::Path::new(&path).exists();
            ctx.events.send(AgentEvent::Write { id: id.clone(), path: path.clone(), preview: content.chars().take(600).collect(), needs_approval: needs }).ok();
            if needs && !agent::ask(&id).await {
                ctx.events.send(AgentEvent::WriteDone { id, approved: false, error: None }).ok();
                return "O usuário RECUSOU gravar este arquivo.".into();
            }
            if let Some(dir) = std::path::Path::new(&path).parent() {
                std::fs::create_dir_all(dir).ok();
            }
            let error = std::fs::write(&path, content).err().map(|e| e.to_string());
            ctx.events.send(AgentEvent::WriteDone { id, approved: true, error: error.clone() }).ok();
            ctx.record(format!("[gravei] {}", path));
            match error {
                None => format!("Arquivo gravado: {}", path),
                Some(e) => format!("Erro ao gravar {}: {}", path, e),
            }
        }
        "remember" => {
            let r = memory::add_fact(&arg("fact"));
            ctx.events.send(AgentEvent::Notice { text: format!("Guardei na memória: {}", arg("fact")) }).ok();
            r
        }
        "recall" => memory::recall(&arg("query")),
        "forget" => memory::forget(call.args["id"].as_u64().unwrap_or(0) as u32),
        "use_skill" => skills::read(&arg("name")),
        "install_skill" => {
            let src = arg("source");
            let Some(id) = approve(ctx, format!("instalar skill: {}", src), "Instalar uma skill (instruções para o Lumo)".into(), true).await else { return REFUSED.into() };
            let r = skills::install(&src).await;
            ctx.events.send(AgentEvent::CommandDone { id, code: Some(if r.is_ok() { 0 } else { 1 }), approved: true }).ok();
            match r {
                Ok(n) => format!("Skills instaladas: {}. Use use_skill para carregá-las.", n.join(", ")),
                Err(e) => format!("Falha ao instalar: {}", e),
            }
        }
        "gmail_search" => {
            let max = call.args["max"].as_u64().unwrap_or(10).clamp(1, 15) as usize;
            match crate::google::gmail_query(&super::app(), &arg("query"), max).await {
                Ok(inbox) if inbox.messages.is_empty() => "Nenhum e-mail encontrado.".into(),
                Ok(inbox) => inbox
                    .messages
                    .iter()
                    .map(|m| format!("- {} | {} | {}", m.from, m.subject, m.snippet))
                    .collect::<Vec<_>>()
                    .join("\n"),
                Err(e) => format!("Erro no Gmail: {}", e),
            }
        }
        name => {
            // ferramenta de plugin
            let (plugin_hint, tool_hint) = name.split_once("__").unwrap_or(("", name));
            let trusted = mcp::is_trusted(plugin_hint);
            let label = format!("{}:{} {}", plugin_hint, tool_hint, call.args);
            // Plugin confiável roda direto; os outros sempre perguntam (mesmo no modo automático)
            let Some(id) = ask_user(ctx, label.chars().take(400).collect(), format!("Usar o plugin {}", plugin_hint), !trusted).await else { return REFUSED.into() };
            let r = mcp::call(name, call.args.clone()).await;
            ctx.events.send(AgentEvent::CommandDone { id, code: Some(if r.is_ok() { 0 } else { 1 }), approved: true }).ok();
            match r {
                Ok((_, _, out)) => agent::shorten(&out, agent::OUTPUT_TO_MODEL),
                Err(e) => format!("Erro do plugin: {}", e),
            }
        }
    }
}
