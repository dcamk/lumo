// Cliente de modelos neutro: a conversa é guardada num formato próprio (`Msg`) e só é
// convertida para o formato do provedor (OpenAI, Claude ou texto) a cada chamada.
// Por isso dá para trocar de provedor no meio de uma tarefa sem perder o fio.
use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::Duration;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    OpenAi,
    Claude,
    /// API nativa do Ollama (/api/chat): permite contexto maior e manter o modelo na memória
    Ollama,
}

#[derive(Clone, Debug)]
pub struct Target {
    pub kind: Kind,
    pub label: String,
    pub base: String,
    pub api_key: String,
    pub model: String,
    /// false = o modelo não aceita `tools`: as ferramentas vão descritas no prompt
    pub native_tools: bool,
}

#[derive(Clone, Debug)]
pub struct Call {
    pub id: String,
    pub name: String,
    pub args: Value,
}

#[derive(Clone, Debug)]
pub enum Msg {
    User(String),
    Assistant { text: String, calls: Vec<Call> },
    Tool { call_id: String, name: String, content: String },
}

#[derive(Clone)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub schema: Value,
}

/// Limites informados pelo provedor nos cabeçalhos da resposta
#[derive(Clone, Default, Debug)]
pub struct Rate {
    pub remaining_req: Option<u64>,
    pub remaining_tok: Option<u64>,
    pub retry_after: Option<u64>,
}

pub struct Reply {
    pub text: String,
    pub calls: Vec<Call>,
    pub rate: Rate,
}

fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| reqwest::Client::builder().connect_timeout(Duration::from_secs(10)).build().unwrap_or_default())
}

#[derive(PartialEq, Eq, Debug)]
pub enum Fail {
    Limit,
    Timeout,
    /// Servidor fora do ar, sobrecarregado ou conexão caída (5xx, rede)
    Server,
    Auth,
    Unsupported,
    Other,
}

impl Fail {
    /// Falhas passageiras do provedor: troca na hora para o próximo, sem insistir no mesmo
    pub fn recoverable(&self) -> bool {
        matches!(self, Fail::Limit | Fail::Timeout | Fail::Server | Fail::Unsupported)
    }
}

pub fn classify(err: &str) -> Fail {
    let e = err.to_lowercase();
    if e.contains("ferramentas não suportadas") {
        Fail::Unsupported
    } else if e.contains("http 429") || e.contains("quota") || e.contains("rate limit") || e.contains("rate_limit") {
        Fail::Limit
    } else if e.contains("tempo esgotado") || e.contains("timed out") || e.contains("timeout") {
        Fail::Timeout
    } else if is_server_error(&e) {
        Fail::Server
    } else if e.contains("http 401") || e.contains("http 402") || e.contains("http 403") || e.contains("api key") || e.contains("unauthorized") || e.contains("insufficient balance") {
        Fail::Auth
    } else {
        Fail::Other
    }
}

/// HTTP 5xx, sobrecarga ou rede caída (as mensagens vêm de `post`/`send_stream`)
fn is_server_error(e: &str) -> bool {
    let http5 = e.find("http 5").is_some_and(|i| e[i + 6..].chars().take(2).all(|c| c.is_ascii_digit()));
    http5
        || e.contains("overloaded")
        || e.contains("service unavailable")
        || e.contains("bad gateway")
        || e.contains("não consegui conectar")
        || e.contains("conexão com")
        || e.contains("connection reset")
        || e.contains("connection refused")
}

fn rate_of(headers: &reqwest::header::HeaderMap) -> Rate {
    let mut rate = Rate::default();
    for (name, value) in headers {
        let n = name.as_str().to_lowercase();
        let Some(v) = value.to_str().ok().and_then(|v| v.trim().parse::<f64>().ok()) else { continue };
        let v = v as u64;
        let min = |slot: &mut Option<u64>| *slot = Some(slot.map_or(v, |s| s.min(v)));
        if n.contains("ratelimit") && n.contains("remaining") && n.contains("request") {
            min(&mut rate.remaining_req);
        } else if n.contains("ratelimit") && n.contains("remaining") && n.contains("token") {
            min(&mut rate.remaining_tok);
        } else if n == "retry-after" {
            rate.retry_after = Some(v);
        }
    }
    rate
}

