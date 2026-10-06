// Orquestrador: o modelo principal conversa com o usuário e decide quando entregar uma
// tarefa a um agente especialista (coder, long, fast, local), cada um rodando no melhor
// provedor disponível para o papel. Tudo que vem dos especialistas — resultados, erros,
// troca de provedor por limite — fica entre eles e o modelo principal: o usuário só vê
// o que o principal decide dizer (e os pedidos de aprovação, que são dele).
use super::llm::{self, Call, Fail, Msg, Target, ToolDef};
use super::pool::{self, Pick, Role};
use super::tools::{self, Ctx};
use super::{memory, skills};
use crate::agent::{AgentEvent, CANCELLED};
use serde::Deserialize;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::Ordering;
use tauri::ipc::Channel;

const MAIN_STEPS: usize = 25;
const SUB_STEPS: usize = 12;
const CLOUD_TIMEOUT: u64 = 45;
const LOCAL_TIMEOUT: u64 = 90;

#[derive(Deserialize)]
pub struct SendReq {
    pub text: String,
    pub auto_approve: bool,
    #[serde(default)]
    pub persona: Option<String>,
}

fn env_info() -> String {
    static CACHE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    CACHE.get_or_init(env_info_uncached).clone()
}

fn env_info_uncached() -> String {
    let env = |k: &str| std::env::var(k).unwrap_or_default();
    let distro = std::fs::read_to_string("/etc/os-release")
        .ok()
        .and_then(|s| s.lines().find_map(|l| l.strip_prefix("PRETTY_NAME=").map(|v| v.trim_matches('"').to_string())))
        .unwrap_or_else(|| "Linux".into());
    // Pastas do usuário no idioma do sistema ("Vídeos", "Área de Trabalho"…): sem isso o
    // modelo chuta "videos" e não acha nada
    let dirs: Vec<String> = ["DESKTOP", "DOCUMENTS", "DOWNLOAD", "MUSIC", "PICTURES", "VIDEOS"]
        .iter()
        .filter_map(|k| {
            let out = std::process::Command::new("xdg-user-dir").arg(k).output().ok()?;
            let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
            (!p.is_empty()).then(|| format!("{}={}", k.to_lowercase(), p))
        })
        .collect();
    format!(
        "Sistema: {} , desktop {} em {}, usuário {}, pasta pessoal {} (diretório de trabalho dos comandos). Pastas do usuário: {}.",
        distro, env("XDG_CURRENT_DESKTOP"), env("XDG_SESSION_TYPE"), env("USER"), env("HOME"), dirs.join(", ")
    )
}

fn team_block() -> String {
    let roles = pool::usable_roles();
    if roles.is_empty() {
        return "\nEQUIPE: nenhum especialista disponível agora; resolva sozinho.\n".into();
    }
    let desc = |r: &Role| match r {
        Role::Coder => "coder (código e análise técnica)",
        Role::Long => "long (documentos e contextos muito grandes)",
        Role::Fast => "fast (respostas rápidas, resumos, traduções)",
        Role::Local => "local (dados privados; roda só neste PC)",
        Role::Main => "",
    };
    format!(
        "\nEQUIPE: com delegate(agent, task, context) você entrega trabalho a especialistas que rodam em outros provedores. Disponíveis agora: {}.\n",
        roles.iter().map(desc).collect::<Vec<_>>().join("; ")
    )
}

