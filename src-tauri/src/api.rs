// Despachante de IA multi-provedor com streaming: Gemini, Claude, Ollama e qualquer
// API compatível com OpenAI (OpenAI, Groq, OpenRouter, Cerebras, Mistral, NVIDIA NIM,
// Hugging Face, LLM7… — a lista e as URLs ficam em src/lib/providers.ts).
// Roda no Rust para funcionar no binário instalado (sem o servidor Express) e sem
// esbarrar em CORS do WebView. Cada pedaço de texto vai para a interface por um
// `Channel` assim que chega.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::ipc::Channel;

#[derive(Debug, Serialize, Deserialize)]
pub struct ChatTurn {
    pub role: String, // "user" | "assistant"
    pub content: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AIRequest {
    pub provider: String,
    pub messages: Vec<ChatTurn>,
    pub system: Option<String>,
    pub model: Option<String>,
    pub endpoint: Option<String>,
    pub api_key: Option<String>,
}

const DEFAULT_SYSTEM: &str = "Você é o Lumo, assistente de produtividade para Linux. Seja conciso, calmo e responda em português.";

fn require_key(req: &AIRequest, name: &str) -> Result<String, String> {
    req.api_key
        .clone()
        .filter(|k| !k.trim().is_empty())
        .ok_or_else(|| format!("Chave de API do {} não configurada. Abra as Configurações.", name))
}

fn pick_model(req: &AIRequest, default: &str) -> String {
    req.model
        .clone()
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| default.to_string())
}

/// Pedido HTTP pronto para um provedor
struct Prepared {
    url: String,
    headers: Vec<(&'static str, String)>,
    body: Value,
    who: &'static str,
}

fn prepare(req: &AIRequest) -> Result<Prepared, String> {
    let system = req.system.clone().unwrap_or_else(|| DEFAULT_SYSTEM.to_string());
    let turns: Vec<Value> = req
        .messages
        .iter()
        .map(|m| json!({ "role": m.role, "content": m.content }))
        .collect();
    let with_system = || {
        let mut msgs = vec![json!({ "role": "system", "content": system })];
        msgs.extend(turns.clone());
        msgs
    };

    Ok(match req.provider.as_str() {
        "ollama" => {
            let base = req
                .endpoint
                .clone()
                .filter(|e| !e.trim().is_empty())
                .unwrap_or_else(|| "http://localhost:11434".into());
            Prepared {
                url: format!("{}/api/chat", base.trim_end_matches('/')),
                headers: vec![],
                body: json!({ "model": pick_model(req, "llama3"), "messages": with_system(), "stream": true }),
                who: "Ollama",
            }
        }
        // Fallback no servidor: se o modelo recusar por política, a API reexecuta
        // em outro modelo dentro da mesma chamada.
        "claude" => Prepared {
            url: "https://api.anthropic.com/v1/messages".into(),
            headers: vec![
                ("x-api-key", require_key(req, "Claude")?),
                ("anthropic-version", "2023-06-01".into()),
                ("anthropic-beta", "server-side-fallback-2026-07-01".into()),
            ],
            body: json!({
                "model": pick_model(req, "claude-opus-5-5"),
                "max_tokens": 16000,
                "system": system,
                "messages": turns,
                "output_config": { "effort": "low" },
                "fallbacks": "default",
                "stream": true,
            }),
            who: "Claude",
        },
        "gemini" => {
            let contents: Vec<Value> = req
                .messages
                .iter()
                .map(|m| {
                    let role = if m.role == "assistant" { "model" } else { "user" };
                    json!({ "role": role, "parts": [{ "text": m.content }] })
                })
                .collect();
            Prepared {
                url: format!(
                    "https://generativelanguage.googleapis.com/v1beta/models/{}:streamGenerateContent?alt=sse",
                    pick_model(req, "gemini-2.5-flash")
                ),
                headers: vec![("x-goog-api-key", require_key(req, "Gemini")?)],
                body: json!({
                    "systemInstruction": { "parts": [{ "text": system }] },
                    "contents": contents,
                }),
                who: "Gemini",
            }
        }
        // Todo o resto fala o formato da OpenAI: muda só a URL base
        _ => {
            let base = openai_base(req);
            let mut headers = vec![("X-Title", "Lumo".to_string())];
            match req.api_key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
                Some(key) => headers.push(("Authorization", format!("Bearer {}", key))),
                // Alguns provedores (ex.: LLM7) aceitam uso anônimo com limite menor
                None if req.provider == "llm7" => {}
                None => return Err("Chave de API não configurada. Abra Config → IA.".into()),
            }
            Prepared {
                url: format!("{}/chat/completions", base),
                headers,
                body: json!({ "model": pick_model(req, "gpt-4o-mini"), "messages": with_system(), "stream": true }),
                who: "provedor",
            }
        }
    })
}

fn openai_base(req: &AIRequest) -> String {
    req.endpoint
        .clone()
        .filter(|e| !e.trim().is_empty())
        .unwrap_or_else(|| "https://api.openai.com/v1".into())
        .trim()
        .trim_end_matches('/')
        .trim_end_matches("/chat/completions")
        .to_string()
}