async fn post(url: &str, headers: &[(&str, String)], body: &Value, label: &str, timeout: u64) -> Result<(Value, Rate), String> {
    let mut rb = client().post(url).timeout(Duration::from_secs(timeout.max(5))).json(body);
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
    let rate = rate_of(res.headers());
    let text = res.text().await.unwrap_or_default();
    let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if !status.is_success() {
        let msg = v["error"]["message"]
            .as_str()
            .or_else(|| v["error"].as_str())
            .or_else(|| v["message"].as_str())
            .map(str::to_string)
            .unwrap_or_else(|| text.chars().take(160).collect());
        return Err(format!("HTTP {} — {} respondeu: {}", status.as_u16(), label, msg));
    }
    Ok((v, rate))
}

fn strip_thinking(text: &str) -> String {
    strip_think_raw(text).trim().to_string()
}

/// Sem aparar espaços: o prefixo só cresce, então dá para transmitir aos poucos
fn strip_think_raw(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(a) = rest.find("<think>") {
        out.push_str(&rest[..a]);
        match rest[a..].find("</think>") {
            Some(b) => rest = &rest[a + b + 8..],
            None => {
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out
}

// ---- protocolo em texto (modelos sem ferramentas nativas) --------------------------------

fn text_protocol(tools: &[ToolDef]) -> String {
    let list: Vec<String> = tools
        .iter()
        .map(|t| format!("- {}: {} Parâmetros (JSON Schema): {}", t.name, t.description, t.schema))
        .collect();
    format!(
        "FERRAMENTAS: para usar uma ferramenta, escreva EXATAMENTE um bloco assim e pare em seguida:\n\
<tool_call>{{\"name\":\"NOME\",\"arguments\":{{...}}}}</tool_call>\n\
O resultado chega na próxima mensagem. Quando não precisar de ferramenta, responda normalmente.\n\
Ferramentas disponíveis:\n{}",
        list.join("\n")
    )
}

/// Extrai chamadas escritas no texto: <tool_call>{…}</tool_call>, <run>cmd</run> ou ```json
#[cfg(test)]
pub fn parse_text_calls_pub(text: &str, tools: &[ToolDef]) -> (String, Vec<Call>) { parse_text_calls(text, tools) }
fn parse_text_calls(text: &str, tools: &[ToolDef]) -> (String, Vec<Call>) {
    let known = |n: &str| tools.iter().any(|t| t.name == n);
    let mut calls = Vec::new();
    let mut shown = text.to_string();
    let mut n = 0;
    let mut mk = |name: String, args: Value| {
        n += 1;
        Call { id: format!("txt-{}-{}", crate::agent::COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed), n), name, args }
    };
    while let Some(a) = shown.find("<tool_call>") {
        let Some(b) = shown[a..].find("</tool_call>").map(|e| a + e) else { break };
        let inner = shown[a + 11..b].trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim().to_string();
        if let Ok(v) = serde_json::from_str::<Value>(&inner) {
            if let Some(name) = v["name"].as_str().filter(|n| known(n)) {
                let args = match &v["arguments"] {
                    Value::String(s) => serde_json::from_str(s).unwrap_or(Value::Null),
                    Value::Null => v["parameters"].clone(),
                    other => other.clone(),
                };
                calls.push(mk(name.to_string(), args));
            }
        }
        shown.replace_range(a..b + 12, "");
    }
    if calls.is_empty() {
        // JSON da chamada solto no texto (com ou sem ```json, <>, frases em volta)
        let starts: Vec<usize> = shown.match_indices('{').map(|(i, _)| i).collect();
        for i in starts {
            let mut it = serde_json::Deserializer::from_str(&shown[i..]).into_iter::<Value>();
            let Some(Ok(v)) = it.next() else { continue };
            let Some(name) = v["name"].as_str().filter(|n| known(n)) else { continue };
            let args = match &v["arguments"] {
                Value::String(s) => serde_json::from_str(s).unwrap_or(Value::Null),
                Value::Null => v["parameters"].clone(),
                other => other.clone(),
            };
            let end = i + it.byte_offset();
            calls.push(mk(name.to_string(), args));
            shown.replace_range(i..end, "");
            shown = shown.replace("```json", "").replace("```", "").replace("<>", "");
            break;
        }
    }
    if calls.is_empty() && known("run_command") {
        if let (Some(a), Some(b)) = (shown.find("<run>"), shown.find("</run>")) {
            if b > a {
                let cmd = shown[a + 5..b].trim().trim_start_matches("```bash").trim_start_matches("```").trim_end_matches("```").trim().to_string();
                if !cmd.is_empty() {
                    calls.push(mk("run_command".into(), json!({ "command": cmd, "reason": "" })));
                    shown.replace_range(a..b + 6, "");
                }
            }
        }
    }
    (shown.trim().to_string(), calls)
}

// ---- conversão por formato ----------------------------------------------------------------

fn to_openai(system: &str, msgs: &[Msg], text_mode: bool) -> Vec<Value> {
    let mut out = vec![json!({ "role": "system", "content": system })];
    for m in msgs {
        match m {
            Msg::User(t) => out.push(json!({ "role": "user", "content": t })),
            Msg::Assistant { text, calls } if text_mode => {
                let mut t = text.clone();
                for c in calls {
                    t.push_str(&format!("\n<tool_call>{}</tool_call>", json!({ "name": c.name, "arguments": c.args })));
                }
                out.push(json!({ "role": "assistant", "content": t.trim() }));
            }
            Msg::Assistant { text, calls } => {
                let mut v = json!({ "role": "assistant", "content": if text.is_empty() { Value::Null } else { Value::String(text.clone()) } });
                if !calls.is_empty() {
                    v["tool_calls"] = Value::Array(
                        calls.iter().map(|c| json!({ "id": c.id, "type": "function", "function": { "name": c.name, "arguments": c.args.to_string() } })).collect(),
                    );
                }
                out.push(v);
            }
            Msg::Tool { name, content, .. } if text_mode => {
                out.push(json!({ "role": "user", "content": format!("Resultado de {}:\n{}", name, content) }))
            }
            Msg::Tool { call_id, content, .. } => out.push(json!({ "role": "tool", "tool_call_id": call_id, "content": content })),
        }
    }
    out
}

fn to_ollama(system: &str, msgs: &[Msg]) -> Vec<Value> {
    let mut out = vec![json!({ "role": "system", "content": system })];
    for m in msgs {
        match m {
            Msg::User(t) => out.push(json!({ "role": "user", "content": t })),
            Msg::Assistant { text, calls } => {
                let mut v = json!({ "role": "assistant", "content": text });
                if !calls.is_empty() {
                    v["tool_calls"] = Value::Array(calls.iter().map(|c| json!({ "function": { "name": c.name, "arguments": c.args } })).collect());
                }
                out.push(v);
            }
            Msg::Tool { name, content, .. } => out.push(json!({ "role": "tool", "tool_name": name, "content": content })),
        }
    }
    out
}

fn to_claude(msgs: &[Msg]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    // Claude exige papéis alternados: junta blocos seguidos do mesmo papel
    let mut push = |role: &str, blocks: Vec<Value>| {
        if let Some(last) = out.last_mut() {
            if last["role"] == role {
                if let Some(arr) = last["content"].as_array_mut() {
                    arr.extend(blocks);
                    return;
                }
            }
        }
        out.push(json!({ "role": role, "content": blocks }));
    };
    for m in msgs {
        match m {
            Msg::User(t) => push("user", vec![json!({ "type": "text", "text": t })]),
            Msg::Assistant { text, calls } => {
                let mut b = Vec::new();
                if !text.trim().is_empty() {
                    b.push(json!({ "type": "text", "text": text }));
                }
                for c in calls {
                    b.push(json!({ "type": "tool_use", "id": c.id, "name": c.name, "input": c.args }));
                }
                if b.is_empty() {
                    b.push(json!({ "type": "text", "text": "…" }));
                }
                push("assistant", b);
            }
            Msg::Tool { call_id, content, .. } => push("user", vec![json!({ "type": "tool_result", "tool_use_id": call_id, "content": content })]),
        }
    }
    out
}

/// Uma rodada de conversa: o modelo responde com texto e/ou pedidos de ferramenta
pub async fn step(t: &Target, system: &str, msgs: &[Msg], tools: &[ToolDef], timeout: u64, max_tokens: Option<u32>, on_text: OnText<'_>) -> Result<Reply, String> {
    let text_mode = !tools.is_empty() && !t.native_tools;
    let system = if text_mode { format!("{}\n\n{}", system, text_protocol(tools)) } else { system.to_string() };
    let native = !tools.is_empty() && t.native_tools;

    let (raw_text, mut calls, rate) = match t.kind {
        Kind::Claude => {
            let defs: Vec<Value> = tools.iter().map(|d| json!({ "name": d.name, "description": d.description, "input_schema": d.schema })).collect();
            let mut body = json!({ "model": t.model, "max_tokens": max_tokens.unwrap_or(8000), "system": system, "messages": to_claude(msgs) });
            if native {
                body["tools"] = Value::Array(defs);
            }
            let headers = vec![("x-api-key", t.api_key.clone()), ("anthropic-version", "2023-06-01".to_string())];
            let (v, rate) = post("https://api.anthropic.com/v1/messages", &headers, &body, &t.label, timeout).await.map_err(tools_hint(native))?;
            let mut text = String::new();
            let mut calls = Vec::new();
            for b in v["content"].as_array().cloned().unwrap_or_default() {
                match b["type"].as_str() {
                    Some("text") => text.push_str(b["text"].as_str().unwrap_or("")),
                    Some("tool_use") => calls.push(Call {
                        id: b["id"].as_str().unwrap_or("").to_string(),
                        name: b["name"].as_str().unwrap_or("").to_string(),
                        args: b["input"].clone(),
                    }),
                    _ => {}
                }
            }
            (text, calls, rate)
        }
        Kind::Ollama => {
            let messages = if text_mode { to_openai(&system, msgs, true) } else { to_ollama(&system, msgs) };
            let mut body = json!({
                "model": t.model, "messages": messages, "stream": false, "keep_alive": "30m",
                // o padrão do Ollama (4096) corta o prompt com as ferramentas
                "options": { "num_ctx": 8192 }
            });
            if let Some(m) = max_tokens {
                body["options"]["num_predict"] = json!(m);
            }
            if native {
                body["tools"] = Value::Array(
                    tools.iter().map(|d| json!({ "type": "function", "function": { "name": d.name, "description": d.description, "parameters": d.schema } })).collect(),
                );
            }
            if let Some(cb) = on_text {
                let (text, calls, rate) = stream_ollama(&format!("{}/api/chat", t.base), body, &t.label, timeout, cb).await.map_err(tools_hint(native))?;
                (text, calls, rate)
            } else {
            let (v, rate) = post(&format!("{}/api/chat", t.base), &[], &body, &t.label, timeout).await.map_err(tools_hint(native))?;
            let msg = &v["message"];
            let calls: Vec<Call> = msg["tool_calls"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|c| Call {
                            id: format!("ol-{}", crate::agent::COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)),
                            name: c["function"]["name"].as_str().unwrap_or("").to_string(),
                            args: match &c["function"]["arguments"] {
                                Value::String(s) => serde_json::from_str(s).unwrap_or(Value::Null),
                                other => other.clone(),
                            },
                        })
                        .collect()
                })
                .unwrap_or_default();
            (msg["content"].as_str().unwrap_or("").to_string(), calls, rate)
            }
        }
        Kind::OpenAi => {
            let mut headers = vec![("X-Title", "Lumo".to_string())];
            if !t.api_key.trim().is_empty() {
                headers.push(("Authorization", format!("Bearer {}", t.api_key.trim())));
            }
            let mut body = json!({ "model": t.model, "messages": to_openai(&system, msgs, text_mode) });
            if let Some(m) = max_tokens {
                body["max_tokens"] = json!(m);
            }
            if native {
                let defs: Vec<Value> = tools
                    .iter()
                    .map(|d| json!({ "type": "function", "function": { "name": d.name, "description": d.description, "parameters": d.schema } }))
                    .collect();
                body["tools"] = Value::Array(defs);
                body["tool_choice"] = json!("auto");
            }
            if let Some(cb) = on_text {
                stream_openai(&format!("{}/chat/completions", t.base), &headers, body, &t.label, timeout, cb).await.map_err(tools_hint(native))?
            } else {
            let (v, rate) = post(&format!("{}/chat/completions", t.base), &headers, &body, &t.label, timeout).await.map_err(tools_hint(native))?;
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
            (msg["content"].as_str().unwrap_or("").to_string(), calls, rate)
            }
        }
    };

    let mut text = strip_thinking(&raw_text);
    if calls.is_empty() && !tools.is_empty() {
        // modo texto — ou um modelo nativo que escreveu a chamada no texto
        let (rest, parsed) = parse_text_calls(&text, tools);
        if !parsed.is_empty() {
            text = rest.replace("<tools>", "").replace("</tools>", "").trim().to_string();
            calls = parsed;
        }
    }
    Ok(Reply { text, calls, rate })
}