fn main_system(persona: Option<&str>) -> String {
    format!(
        "Você é o Lumo, assistente que vive na área de trabalho Linux do usuário. Você é o MODELO PRINCIPAL de uma equipe de agentes e tem acesso ao terminal, arquivos, memória permanente, skills e plugins.\n\
{env}\n\
{team}\
\nRegras:\n\
- Responda sempre em português do Brasil, de forma curta.\n\
- Quando o usuário pedir uma tarefa (instalar programa, converter arquivo, organizar pastas, ver informações do sistema…), FAÇA usando as ferramentas, um passo de cada vez, conferindo o resultado de cada comando.\n\
- Tarefas simples você resolve sozinho. Delegue quando houver um especialista melhor (código pesado, documento enorme, dados privados) ou para trabalho em paralelo ao seu raciocínio. A tarefa delegada deve ser completa e autossuficiente.\n\
- Tudo que vem dos especialistas (relatórios, erros, falhas de provedor, limites) é só para você: nunca repasse bruto. Sintetize só o que o usuário precisa saber. Se um especialista falhar, tente outro ou resolva sozinho; só fale de chaves/limites/provedores se o usuário precisar agir.\n\
- O usuário aprova cada comando; explique em uma frase o que ele faz (campo reason).\n\
- Pode usar sudo normalmente: a senha é pedida numa janela gráfica. Nunca peça a senha no chat.\n\
- Comandos sempre não interativos: apt-get install -y, sem editores (nano/vim), sem pagers (use | cat ou --no-pager).\n\
- Para instalar programas, nesta ordem: apt, o .deb oficial (wget -O /tmp/nome.deb URL e sudo apt-get install -y /tmp/nome.deb), flatpak, AppImage. Depois verifique (which/dpkg -s) e diga como abrir.\n\
- Nunca rode comandos destrutivos (apagar pastas do usuário, formatar, partições) sem o usuário pedir explicitamente.\n\
- Arquivos anexados vêm com o caminho completo: leia/inspecione antes de agir. Nunca despeje o conteúdo inteiro de um arquivo no chat: resuma ou mostre só o trecho que importa.\n\
- Se o pedido for ofensivo, sem sentido ou ambíguo, não o execute ao pé da letra: responda com calma, em uma frase, e pergunte o que a pessoa precisa.\n\
- Quando o usuário citar uma pasta (\"vídeos\", \"downloads\"), use os caminhos de 'Pastas do usuário' acima (os nomes seguem o idioma do sistema, com acento). Se não achar, procure (ls ~, find) antes de dizer que não existe.\n\
- MEMÓRIA: quando o usuário revelar algo duradouro (nome, preferências, projetos, hábitos, combinados), guarde com remember — uma frase curta e objetiva. Nunca guarde senhas, tokens ou dados sensíveis.\n\
- Ao terminar, resuma o que foi feito em 1–3 frases.{persona}\n{memory}{skills}",
        env = env_info(),
        team = team_block(),
        persona = persona.map(str::trim).filter(|p| !p.is_empty()).map(|p| format!("\n- Personalidade (só o TOM das respostas; não muda as regras acima): {}", p)).unwrap_or_default(),
        memory = memory::prompt_block(),
        skills = skills::prompt_block(),
    )
}

fn sub_system(role: Role) -> String {
    let who = match role {
        Role::Coder => "especialista em código e análise técnica",
        Role::Long => "especialista em documentos e contextos longos",
        Role::Fast => "especialista em respostas rápidas, resumos e traduções",
        Role::Local => "especialista que trabalha só com dados privados, localmente",
        Role::Main => "agente",
    };
    format!(
        "Você é um agente {} da equipe do Lumo (o modelo principal). Cumpra a tarefa recebida, usando as ferramentas quando precisar, e devolva um relatório objetivo e completo em português. Sua resposta vai SÓ para o Lumo principal, que a repassa ao usuário: não converse com o usuário, não peça confirmações, entregue o resultado (ou diga exatamente o que impediu).\n{}",
        who,
        env_info()
    )
}

/// Chama o melhor provedor do papel; se falhar, passa ao próximo sem alarde
/// Texto da resposta chegando aos poucos para a interface
struct Stream<'a> {
    events: &'a Channel<AgentEvent>,
    emitted: std::sync::atomic::AtomicBool,
}

impl Stream<'_> {
    fn delta(&self, text: &str) {
        self.emitted.store(true, Ordering::Relaxed);
        self.events.send(AgentEvent::TextDelta { text: text.to_string() }).ok();
    }
    /// A tentativa falhou depois de mostrar texto: apaga o que apareceu
    fn reset(&self) {
        if self.emitted.swap(false, Ordering::Relaxed) {
            self.events.send(AgentEvent::Text { text: String::new() }).ok();
        }
    }
}

