// Pool de provedores: o Lumo testa cada provedor em segundo plano (antes de o usuário
// precisar), mede latência e limites, e mantém um ranking por tipo de tarefa.
//
// `capacity` é uma estimativa da folga da camada grátis (pedidos/tokens por dia): quanto
// maior, mais o provedor é preferido. Valores de referência (2026, aproximados):
// Groq ~14 mil req/dia · Cerebras ~1M tokens/dia · Gemini Flash centenas/dia ·
// Mistral ~1 mil req/dia · NVIDIA 40 req/min · OpenRouter 50 req/dia · LLM7 sem chave.
// Os cabeçalhos x-ratelimit-* de cada resposta refinam isso em tempo real.
use super::llm::{self, classify, Fail, Kind, Msg, Rate, Target, ToolDef};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct Preset {
    pub id: &'static str,
    pub label: &'static str,
    pub kind: Kind,
    pub base: &'static str,
    pub model: &'static str,
    pub keyless: bool,
    pub local: bool,
    pub capacity: i32,
    pub quality: i32,
    pub ctx_k: i32,
    /// Cobra por uso: só entra na fila se for o provedor escolhido pelo usuário
    pub paid: bool,
    /// Modelos para tentar se o padrão sair do ar (os provedores grátis trocam de modelo sem aviso)
    pub alternatives: &'static [&'static str],
}