fn tools_hint(native: bool) -> impl Fn(String) -> String {
    move |e: String| {
        let l = e.to_lowercase();
        if native && l.contains("http 4") && (l.contains("tool") || l.contains("function")) && !l.contains("http 429") {
            format!("ferramentas não suportadas — {}", e)
        } else {
            e
        }
    }
}


// ---- streaming ----------------------------------------------------------------------------

type OnText<'a> = Option<&'a (dyn Fn(&str) + Send + Sync)>;

/// Repassa o texto aos poucos, sem o raciocínio (<think>) e parando se a resposta
/// parece uma chamada de ferramenta escrita no texto (essa não deve aparecer ao usuário)
struct Filter<'a> {
    raw: String,
    sent: usize,
    suppress: bool,
    cb: &'a (dyn Fn(&str) + Send + Sync),
}

impl Filter<'_> {
    fn push(&mut self, delta: &str) {
        self.raw.push_str(delta);
        if self.suppress {
            return;
        }
        let vis = strip_think_raw(&self.raw);
        if vis.trim_start().starts_with('{') || vis.contains("<tool_call>") || vis.contains("<run>") || vis.contains("```json") {
            self.suppress = true;
            return;
        }
        if self.sent == 0 {
            self.sent = vis.len() - vis.trim_start().len();
        }
        let mut end = vis.len();
        // "<thi" pode ser o começo de <think>: espera o resto
        for k in 1..7 {
            if vis.ends_with(&"<think>"[..k]) {
                end = vis.len() - k;
            }
        }
        if end > self.sent && vis.is_char_boundary(self.sent) && vis.is_char_boundary(end) {
            (self.cb)(&vis[self.sent..end]);
            self.sent = end;
        }
    }
}

