// "Cérebro" do Lumo: provedores testados em segundo plano (pool), orquestração entre
// modelo principal e agentes especialistas, memória em disco, skills e plugins MCP.
pub mod llm;
pub mod mcp;
pub mod memory;
pub mod orchestrator;
pub mod pool;
pub mod skills;
pub mod tools;

use serde::Deserialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn app() -> AppHandle {
    APP.get().expect("brain::init não foi chamado").clone()
}

pub fn try_app() -> Option<AppHandle> {
    APP.get().cloned()
}

pub fn dir() -> Option<PathBuf> {
    APP.get()?.path().app_config_dir().ok()
}

/// Chamado uma vez no setup: sobe o pool com os padrões (funciona sem configurar nada:
/// LLM7 sem chave + modelos locais do Ollama), o monitor de saúde e os plugins ativos.
pub fn init(handle: &AppHandle) {
    APP.set(handle.clone()).ok();
    tauri::async_runtime::spawn(pool::configure(HashMap::new(), "llm7".into()));
    pool::spawn_monitor();
    mcp::spawn_autostart();
}

#[derive(Deserialize)]
pub struct ProviderCfg {
    pub id: String,
    #[serde(flatten)]
    pub cfg: pool::Cfg,
}

/// A interface envia as chaves/modelos sempre que mudam
#[tauri::command]
pub async fn brain_configure(providers: Vec<ProviderCfg>, preferred: String) {
    pool::configure(providers.into_iter().map(|p| (p.id, p.cfg)).collect(), preferred).await;
}

/// O painel foi aberto: aquece o modelo local
#[tauri::command]
pub async fn brain_warm() {
    pool::warm().await;
}

#[tauri::command]
pub fn pool_status() -> Vec<pool::Info> {
    pool::status()
}

#[tauri::command]
pub async fn pool_test() -> Vec<pool::Info> {
    pool::probe_all().await;
    pool::status()
}

#[tauri::command]
pub fn memory_list() -> Vec<memory::Fact> {
    memory::facts()
}

#[tauri::command]
pub fn memory_add(text: String) -> String {
    memory::add_fact(&text)
}

#[tauri::command]
pub fn memory_forget(id: u32) -> String {
    memory::forget(id)
}

/// Nova conversa (os fatos permanecem)
#[tauri::command]
pub fn brain_reset() {
    memory::reset_conversation();
}

#[tauri::command]
pub fn skill_list() -> Vec<skills::Skill> {
    skills::list()
}

#[tauri::command]
pub async fn skill_install(source: String) -> Result<Vec<String>, String> {
    skills::install(&source).await
}

#[tauri::command]
pub fn skill_remove(name: String) -> Result<(), String> {
    skills::remove(&name)
}

#[tauri::command]
pub async fn plugin_list() -> Vec<mcp::PluginStatus> {
    mcp::status().await
}

#[tauri::command]
pub async fn plugin_add(name: String, command: String, args: Vec<String>, env: HashMap<String, String>) -> Result<(), String> {
    mcp::add(mcp::PluginCfg { name, command, args, env, enabled: true, trusted: false }).await
}

#[tauri::command]
pub async fn plugin_remove(name: String) -> Result<(), String> {
    mcp::remove(&name).await
}

#[tauri::command]
pub async fn plugin_set(name: String, enabled: Option<bool>, trusted: Option<bool>) -> Result<(), String> {
    if let Some(e) = enabled {
        mcp::set_enabled(&name, e).await?;
    }
    if let Some(t) = trusted {
        mcp::set_trusted(&name, t).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::llm::*;
    use super::pool::{self, Role};
    use serde_json::json;

    fn hora() -> ToolDef {
        ToolDef { name: "hora".into(), description: "hora em uma cidade".into(), schema: json!({"type":"object","properties":{"cidade":{"type":"string"}},"required":["cidade"]}) }
    }

    #[test]
    fn texto_vira_chamada() {
        let (rest, calls) = parse_text_calls_pub("vou ver\n<tool_call>{\"name\":\"hora\",\"arguments\":{\"cidade\":\"Tokyo\"}}</tool_call>", &[hora()]);
        assert_eq!(rest, "vou ver");
        assert_eq!(calls[0].args["cidade"], "Tokyo");
    }

    #[tokio::test]
    async fn pool_testa_llm7_e_responde_com_ferramentas() {
        pool::configure(Default::default(), "llm7".into()).await;
        let st = pool::status();
        println!("{}", serde_json::to_string_pretty(&st).unwrap());
        for s in &st { println!("slot {} ok={:?} cooldown={} err={}", s.key, s.ok, s.cooldown_secs, s.error); }
        let pick = pool::ranked(Role::Main, true).remove(0);
        println!("usando {}", pick.key);
        for native in [true, false] {
            let mut t = pick.target.clone();
            t.native_tools = native;
            let r = step(&t, "Use a ferramenta hora para responder.", &[Msg::User("Que horas são em Tokyo?".into())], &[hora()], 40, None, None).await.unwrap();
            println!("native={} text={:?} calls={:?}", native, r.text, r.calls);
            assert!(!r.calls.is_empty(), "native={} sem chamada", native);
        }
    }
}

#[cfg(test)]
mod stream_tests {
    use super::llm::*;
    use serde_json::json;

    /// O Ollama também fala o formato OpenAI (SSE): serve de servidor de teste
    #[tokio::test]
    async fn sse_openai_com_ferramenta_e_texto() {
        let t = Target { kind: Kind::OpenAi, label: "Ollama/v1".into(), base: "http://localhost:11434/v1".into(), api_key: String::new(), model: "huihui_ai/qwen2.5-coder-abliterate:7b".into(), native_tools: true };
        let n = std::sync::atomic::AtomicUsize::new(0);
        let cb = |_: &str| {
            n.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        };
        let r = step(&t, "Responda em português.", &[Msg::User("Diga olá em uma frase.".into())], &[], 90, None, Some(&cb)).await.unwrap();
        println!("texto={:?} pedaços={}", r.text, n.load(std::sync::atomic::Ordering::Relaxed));
        assert!(n.load(std::sync::atomic::Ordering::Relaxed) > 1);
        let hora = ToolDef { name: "hora".into(), description: "hora em uma cidade".into(), schema: json!({"type":"object","properties":{"cidade":{"type":"string"}},"required":["cidade"]}) };
        let r = step(&t, "Use a ferramenta.", &[Msg::User("Que horas são em Tokyo?".into())], &[hora], 90, None, Some(&cb)).await.unwrap();
        println!("calls={:?}", r.calls);
        assert_eq!(r.calls[0].args["cidade"], "Tokyo");
    }
}