/// Modelos disponíveis num provedor compatível com OpenAI (GET {base}/models)
#[tauri::command]
pub async fn list_models(endpoint: String, api_key: Option<String>) -> Result<Vec<String>, String> {
    let req = AIRequest { provider: String::new(), messages: vec![], system: None, model: None, endpoint: Some(endpoint), api_key: api_key.clone() };
    let mut rb = reqwest::Client::new().get(format!("{}/models", openai_base(&req)));
    if let Some(key) = api_key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
        rb = rb.bearer_auth(key);
    }
    let res = rb.send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let body: Value = res.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        let msg = body["error"]["message"].as_str().or_else(|| body["error"].as_str()).unwrap_or("erro desconhecido");
        return Err(format!("{}: {}", status.as_u16(), msg));
    }
    let list = body["data"].as_array().or_else(|| body.as_array()).cloned().unwrap_or_default();
    let mut ids: Vec<String> = list.iter().filter_map(|m| m["id"].as_str().map(str::to_string)).collect();
    ids.sort();
    ids.dedup();
    Ok(ids)
}

/// Extrai o texto de uma linha do stream. `Err` = o provedor sinalizou erro/recusa.
fn parse_line(provider: &str, line: &str) -> Result<Option<String>, String> {
    let line = line.trim();
    // SSE: só interessam as linhas "data:"; o Ollama manda JSON puro por linha
    let payload = match line.strip_prefix("data:") {
        Some(p) => p.trim(),
        None if provider == "ollama" => line,
        None => return Ok(None),
    };
    if payload.is_empty() || payload == "[DONE]" {
        return Ok(None);
    }
    let v: Value = match serde_json::from_str(payload) {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    if let Some(msg) = v["error"]["message"].as_str().or_else(|| v["error"].as_str()) {
        return Err(msg.to_string());
    }
    let text = match provider {
        "ollama" => v["message"]["content"].as_str().map(str::to_string),
        "claude" => {
            if v["delta"]["stop_reason"].as_str() == Some("refusal") {
                return Err("O Claude recusou esta solicitação.".into());
            }
            if v["type"] == "content_block_delta" {
                v["delta"]["text"].as_str().map(str::to_string)
            } else {
                None
            }
        }
        "gemini" => v["candidates"][0]["content"]["parts"].as_array().map(|parts| {
            parts.iter().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join("")
        }),
        _ => v["choices"][0]["delta"]["content"].as_str().map(str::to_string),
    };
    Ok(text.filter(|t| !t.is_empty()))
}

#[tauri::command]
pub async fn dispatch_ai_stream(req: AIRequest, on_chunk: Channel<String>) -> Result<(), String> {
    let p = prepare(&req)?;
    let client = reqwest::Client::new();
    let mut rb = client.post(&p.url).json(&p.body);
    for (k, v) in &p.headers {
        rb = rb.header(*k, v);
    }
    let mut res = rb
        .send()
        .await
        .map_err(|e| format!("Não consegui conectar ao {}: {}", p.who, e))?;

    let status = res.status();
    if !status.is_success() {
        let body: Value = res.json().await.unwrap_or(Value::Null);
        let msg = body["error"]["message"]
            .as_str()
            .or_else(|| body["error"].as_str())
            .unwrap_or("erro desconhecido");
        // O prefixo "HTTP <código>" deixa a interface decidir se tenta outro provedor
        return Err(format!("HTTP {} — {} respondeu: {}", status.as_u16(), p.who, msg));
    }

    // Junta os bytes em linhas completas (um evento pode chegar partido em vários pedaços)
    let mut buf: Vec<u8> = Vec::new();
    let mut got_text = false;
    while let Some(chunk) = res.chunk().await.map_err(|e| e.to_string())? {
        buf.extend_from_slice(&chunk);
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line);
            if let Some(text) = parse_line(&req.provider, &line)? {
                got_text = true;
                on_chunk.send(text).map_err(|e| e.to_string())?;
            }
        }
    }
    if !buf.is_empty() {
        if let Some(text) = parse_line(&req.provider, &String::from_utf8_lossy(&buf))? {
            got_text = true;
            on_chunk.send(text).map_err(|e| e.to_string())?;
        }
    }
    if !got_text {
        on_chunk.send("Sem resposta.".into()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Serialize)]
pub struct LocalModel {
    pub name: String,
    pub size: u64,
    /// Aceita ferramentas (o agente consegue rodar comandos nativamente)
    pub tools: bool,
    /// Só gera embeddings (não serve para conversar)
    pub embedding: bool,
}

/// Modelos instalados no Ollama, com as capacidades (para escolher um substituto
/// quando o modelo local configurado demora demais). Lista vazia = Ollama fora do ar.
#[tauri::command]
pub async fn ollama_models(endpoint: Option<String>) -> Vec<LocalModel> {
    let base = endpoint
        .filter(|e| !e.trim().is_empty())
        .unwrap_or_else(|| "http://localhost:11434".into())
        .trim_end_matches('/')
        .trim_end_matches("/v1")
        .to_string();
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(4)).build().unwrap_or_default();
    let Ok(res) = client.get(format!("{}/api/tags", base)).send().await else { return vec![] };
    let tags: Value = res.json().await.unwrap_or(Value::Null);
    let mut out = Vec::new();
    for m in tags["models"].as_array().cloned().unwrap_or_default() {
        let Some(name) = m["name"].as_str().map(str::to_string) else { continue };
        let caps: Vec<String> = match client.post(format!("{}/api/show", base)).json(&json!({ "model": name })).send().await {
            Ok(r) => r.json::<Value>().await.ok().and_then(|v| v["capabilities"].as_array().cloned()).unwrap_or_default()
                .iter().filter_map(|c| c.as_str().map(str::to_string)).collect(),
            Err(_) => vec![],
        };
        out.push(LocalModel {
            size: m["size"].as_u64().unwrap_or(0),
            tools: caps.iter().any(|c| c == "tools"),
            embedding: caps.iter().any(|c| c == "embedding") && !caps.iter().any(|c| c == "completion"),
            name,
        });
    }
    out
}