/// Faz o POST e devolve a resposta aberta (erros HTTP já convertidos em mensagem)
async fn send_stream(url: &str, headers: &[(&str, String)], body: &Value, label: &str, timeout: u64) -> Result<(reqwest::Response, Rate), String> {
    let mut rb = client().post(url).json(body);
    for (k, v) in headers {
        rb = rb.header(*k, v);
    }
    let slow = || format!("tempo esgotado: {} demorou mais de {} s", label, timeout);
    let res = tokio::time::timeout(Duration::from_secs(timeout.max(5)), rb.send())
        .await
        .map_err(|_| slow())?
        .map_err(|e| format!("Não consegui conectar ao {}: {}", label, e))?;
    let status = res.status();
    let rate = rate_of(res.headers());
    if !status.is_success() {
        let text = res.text().await.unwrap_or_default();
        let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        let msg = v["error"]["message"].as_str().or_else(|| v["error"].as_str()).or_else(|| v["message"].as_str()).map(str::to_string).unwrap_or_else(|| text.chars().take(160).collect());
        return Err(format!("HTTP {} — {} respondeu: {}", status.as_u16(), label, msg));
    }
    Ok((res, rate))
}

/// Lê o corpo em linhas completas; cada pedaço precisa chegar dentro do tempo-limite
async fn for_each_line(mut res: reqwest::Response, label: &str, timeout: u64, mut f: impl FnMut(&str) -> Result<(), String>) -> Result<(), String> {
    let mut buf: Vec<u8> = Vec::new();
    let started = std::time::Instant::now();
    loop {
        let chunk = tokio::time::timeout(Duration::from_secs(timeout.max(5)), res.chunk())
            .await
            .map_err(|_| format!("tempo esgotado: {} parou de responder por {} s", label, timeout))?
            .map_err(|e| format!("Conexão com {} caiu: {}", label, e))?;
        let Some(chunk) = chunk else { break };
        buf.extend_from_slice(&chunk);
        while let Some(i) = buf.iter().position(|&b| b == b'\n') {
            let line = String::from_utf8_lossy(&buf[..i]).trim().to_string();
            buf.drain(..=i);
            if !line.is_empty() {
                f(&line)?;
            }
        }
        if started.elapsed() > Duration::from_secs(900) {
            return Err(format!("tempo esgotado: {} passou de 15 min", label));
        }
    }
    let rest = String::from_utf8_lossy(&buf).trim().to_string();
    if !rest.is_empty() {
        f(&rest)?;
    }
    Ok(())
}