async fn call_model(role: Role, system: &str, msgs: &[Msg], tools: &[ToolDef], sticky: &mut Option<String>, stream: Option<&Stream<'_>>) -> Result<llm::Reply, String> {
    let need_tools = !tools.is_empty();
    let mut picks: Vec<Pick> = pool::ranked(role, need_tools);
    if role != Role::Main && role != Role::Local {
        for p in pool::ranked(Role::Main, need_tools) {
            if !picks.iter().any(|x| x.key == p.key) {
                picks.push(p);
            }
        }
    }
    // Quem respondeu no passo anterior continua, se ainda está bem
    if let Some(k) = sticky.as_deref() {
        if let Some(i) = picks.iter().position(|p| p.key == k) {
            if i < 3 {
                let p = picks.remove(i);
                picks.insert(0, p);
            }
        }
    }
    if picks.is_empty() {
        return Err("nenhum provedor configurado".into());
    }
    let mut last = String::from("sem resposta");
    for mut pick in picks.into_iter().take(5) {
        for attempt in 0..2 {
            if CANCELLED.load(Ordering::Relaxed) {
                return Err("cancelado".into());
            }
            let started = std::time::Instant::now();
            let timeout = if pick.local { LOCAL_TIMEOUT } else { CLOUD_TIMEOUT };
            let cb = stream.map(|s| move |d: &str| s.delta(d));
            let cb_ref = cb.as_ref().map(|c| c as &(dyn Fn(&str) + Send + Sync));
            let res = llm::step(&pick.target, system, msgs, tools, timeout, None, cb_ref).await;
            if res.is_err() {
                if let Some(s) = stream {
                    s.reset();
                }
            }
            match res {
                Ok(r) if r.text.trim().is_empty() && r.calls.is_empty() => {
                    last = format!("{}: resposta vazia", pick.label);
                    pool::report_fail(&pick.key, &last);
                    break;
                }
                Ok(r) => {
                    pool::report_ok(&pick.key, &r.rate, started.elapsed().as_millis() as u64);
                    *sticky = Some(pick.key.clone());
                    return Ok(r);
                }
                Err(e) if attempt == 0 && llm::classify(&e) == Fail::Unsupported => {
                    pool::set_text_mode(&pick.key);
                    pick.target.native_tools = false;
                }
                // Modelo aposentado pelo provedor: troca por outro da lista e tenta de novo
                Err(e) if attempt == 0 && llm::classify(&e) == Fail::Model => match pool::replace_model(&pick.key).await {
                    Some(t) => pick.target = Target { native_tools: pick.target.native_tools, ..t },
                    None => {
                        pool::report_fail(&pick.key, &e);
                        last = e;
                        break;
                    }
                },
                Err(e) => {
                    eprintln!("[Lumo/cérebro] {} falhou: {}", pick.label, e);
                    pool::report_fail(&pick.key, &e);
                    last = e;
                    break;
                }
            }
        }
    }
    Err(last)
}

type Run<'a> = Pin<Box<dyn Future<Output = Result<String, String>> + Send + 'a>>;

/// Laço de ferramentas até o modelo terminar. `emit` = mostra as falas no chat (só o principal).
fn run_loop<'a>(role: Role, system: String, mut msgs: Vec<Msg>, tools: Vec<ToolDef>, ctx: &'a Ctx, max_steps: usize, emit: bool) -> Run<'a> {
    Box::pin(async move {
        let mut last_text = String::new();
        let mut sticky: Option<String> = None;
        // modelos pequenos repetem a mesma chamada: a repetição devolve o resultado anterior
        let mut done: HashMap<String, String> = HashMap::new();
        for _ in 0..max_steps {
            if CANCELLED.load(Ordering::Relaxed) {
                return Ok(last_text);
            }
            let stream = emit.then(|| Stream { events: &ctx.events, emitted: Default::default() });
            let reply = call_model(role, &system, &msgs, &tools, &mut sticky, stream.as_ref()).await?;
            let streamed = stream.as_ref().is_some_and(|s| s.emitted.load(Ordering::Relaxed));
            if emit && streamed && reply.text.trim().is_empty() {
                ctx.events.send(AgentEvent::Text { text: String::new() }).ok(); // apaga o rascunho
            }
            if !reply.text.trim().is_empty() {
                if emit {
                    ctx.events.send(AgentEvent::Text { text: reply.text.clone() }).ok();
                    ctx.record(reply.text.clone());
                }
                last_text = reply.text.clone();
            }
            if reply.calls.is_empty() {
                return Ok(last_text);
            }
            msgs.push(Msg::Assistant { text: reply.text.clone(), calls: reply.calls.clone() });
            for call in reply.calls {
                let sig = format!("{}:{}", call.name, call.args);
                let out = if let Some(prev) = done.get(&sig).filter(|_| call.name != "delegate") {
                    format!("Isto já foi feito nesta tarefa (não repita). Resultado anterior:\n{}", prev)
                } else {
                    let r = if call.name == "delegate" { delegate(ctx, &call).await } else { tools::execute(ctx, &call).await };
                    done.insert(sig, r.clone());
                    r
                };
                msgs.push(Msg::Tool { call_id: call.id, name: call.name, content: out });
            }
        }
        if emit {
            let t = "Parei aqui: foram muitos passos seguidos. Quer que eu continue?".to_string();
            ctx.events.send(AgentEvent::Text { text: t.clone() }).ok();
            ctx.record(t);
        }
        Ok(last_text)
    })
}