pub const PRESETS: &[Preset] = &[
    Preset { id: "groq", label: "Groq", kind: Kind::OpenAi, base: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-120b", keyless: false, local: false, capacity: 90, quality: 80, ctx_k: 128, paid: false, alternatives: &["llama-3.3-70b-versatile", "qwen/qwen3-32b", "openai/gpt-oss-20b", "llama-3.1-8b-instant"] },
    Preset { id: "cerebras", label: "Cerebras", kind: Kind::OpenAi, base: "https://api.cerebras.ai/v1", model: "gpt-oss-120b", keyless: false, local: false, capacity: 90, quality: 75, ctx_k: 128, paid: false, alternatives: &["llama-3.3-70b", "qwen-3-32b", "llama3.1-8b"] },
    Preset { id: "gemini", label: "Gemini", kind: Kind::OpenAi, base: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-flash-latest", keyless: false, local: false, capacity: 60, quality: 85, ctx_k: 1000, paid: false, alternatives: &["gemini-2.5-flash", "gemini-flash-lite-latest", "gemini-2.5-flash-lite"] },
    Preset { id: "github", label: "GitHub Models", kind: Kind::OpenAi, base: "https://models.github.ai/inference", model: "openai/gpt-4.1-mini", keyless: false, local: false, capacity: 35, quality: 82, ctx_k: 128, paid: false, alternatives: &["openai/gpt-4o-mini", "openai/gpt-4.1-nano"] },
    Preset { id: "mistral", label: "Mistral", kind: Kind::OpenAi, base: "https://api.mistral.ai/v1", model: "mistral-small-latest", keyless: false, local: false, capacity: 65, quality: 65, ctx_k: 128, paid: false, alternatives: &["mistral-medium-latest", "open-mistral-nemo"] },
    Preset { id: "nvidia", label: "NVIDIA NIM", kind: Kind::OpenAi, base: "https://integrate.api.nvidia.com/v1", model: "meta/llama-3.3-70b-instruct", keyless: false, local: false, capacity: 55, quality: 70, ctx_k: 128, paid: false, alternatives: &["openai/gpt-oss-120b", "meta/llama-3.1-70b-instruct"] },
    Preset { id: "openrouter", label: "OpenRouter", kind: Kind::OpenAi, base: "https://openrouter.ai/api/v1", model: "openai/gpt-oss-120b:free", keyless: false, local: false, capacity: 15, quality: 75, ctx_k: 128, paid: false, alternatives: &["nvidia/nemotron-3-super-120b-a12b:free", "meta-llama/llama-3.3-70b-instruct:free", "qwen/qwen3-coder:free"] },
    Preset { id: "huggingface", label: "Hugging Face", kind: Kind::OpenAi, base: "https://router.huggingface.co/v1", model: "openai/gpt-oss-120b", keyless: false, local: false, capacity: 25, quality: 60, ctx_k: 128, paid: false, alternatives: &["meta-llama/Llama-3.3-70B-Instruct", "meta-llama/Llama-3.1-8B-Instruct"] },
    // Sem chave funciona, mas o modelo é fraco: fica como último recurso
    Preset { id: "llm7", label: "LLM7", kind: Kind::OpenAi, base: "https://api.llm7.io/v1", model: "default", keyless: true, local: false, capacity: 40, quality: 30, ctx_k: 32, paid: false, alternatives: &["fast"] },
    Preset { id: "openai", label: "OpenAI", kind: Kind::OpenAi, base: "https://api.openai.com/v1", model: "gpt-4o-mini", keyless: false, local: false, capacity: 95, quality: 78, ctx_k: 128, paid: true, alternatives: &[] },
    Preset { id: "claude", label: "Claude", kind: Kind::Claude, base: "", model: "claude-opus-5-5", keyless: false, local: false, capacity: 95, quality: 98, ctx_k: 200, paid: true, alternatives: &[] },
    Preset { id: "custom", label: "Personalizado", kind: Kind::OpenAi, base: "", model: "", keyless: false, local: false, capacity: 60, quality: 60, ctx_k: 64, paid: false, alternatives: &[] },
    Preset { id: "ollama", label: "Ollama", kind: Kind::Ollama, base: "http://localhost:11434", model: "llama3", keyless: true, local: true, capacity: 100, quality: 55, ctx_k: 32, paid: false, alternatives: &[] },
];

#[derive(Clone, Deserialize, Default)]
pub struct Cfg {
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub endpoint: String,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Role {
    Main,
    Coder,
    Long,
    Fast,
    Local,
}

impl Role {
    pub fn parse(s: &str) -> Option<Role> {
        match s {
            "coder" => Some(Role::Coder),
            "long" => Some(Role::Long),
            "fast" => Some(Role::Fast),
            "local" => Some(Role::Local),
            _ => None,
        }
    }
}

#[derive(Clone, Serialize)]
pub struct Info {
    pub key: String,
    pub provider: String,
    pub label: String,
    pub model: String,
    pub local: bool,
    /// None = ainda não testado
    pub ok: Option<bool>,
    pub tools: Option<bool>,
    pub latency_ms: Option<u64>,
    pub error: String,
    pub checked_at: u64,
    pub cooldown_secs: u64,
    pub capacity: i32,
    pub quality: i32,
    pub ctx_k: i32,
    /// Resumo dos limites informados pelo provedor ("restam 29 req")
    pub rate: String,
    pub score: i32,
}

#[derive(Clone)]
struct Slot {
    info: Info,
    target: Target,
    cooldown_until: u64,
    probe_at: u64,
}

#[derive(Default)]
struct State {
    cfgs: HashMap<String, Cfg>,
    preferred: String,
    slots: Vec<Slot>,
}

static POOL: Mutex<Option<State>> = Mutex::new(None);
/// Cada `configure` ganha um número; uma chamada antiga que termine depois da nova
/// (ex.: a do início do app e a da interface) não sobrescreve a configuração atual
/// Modelos que substituíram o padrão de um provedor (o padrão saiu do ar)
static REPLACED: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);
static GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn preset(id: &str) -> Option<&'static Preset> {
    PRESETS.iter().find(|p| p.id == id)
}

/// Provedor que cobra por uso (só usado quando é o escolhido)
fn is_paid(provider: &str) -> bool {
    preset(provider).is_some_and(|p| p.paid)
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn with<T>(f: impl FnOnce(&mut State) -> T) -> T {
    let mut g = POOL.lock().unwrap_or_else(|e| e.into_inner());
    f(g.get_or_insert_with(State::default))
}

fn is_code_model(model: &str) -> bool {
    let m = model.to_lowercase();
    m.contains("coder") || m.contains("codestral") || m.contains("devstral") || m.contains("code")
}

fn ready(p: &Preset, cfg: &Cfg) -> bool {
    if p.id == "custom" && cfg.endpoint.trim().is_empty() {
        return false;
    }
    p.keyless || !cfg.api_key.trim().is_empty()
}

fn base_of(p: &Preset, cfg: &Cfg) -> String {
    let b = if cfg.endpoint.trim().is_empty() { p.base } else { cfg.endpoint.trim() };
    let b = b.trim_end_matches('/').trim_end_matches("/chat/completions").to_string();
    if p.local {
        b.trim_end_matches("/v1").to_string()
    } else {
        b
    }
}

fn slot_for(p: &Preset, cfg: &Cfg, model: &str, tools: Option<bool>) -> Slot {
    let local = p.local;
    Slot {
        info: Info {
            key: format!("{}:{}", p.id, model),
            provider: p.id.into(),
            label: if local { format!("{} ({})", p.label, model) } else { p.label.into() },
            model: model.into(),
            local,
            ok: None,
            tools,
            latency_ms: None,
            error: String::new(),
            checked_at: 0,
            cooldown_secs: 0,
            capacity: p.capacity,
            quality: p.quality,
            ctx_k: p.ctx_k,
            rate: String::new(),
            score: 0,
        },
        target: Target {
            kind: p.kind,
            label: p.label.into(),
            base: base_of(p, cfg),
            api_key: cfg.api_key.trim().into(),
            model: model.into(),
            native_tools: tools != Some(false),
        },
        cooldown_until: 0,
        probe_at: 0,
    }
}

/// Recebe a configuração da interface, redescobre os modelos locais e testa tudo
pub async fn configure(cfgs: HashMap<String, Cfg>, preferred: String) {
    let generation = GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    let ollama_cfg = cfgs.get("ollama").cloned().unwrap_or_default();
    let ollama_ep = if ollama_cfg.endpoint.trim().is_empty() { "http://localhost:11434".to_string() } else { ollama_cfg.endpoint.clone() };
    let locals = crate::api::ollama_models(Some(ollama_ep)).await;
    if GENERATION.load(std::sync::atomic::Ordering::SeqCst) != generation {
        return; // chegou uma configuração mais nova enquanto o Ollama respondia
    }

    with(|st| {
        let old = std::mem::take(&mut st.slots);
        st.cfgs = cfgs;
        st.preferred = preferred;
        let mut slots = Vec::new();
        for p in PRESETS {
            let cfg = st.cfgs.get(p.id).cloned().unwrap_or_default();
            if p.local {
                // Ollama: o modelo configurado + os menores com ferramentas (respondem mais rápido)
                let chat: Vec<_> = locals.iter().filter(|m| !m.embedding).collect();
                let mut picked: Vec<_> = chat.iter().filter(|m| m.name == cfg.model).collect();
                let mut others: Vec<_> = chat.iter().filter(|m| m.tools && m.name != cfg.model).collect();
                others.sort_by_key(|m| m.size);
                picked.extend(others.into_iter().take(2));
                for m in picked {
                    let mut s = slot_for(p, &cfg, &m.name, Some(m.tools));
                    s.info.ok = Some(true); // o Ollama respondeu à listagem; não carrega o modelo à toa
                    s.info.checked_at = now();
                    // Modelos pequenos (até ~7B) se perdem com as ferramentas e respondem mal;
                    // os "abliterated"/"uncensored" obedecem a qualquer coisa ao pé da letra
                    let gb = m.size as f64 / 1e9;
                    s.info.quality = if gb < 3.0 { 25 } else if gb < 6.0 { 35 } else if gb < 12.0 { 50 } else { 60 };
                    let low = m.name.to_lowercase();
                    if low.contains("abliterat") || low.contains("uncensored") {
                        s.info.quality -= 15;
                    }
                    if is_code_model(&m.name) {
                        s.info.quality += 5;
                    }
                    slots.push(s);
                }
                continue;
            }
            if !ready(p, &cfg) {
                continue;
            }
            let replaced = REPLACED.lock().ok().and_then(|g| g.as_ref().and_then(|m| m.get(p.id).cloned()));
            let model = if !cfg.model.trim().is_empty() { cfg.model.trim().to_string() } else { replaced.unwrap_or_else(|| p.model.to_string()) };
            let model = model.as_str();
            if model.is_empty() {
                continue;
            }
            slots.push(slot_for(p, &cfg, model, None));
        }
        // Mantém o que já foi medido de quem não mudou
        for s in slots.iter_mut() {
            if let Some(o) = old.iter().find(|o| o.info.key == s.info.key && o.target.api_key == s.target.api_key && o.target.base == s.target.base) {
                if !s.info.local {
                    s.info = Info { label: s.info.label.clone(), ..o.info.clone() };
                    s.target.native_tools = o.target.native_tools;
                    s.cooldown_until = o.cooldown_until;
                    s.probe_at = o.probe_at;
                }
            }
        }
        st.slots = slots;
    });
    probe_due().await;
}

fn probe_interval(s: &Slot) -> u64 {
    if is_paid(&s.info.provider) {
        24 * 3600 // pago: só testa ao configurar ou no botão "Testar agora"
    } else if s.info.ok == Some(false) {
        300
    } else if s.info.capacity < 30 {
        3 * 3600 // camadas com poucos pedidos por dia: não gasta a cota testando
    } else {
        20 * 60
    }
}

fn probe_tool() -> ToolDef {
    ToolDef { name: "ping".into(), description: "Teste".into(), schema: json!({ "type": "object", "properties": {} }) }
}

async fn probe(key: String) {
    let Some(mut target) = with(|st| st.slots.iter().find(|s| s.info.key == key && !s.info.local).map(|s| s.target.clone())) else { return };
    let started = std::time::Instant::now();
    let msgs = [Msg::User("Responda apenas: ok".into())];
    let mut res = llm::step(&target, "Teste de conexão.", &msgs, &[probe_tool()], 25, Some(16), None).await;
    let mut tools = Some(true);
    if let Err(e) = &res {
        if classify(e) == Fail::Unsupported {
            target.native_tools = false;
            tools = Some(false);
            res = llm::step(&target, "Teste de conexão.", &msgs, &[], 25, Some(16), None).await;
        }
    }
    if res.as_ref().err().is_some_and(|e| classify(e) == Fail::Model) {
        if let Some(t) = replace_model(&key).await {
            target = Target { native_tools: target.native_tools, ..t };
            res = llm::step(&target, "Teste de conexão.", &msgs, &[probe_tool()], 25, Some(16), None).await;
        }
    }
    let ms = started.elapsed().as_millis() as u64;
    with(|st| {
        let Some(s) = st.slots.iter_mut().find(|s| s.info.key == key) else { return };
        s.info.checked_at = now();
        match res {
            Ok(r) => {
                s.info.ok = Some(true);
                s.info.error.clear();
                s.info.latency_ms = Some(ms);
                s.info.tools = tools;
                s.target.native_tools = tools != Some(false);
                apply_rate(s, &r.rate);
            }
            Err(e) => fail(s, &e),
        }
        s.probe_at = now() + probe_interval(s);
    });
}

/// Testa quem ainda não foi testado ou está na hora de repetir
pub async fn probe_due() {
    let due: Vec<String> = with(|st| st.slots.iter().filter(|s| !s.info.local && s.probe_at <= now()).map(|s| s.info.key.clone()).collect());
    let tasks: Vec<_> = due.into_iter().map(|k| tokio::spawn(probe(k))).collect();
    for t in tasks {
        t.await.ok();
    }
}

/// Teste manual (botão "Testar agora" em Config → IA)
pub async fn probe_all() {
    with(|st| st.slots.iter_mut().for_each(|s| s.probe_at = 0));
    probe_due().await;
}

pub fn spawn_monitor() {
    tauri::async_runtime::spawn(async {
        loop {
            probe_due().await;
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        }
    });
}

fn apply_rate(s: &mut Slot, r: &Rate) {
    let mut parts = Vec::new();
    if let Some(n) = r.remaining_req {
        parts.push(format!("restam {} req", n));
        if n == 0 {
            s.cooldown_until = now() + r.retry_after.unwrap_or(600).clamp(30, 3600);
        }
    }
    if let Some(n) = r.remaining_tok {
        parts.push(format!("{} tokens", n));
    }
    if !parts.is_empty() {
        s.info.rate = parts.join(" · ");
    }
}

fn fail(s: &mut Slot, err: &str) {
    s.info.error = err.chars().take(160).collect();
    // "Retry after 41 seconds": usa a espera que o próprio provedor informou
    let hinted = err.to_lowercase().split("retry after ").nth(1).and_then(|r| r.split_whitespace().next().and_then(|n| n.parse::<u64>().ok()));
    let (ok, wait) = match classify(err) {
        Fail::Limit => (None, hinted.map_or(900, |n| (n + 5).clamp(30, 3600))),
        Fail::Timeout => (None, 300),
        Fail::Auth => (Some(false), 3600),
        Fail::Unsupported => (None, 0),
        Fail::Model => (None, 60),
        Fail::Other => (None, 120),
    };
    if ok == Some(false) {
        s.info.ok = Some(false);
    }
    if wait > 0 {
        s.cooldown_until = now() + wait;
    }
}

pub fn report_ok(key: &str, rate: &Rate, ms: u64) {
    with(|st| {
        if let Some(s) = st.slots.iter_mut().find(|s| s.info.key == key) {
            s.info.ok = Some(true);
            s.info.error.clear();
            s.info.latency_ms = Some(ms);
            s.cooldown_until = 0;
            apply_rate(s, rate);
        }
    });
}

pub fn report_fail(key: &str, err: &str) {
    with(|st| {
        if let Some(s) = st.slots.iter_mut().find(|s| s.info.key == key) {
            fail(s, err);
            if classify(err) == Fail::Limit {
                s.probe_at = s.cooldown_until;
            }
        }
    });
}

/// O modelo recusou `tools`: daqui em diante ele conversa pelo protocolo em texto
pub fn set_text_mode(key: &str) {
    with(|st| {
        if let Some(s) = st.slots.iter_mut().find(|s| s.info.key == key) {
            s.info.tools = Some(false);
            s.target.native_tools = false;
        }
    });
}

fn score(s: &Slot, role: Role, preferred: &str, need_tools: bool) -> i32 {
    let i = &s.info;
    let lat = i.latency_ms.unwrap_or(1500) as i32;
    let mut v = i.quality * if role == Role::Main { 14 } else { 10 } / 10 + i.capacity / 2;
    // O escolhido em Config → IA conversa com você; os outros só entram se ele falhar
    // (ou como especialistas, onde o preferido ainda ganha vantagem)
    if i.provider == preferred {
        v += if role == Role::Main { 1000 } else { 40 };
    }
    v -= (lat / 250).min(30);
    // Modelo local (PC do usuário) é mais lento: só lidera se ele escolheu ou se o papel exige
    if i.local && role != Role::Local && i.provider != preferred {
        v -= 70;
    }
    if need_tools && i.tools == Some(false) {
        v -= if role == Role::Main { 30 } else { 10 };
    }
    match role {
        Role::Coder => {
            if is_code_model(&i.model) || i.provider == "claude" || i.provider == "openai" {
                v += 30;
            }
        }
        Role::Long => v += (i.ctx_k / 20).min(60),
        Role::Fast => v += (40 - lat / 100).clamp(0, 40) + if i.local { -20 } else { 0 },
        Role::Local | Role::Main => {}
    }
    v
}

#[derive(Clone)]
pub struct Pick {
    pub key: String,
    pub label: String,
    pub target: Target,
    pub local: bool,
}

/// Melhores opções para o papel, na ordem de tentativa. Quem está em "castigo"
/// (limite, falha recente) ou reprovado no teste vai para o fim.
pub fn ranked(role: Role, need_tools: bool) -> Vec<Pick> {
    with(|st| {
        let t = now();
        let mut list: Vec<(bool, i32, &Slot)> = st
            .slots
            .iter()
            .filter(|s| role != Role::Local || s.info.local)
            // pago só se for o escolhido: nunca gasta créditos sem o usuário pedir
            .filter(|s| !is_paid(&s.info.provider) || s.info.provider == st.preferred)
            .map(|s| {
                let usable = s.cooldown_until <= t && s.info.ok != Some(false);
                (usable, score(s, role, &st.preferred, need_tools), s)
            })
            .collect();
        list.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
        list.into_iter().map(|(_, _, s)| Pick { key: s.info.key.clone(), label: s.info.label.clone(), target: s.target.clone(), local: s.info.local }).collect()
    })
}

/// Papéis com pelo menos um provedor utilizável agora
pub fn usable_roles() -> Vec<Role> {
    with(|st| {
        let t = now();
        let usable: Vec<&Slot> = st
            .slots
            .iter()
            .filter(|s| s.cooldown_until <= t && s.info.ok != Some(false))
            .filter(|s| !is_paid(&s.info.provider) || s.info.provider == st.preferred)
            .collect();
        let mut out = Vec::new();
        if !usable.is_empty() {
            out.extend([Role::Coder, Role::Long, Role::Fast]);
        }
        if usable.iter().any(|s| s.info.local) {
            out.push(Role::Local);
        }
        out
    })
}

pub fn status() -> Vec<Info> {
    with(|st| {
        let t = now();
        let preferred = st.preferred.clone();
        let mut v: Vec<Info> = st
            .slots
            .iter()
            .map(|s| Info { cooldown_secs: s.cooldown_until.saturating_sub(t), score: score(s, Role::Main, &preferred, true), ..s.info.clone() })
            .collect();
        v.sort_by(|a, b| b.score.cmp(&a.score));
        v
    })
}

/// Carrega na memória o modelo local que vai responder (evita ~15 s na primeira mensagem)
pub async fn warm() {
    let Some(p) = ranked(Role::Main, true).into_iter().next().filter(|p| p.local) else { return };
    let body = json!({ "model": p.target.model, "prompt": "", "keep_alive": "30m", "stream": false });
    let _ = reqwest::Client::new().post(format!("{}/api/generate", p.target.base)).timeout(std::time::Duration::from_secs(120)).json(&body).send().await;
}

/// Há algum provedor bom (com chave, na nuvem) configurado? Sem ele só sobram o LLM7
/// sem chave e modelos locais, que respondem bem pior.
pub fn has_good_provider() -> bool {
    with(|st| st.slots.iter().any(|s| !s.info.local && s.info.provider != "llm7"))
}

/// O modelo configurado saiu do ar (404/"model not found"): procura outro na lista do
/// provedor e passa a usá-lo. Devolve o novo alvo, ou None se não achou substituto.
pub async fn replace_model(key: &str) -> Option<Target> {
    let (provider, target) = with(|st| st.slots.iter().find(|s| s.info.key == key).map(|s| (s.info.provider.clone(), s.target.clone())))?;
    let p = preset(&provider)?;
    if p.local || p.kind == Kind::Claude {
        return None;
    }
    let available = crate::api::list_models(target.base.clone(), Some(target.api_key.clone())).await.unwrap_or_default();
    let clean = |m: &str| m.trim_start_matches("models/").to_string();
    let available: Vec<String> = available.iter().map(|m| clean(m)).collect();
    let mut wanted: Vec<&str> = vec![p.model];
    wanted.extend(p.alternatives.iter().copied());
    let pick = wanted
        .iter()
        .filter(|m| **m != target.model)
        .find(|m| available.is_empty() || available.iter().any(|a| a == *m))
        .map(|m| m.to_string())?;
    eprintln!("[Lumo/cérebro] {}: modelo {} indisponível, trocando para {}", p.label, target.model, pick);
    REPLACED.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new).insert(provider.clone(), pick.clone());
    with(|st| {
        let s = st.slots.iter_mut().find(|s| s.info.key == key)?;
        s.target.model = pick.clone();
        s.info.model = pick.clone();
        s.info.ok = None;
        s.info.error.clear();
        s.cooldown_until = 0;
        Some(s.target.clone())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(preferred: &str, ids: &[&str]) {
        with(|st| {
            st.preferred = preferred.into();
            st.slots = ids
                .iter()
                .map(|id| {
                    let p = preset(id).unwrap();
                    let mut s = slot_for(p, &Cfg { api_key: "k".into(), ..Default::default() }, p.model, Some(true));
                    s.info.ok = Some(true);
                    s.info.latency_ms = Some(800);
                    s
                })
                .collect();
        });
    }

    #[test]
    fn escolhido_responde_e_pago_so_quando_escolhido() {
        set("groq", &["groq", "gemini", "claude", "openai", "llm7"]);
        let main: Vec<String> = ranked(Role::Main, true).into_iter().map(|p| p.key).collect();
        assert!(main[0].starts_with("groq:"), "{:?}", main);
        assert!(!main.iter().any(|k| k.starts_with("claude:") || k.starts_with("openai:")), "pago entrou sem ser escolhido: {:?}", main);
        assert!(main.last().unwrap().starts_with("llm7:"), "LLM7 deve ser o último recurso: {:?}", main);

        set("claude", &["groq", "claude"]);
        assert!(ranked(Role::Main, true)[0].key.starts_with("claude:"));
    }

    #[test]
    fn modelo_aposentado_e_reconhecido() {
        assert_eq!(classify("HTTP 404 — Groq respondeu: The model `llama3-70b` does not exist"), Fail::Model);
        assert_eq!(classify("HTTP 400 — Groq respondeu: model has been decommissioned"), Fail::Model);
        assert_eq!(classify("HTTP 429 — rate limit"), Fail::Limit);
    }
}