async fn stream_openai(url: &str, headers: &[(&str, String)], mut body: Value, label: &str, timeout: u64, cb: &(dyn Fn(&str) + Send + Sync)) -> Result<(String, Vec<Call>, Rate), String> {
    body["stream"] = json!(true);
    let (res, rate) = send_stream(url, headers, &body, label, timeout).await?;
    let mut filter = Filter { raw: String::new(), sent: 0, suppress: false, cb };
    // chamadas de ferramenta chegam em fragmentos por índice
    let mut parts: Vec<(String, String, String)> = Vec::new();
    for_each_line(res, label, timeout, |line| {
        let Some(data) = line.strip_prefix("data:") else { return Ok(()) };
        let data = data.trim();
        if data == "[DONE]" {
            return Ok(());
        }
        let Ok(v) = serde_json::from_str::<Value>(data) else { return Ok(()) };
        if let Some(m) = v["error"]["message"].as_str().or_else(|| v["error"].as_str()) {
            return Err(format!("HTTP 500 — {} respondeu: {}", label, m));
        }
        let delta = &v["choices"][0]["delta"];
        if let Some(t) = delta["content"].as_str() {
            filter.push(t);
        }
        for c in delta["tool_calls"].as_array().cloned().unwrap_or_default() {
            let i = c["index"].as_u64().unwrap_or(0) as usize;
            while parts.len() <= i {
                parts.push(Default::default());
            }
            if let Some(id) = c["id"].as_str() {
                parts[i].0 = id.to_string();
            }
            if let Some(n) = c["function"]["name"].as_str() {
                parts[i].1.push_str(n);
            }
            if let Some(a) = c["function"]["arguments"].as_str() {
                parts[i].2.push_str(a);
            }
        }
        Ok(())
    })
    .await?;
    let calls = parts
        .into_iter()
        .filter(|(_, n, _)| !n.is_empty())
        .map(|(id, name, args)| Call {
            id: if id.is_empty() { format!("call-{}", crate::agent::COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)) } else { id },
            name,
            args: serde_json::from_str(&args).unwrap_or(Value::Null),
        })
        .collect();
    Ok((filter.raw, calls, rate))
}