async fn delegate(ctx: &Ctx, call: &Call) -> String {
    let agent = call.args["agent"].as_str().unwrap_or("");
    let Some(role) = Role::parse(agent) else { return "Agente inválido. Use: coder, long, fast ou local.".into() };
    let task = call.args["task"].as_str().unwrap_or("").trim();
    if task.is_empty() {
        return "Erro: tarefa vazia.".into();
    }
    let context = call.args["context"].as_str().unwrap_or("").trim();
    let prompt = if context.is_empty() { task.to_string() } else { format!("{}\n\nContexto:\n{}", task, context) };
    let tools = tools::defs(false).await;
    match run_loop(role, sub_system(role), vec![Msg::User(prompt)], tools, ctx, SUB_STEPS, false).await {
        Ok(t) if t.trim().is_empty() => format!("O agente {} terminou sem relatório.", agent),
        Ok(t) => t.chars().take(12_000).collect(),
        Err(e) => format!("FALHA do agente {}: {}. Tente outro agente ou resolva você mesmo.", agent, e),
    }
}

/// Mensagem do usuário → modelo principal (+ equipe). Devolve Err só se nenhum modelo respondeu.
#[tauri::command]
pub async fn brain_send(req: SendReq, events: Channel<AgentEvent>) -> Result<(), String> {
    CANCELLED.store(false, Ordering::Relaxed);
    memory::push_turn("user", &req.text);
    let ctx = Ctx { events, auto: req.auto_approve, transcript: Default::default() };
    let tools = tools::defs(true).await;
    let result = run_loop(Role::Main, main_system(req.persona.as_deref()), memory::history(), tools, &ctx, MAIN_STEPS, true).await;
    let transcript = ctx.transcript.lock().unwrap_or_else(|e| e.into_inner()).join("\n");
    memory::push_turn("assistant", &transcript);
    tauri::async_runtime::spawn(compact());
    match result {
        Ok(_) => Ok(()),
        Err(e) => {
            eprintln!("[Lumo/cérebro] nenhum modelo respondeu: {}", e);
            Err(if pool::status().is_empty() {
                "Ainda não tenho nenhum modelo configurado. Abra Config → IA.".into()
            } else if !pool::has_good_provider() {
                "Não consegui resposta: sem uma chave, só sobram o LLM7 grátis e os modelos locais, que vivem lotados ou lentos. Pegue uma chave grátis do Groq ou do Gemini (1 minuto, sem cartão) em Config → IA.".into()
            } else {
                "Não consegui falar com nenhum modelo agora. Já estou testando de novo; tente em instantes.".into()
            })
        }
    }
}

/// Pergunta avulsa, sem ferramentas nem histórico (ex.: dicas no terminal)
#[tauri::command]
pub async fn brain_ask(prompt: String) -> Result<String, String> {
    let mut sticky = None;
    llm_text(Role::Fast, "Você é o Lumo, assistente de Linux. Responda em português, direto e conciso.", &prompt, &mut sticky).await
}

async fn llm_text(role: Role, system: &str, prompt: &str, sticky: &mut Option<String>) -> Result<String, String> {
    call_model(role, system, &[Msg::User(prompt.into())], &[], sticky, None).await.map(|r| r.text)
}

