// Memória do Lumo, em disco (<config do app>/memory.json):
//   • fatos duradouros que o modelo decide guardar ("prefere respostas curtas");
//   • a conversa em curso, que sobrevive a reinícios;
//   • um resumo rolante: quando a conversa fica longa, as falas antigas viram resumo,
//     então o contexto nunca estoura e o Lumo não "esquece" o que já foi combinado.
use super::llm::Msg;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

const MAX_FACTS: usize = 200;
const COMPACT_AT_CHARS: usize = 18_000;
const KEEP_TURNS: usize = 8;

#[derive(Serialize, Deserialize, Clone)]
pub struct Fact {
    pub id: u32,
    pub text: String,
    pub ts: u64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Turn {
    pub role: String, // "user" | "assistant"
    pub text: String,
}

#[derive(Serialize, Deserialize, Default)]
struct Store {
    facts: Vec<Fact>,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    turns: Vec<Turn>,
    #[serde(default)]
    next_id: u32,
}

static STORE: Mutex<Option<Store>> = Mutex::new(None);

fn path() -> Option<std::path::PathBuf> {
    super::dir().map(|d| d.join("memory.json"))
}

fn with<T>(f: impl FnOnce(&mut Store) -> T) -> T {
    let mut g = STORE.lock().unwrap_or_else(|e| e.into_inner());
    let st = g.get_or_insert_with(|| path().and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default());
    let out = f(st);
    if let Some(p) = path() {
        if let Some(d) = p.parent() {
            std::fs::create_dir_all(d).ok();
        }
        if let Ok(b) = serde_json::to_vec(st) {
            std::fs::write(p, b).ok();
        }
    }
    out
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub fn add_fact(text: &str) -> String {
    let text = text.trim();
    if text.is_empty() {
        return "Fato vazio.".into();
    }
    with(|s| {
        let low = text.to_lowercase();
        if s.facts.iter().any(|f| f.text.to_lowercase() == low) {
            return "Já estava na memória.".into();
        }
        s.next_id += 1;
        let id = s.next_id;
        s.facts.push(Fact { id, text: text.chars().take(500).collect(), ts: now() });
        if s.facts.len() > MAX_FACTS {
            s.facts.remove(0);
        }
        format!("Guardado (id {}).", id)
    })
}

pub fn forget(id: u32) -> String {
    with(|s| {
        let before = s.facts.len();
        s.facts.retain(|f| f.id != id);
        if s.facts.len() < before { "Esquecido.".into() } else { "Não achei esse id.".into() }
    })
}

pub fn facts() -> Vec<Fact> {
    with(|s| s.facts.clone())
}

pub fn recall(query: &str) -> String {
    let words: Vec<String> = query.to_lowercase().split_whitespace().filter(|w| w.len() > 2).map(str::to_string).collect();
    with(|s| {
        let mut hits: Vec<(usize, &Fact)> = s
            .facts
            .iter()
            .map(|f| (words.iter().filter(|w| f.text.to_lowercase().contains(w.as_str())).count(), f))
            .filter(|(n, _)| *n > 0 || words.is_empty())
            .collect();
        hits.sort_by(|a, b| b.0.cmp(&a.0));
        if hits.is_empty() {
            return "Nada na memória sobre isso.".into();
        }
        hits.iter().take(10).map(|(_, f)| format!("[{}] {}", f.id, f.text)).collect::<Vec<_>>().join("\n")
    })
}

/// Bloco do prompt do sistema: o que o Lumo já sabe sobre o usuário
pub fn prompt_block() -> String {
    with(|s| {
        let mut out = String::new();
        if !s.facts.is_empty() {
            out.push_str("\nMEMÓRIA (fatos que você guardou; use quando ajudar, sem repetir ao usuário):\n");
            let mut used = 0;
            for f in s.facts.iter().rev() {
                if used + f.text.len() > 3500 {
                    break;
                }
                used += f.text.len();
                out.push_str(&format!("- [{}] {}\n", f.id, f.text));
            }
        }
        if !s.summary.trim().is_empty() {
            out.push_str(&format!("\nRESUMO DA CONVERSA ATÉ AQUI (falas antigas condensadas):\n{}\n", s.summary.trim()));
        }
        out
    })
}

/// A conversa em curso, como o modelo a vê (sempre começa por uma fala do usuário)
pub fn history() -> Vec<Msg> {
    with(|s| {
        let mut out: Vec<Msg> = Vec::new();
        for t in &s.turns {
            match (t.role.as_str(), out.last_mut()) {
                // fala anterior que ficou sem resposta (falha): vale só a mais recente —
                // juntar as duas fazia o modelo responder ao pedido velho
                ("user", Some(Msg::User(prev))) => *prev = t.text.clone(),
                ("user", _) => out.push(Msg::User(t.text.clone())),
                (_, Some(Msg::Assistant { text, .. })) => {
                    text.push_str("\n\n");
                    text.push_str(&t.text)
                }
                (_, _) => out.push(Msg::Assistant { text: t.text.clone(), calls: vec![] }),
            }
        }
        while matches!(out.first(), Some(Msg::Assistant { .. })) {
            out.remove(0);
        }
        out
    })
}

pub fn push_turn(role: &str, text: &str) {
    if text.trim().is_empty() {
        return;
    }
    with(|s| s.turns.push(Turn { role: role.into(), text: text.into() }));
}

/// O pedido falhou sem nada feito: tira a fala do usuário da conversa
pub fn drop_last_user(text: &str) {
    with(|s| {
        if s.turns.last().is_some_and(|t| t.role == "user" && t.text == text) {
            s.turns.pop();
        }
    });
}

/// Nova conversa: apaga a conversa e o resumo, mantém os fatos
pub fn reset_conversation() {
    with(|s| {
        s.turns.clear();
        s.summary.clear();
    });
}

/// Se a conversa ficou longa: devolve as falas antigas para resumir
pub fn take_for_compaction() -> Option<(String, Vec<Turn>)> {
    with(|s| {
        let chars: usize = s.turns.iter().map(|t| t.text.len()).sum();
        if chars < COMPACT_AT_CHARS || s.turns.len() <= KEEP_TURNS + 2 {
            return None;
        }
        let split = s.turns.len() - KEEP_TURNS;
        Some((s.summary.clone(), s.turns[..split].to_vec()))
    })
}

/// Aplica o resumo e descarta as falas que ele substituiu
pub fn apply_compaction(summary: String, consumed: usize) {
    with(|s| {
        s.summary = summary;
        let n = consumed.min(s.turns.len());
        s.turns.drain(..n);
    });
}

/// Sem modelo para resumir: guarda só um resumo mecânico (início de cada fala)
pub fn fallback_summary(old: &str, turns: &[Turn]) -> String {
    let mut s = old.to_string();
    for t in turns {
        let line: String = t.text.chars().take(160).collect::<String>().replace('\n', " ");
        s.push_str(&format!("\n- {}: {}", if t.role == "user" { "usuário" } else { "lumo" }, line));
    }
    s.chars().rev().take(6000).collect::<Vec<_>>().into_iter().rev().collect()
}