async fn stream_ollama(url: &str, mut body: Value, label: &str, timeout: u64, cb: &(dyn Fn(&str) + Send + Sync)) -> Result<(String, Vec<Call>, Rate), String> {
    body["stream"] = json!(true);
    let (res, rate) = send_stream(url, &[], &body, label, timeout).await?;
    let mut filter = Filter { raw: String::new(), sent: 0, suppress: false, cb };
    let mut calls = Vec::new();
    for_each_line(res, label, timeout, |line| {
        let Ok(v) = serde_json::from_str::<Value>(line) else { return Ok(()) };
        if let Some(e) = v["error"].as_str() {
            return Err(format!("HTTP 500 — {} respondeu: {}", label, e));
        }
        if let Some(t) = v["message"]["content"].as_str() {
            filter.push(t);
        }
        for c in v["message"]["tool_calls"].as_array().cloned().unwrap_or_default() {
            calls.push(Call {
                id: format!("ol-{}", crate::agent::COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)),
                name: c["function"]["name"].as_str().unwrap_or("").to_string(),
                args: match &c["function"]["arguments"] {
                    Value::String(s) => serde_json::from_str(s).unwrap_or(Value::Null),
                    other => other.clone(),
                },
            });
        }
        Ok(())
    })
    .await?;
    Ok((filter.raw, calls, rate))
}