/// Conversa longa: as falas antigas viram resumo
async fn compact() {
    let Some((old, turns)) = memory::take_for_compaction() else { return };
    let mut text = String::new();
    for t in &turns {
        let body: String = t.text.chars().take(1500).collect();
        text.push_str(&format!("{}: {}\n", if t.role == "user" { "USUÁRIO" } else { "LUMO" }, body));
    }
    let prompt = format!(
        "Resumo anterior:\n{}\n\nNovas falas:\n{}\n\nAtualize o resumo em até 250 palavras, em português: preserve decisões, preferências, tarefas pendentes, caminhos de arquivos e o que já foi executado. Responda só com o resumo.",
        if old.is_empty() { "(nenhum)" } else { &old },
        text
    );
    let mut sticky = None;
    let summary = match llm_text(Role::Fast, "Você condensa conversas para servir de memória.", &prompt, &mut sticky).await {
        Ok(s) if s.trim().len() > 20 => s,
        _ => memory::fallback_summary(&old, &turns),
    };
    memory::apply_compaction(summary, turns.len());
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// Ponta a ponta com modelos reais: o principal recebe um pedido, delega a um
    /// especialista e responde. Os eventos que chegariam à interface são coletados.
    #[tokio::test]
    #[ignore = "precisa do Ollama rodando"]
    async fn principal_delega_e_responde() {
        pool::configure(Default::default(), "ollama".into()).await;
        let seen: Arc<std::sync::Mutex<Vec<String>>> = Default::default();
        let s2 = seen.clone();
        let events = Channel::<AgentEvent>::new(move |body| {
            s2.lock().unwrap().push(format!("{:?}", body));
            Ok(())
        });
        let ctx = Ctx { events, auto: true, transcript: Default::default() };
        let tools = tools::defs(true).await;
        println!("ferramentas: {:?}", tools.iter().map(|t| t.name.clone()).collect::<Vec<_>>());
        let msgs = vec![Msg::User("Delegue ao agente fast a pergunta 'quanto é 17 vezes 3?' (use a ferramenta delegate) e me diga o resultado.".into())];
        let out = run_loop(Role::Main, main_system(None), msgs, tools, &ctx, 6, true).await;
        println!("resultado: {:?}", out);
        println!("eventos: {:?}", seen.lock().unwrap());
        println!("transcript: {:?}", ctx.transcript.lock().unwrap());
        assert!(out.is_ok());
    }

    /// A delegação direta: o especialista responde ao principal e nada vai para a interface
    #[tokio::test]
    #[ignore = "precisa do Ollama rodando"]
    async fn delegacao_fica_entre_os_agentes() {
        pool::configure(Default::default(), "ollama".into()).await;
        let seen: Arc<std::sync::Mutex<Vec<String>>> = Default::default();
        let s2 = seen.clone();
        let events = Channel::<AgentEvent>::new(move |body| {
            s2.lock().unwrap().push(format!("{:?}", body));
            Ok(())
        });
        let ctx = Ctx { events, auto: true, transcript: Default::default() };
        let call = Call { id: "t".into(), name: "delegate".into(), args: serde_json::json!({ "agent": "fast", "task": "Quanto é 17 vezes 3? Responda só o número." }) };
        let out = delegate(&ctx, &call).await;
        println!("relatório: {:?}", out);
        println!("eventos na interface: {:?}", seen.lock().unwrap());
        assert!(out.contains("51"));
        assert!(seen.lock().unwrap().is_empty(), "o especialista não pode falar com o usuário");
        let bad = delegate(&ctx, &Call { id: "t".into(), name: "delegate".into(), args: serde_json::json!({ "agent": "local", "task": "oi" }) }).await;
        println!("local: {:?}", bad);
    }

    /// O texto chega em vários pedaços, e o Text final o substitui
    #[tokio::test]
    #[ignore = "precisa do Ollama rodando"]
    async fn resposta_chega_aos_poucos() {
        pool::configure(Default::default(), "ollama".into()).await;
        let seen: Arc<std::sync::Mutex<Vec<String>>> = Default::default();
        let s2 = seen.clone();
        let events = Channel::<AgentEvent>::new(move |body| {
            s2.lock().unwrap().push(format!("{:?}", body));
            Ok(())
        });
        let ctx = Ctx { events, auto: true, transcript: Default::default() };
        let msgs = vec![Msg::User("Conte de 1 a 12 por extenso, separado por vírgulas.".into())];
        let out = run_loop(Role::Main, "Responda em português.".into(), msgs, vec![], &ctx, 2, true).await.unwrap();
        let ev = seen.lock().unwrap().clone();
        let deltas = ev.iter().filter(|e| e.contains("text_delta")).count();
        println!("final: {:?}\npedaços: {}\n{:?}", out, deltas, &ev[..ev.len().min(4)]);
        assert!(deltas > 1, "esperava vários pedaços");
        assert!(ev.last().unwrap().contains("\\\"type\\\":\\\"text\\\""));
    }
}
