// Nuvem pessoal do celular, guardada neste PC (~/Lumo Nuvem).
//
//   • Arquivos: pastas, envio, download, renomear, criar pasta e apagar (vai para a lixeira
//     da própria nuvem, .lixeira, nada some de vez pelo celular).
//   • Banco de dados: coleções de documentos JSON (ex.: notas do celular), cada coleção em
//     .lumo-db/<coleção>.json. Gravação atômica (arquivo temporário + renomear).
//
// Todo caminho vindo do celular é relativo à raiz e passa por `resolve`: nada de "..",
// nomes ocultos ou links simbólicos que saiam da nuvem.

use crate::bridge::{changed, err, mime_of, notify, now, DeviceId};
use axum::body::Body;
use axum::extract::{Path as UrlPath, Query};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tokio::io::AsyncWriteExt;

const TRASH: &str = ".lixeira";
const DB_DIR: &str = ".lumo-db";
const MAX_DOC: usize = 256 * 1024;
const MAX_DOCS: usize = 5000;

/// Raiz da nuvem: ~/Lumo Nuvem
pub fn root() -> PathBuf {
    let home = PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()));
    let dir = home.join("Lumo Nuvem");
    std::fs::create_dir_all(&dir).ok();
    dir
}

/// Um nome de arquivo ou pasta aceitável (sem barras, controle, ".", ".." ou oculto)
pub(crate) fn safe_name(raw: &str) -> Option<String> {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let clean: String = base.chars().filter(|c| !c.is_control()).collect::<String>().trim().to_string();
    let clean: String = clean.chars().take(180).collect();
    if clean.is_empty() || clean == "." || clean == ".." || clean.starts_with('.') {
        return None;
    }
    Some(clean)
}

/// "fotos/2026/a.jpg" → caminho dentro da raiz. "" = a própria raiz.
fn resolve(rel: &str) -> Option<PathBuf> {
    let root = root();
    let mut path = root.clone();
    for part in rel.split(['/', '\\']).filter(|p| !p.is_empty()) {
        let name = safe_name(part)?;
        if name != part.trim() {
            return None;
        }
        path.push(name);
    }
    // Link simbólico apontando para fora da nuvem: recusa
    if let (Ok(real), Ok(real_root)) = (path.canonicalize(), root.canonicalize()) {
        if !real.starts_with(&real_root) {
            return None;
        }
    }
    Some(path)
}

fn relative(path: &Path) -> String {
    path.strip_prefix(root()).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()
}

/// "foto.jpg" → "foto (1).jpg" se já existir
pub(crate) fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (1..10_000).map(|n| dir.join(format!("{} ({}){}", stem, n, ext))).find(|p| !p.exists()).unwrap_or(first)
}

pub(crate) fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{:02X}", b) })
        .collect()
}

pub(crate) fn urldecode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn modified(meta: &std::fs::Metadata) -> u64 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0)
}

/// Espaço usado pela nuvem (para no máximo 50 mil itens para não travar em pastas enormes)
fn usage(dir: &Path) -> u64 {
    let mut total = 0;
    let mut stack = vec![dir.to_path_buf()];
    let mut seen = 0;
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            seen += 1;
            if seen > 50_000 {
                return total;
            }
            let Ok(meta) = e.metadata() else { continue };
            if meta.is_dir() {
                stack.push(e.path());
            } else {
                total += meta.len();
            }
        }
    }
    total
}

// ---- Arquivos ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct PathQuery {
    #[serde(default)]
    path: String,
    #[serde(default)]
    inline: Option<u8>,
}

#[derive(Serialize)]
struct Entry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    modified: u64,
}

pub async fn api_list(Query(q): Query<PathQuery>) -> Response {
    let Some(dir) = resolve(&q.path) else { return err(StatusCode::BAD_REQUEST, "pasta inválida") };
    if !dir.is_dir() {
        return err(StatusCode::NOT_FOUND, "pasta não encontrada");
    }
    let mut entries: Vec<Entry> = std::fs::read_dir(&dir)
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().into_owned();
                    if name.starts_with('.') {
                        return None;
                    }
                    let meta = e.metadata().ok()?;
                    Some(Entry { path: relative(&e.path()), name, is_dir: meta.is_dir(), size: if meta.is_dir() { 0 } else { meta.len() }, modified: modified(&meta) })
                })
                .collect()
        })
        .unwrap_or_default();
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(b.modified.cmp(&a.modified)));
    let stats = crate::linux::system_stats().await;
    let root = root();
    let used = tokio::task::spawn_blocking(move || usage(&root)).await.unwrap_or(0);
    Json(json!({
        "path": relative(&dir),
        "entries": entries,
        "used": used,
        "free": stats.disk_total.saturating_sub(stats.disk_used),
        "total": stats.disk_total,
    }))
    .into_response()
}

pub async fn api_file(Query(q): Query<PathQuery>) -> Response {
    let Some(path) = resolve(&q.path).filter(|p| p.is_file()) else {
        return err(StatusCode::NOT_FOUND, "arquivo não encontrado");
    };
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let file = match tokio::fs::File::open(&path).await {
        Ok(f) => f,
        Err(_) => return err(StatusCode::NOT_FOUND, "arquivo não encontrado"),
    };
    let len = file.metadata().await.map(|m| m.len()).unwrap_or(0);
    let ascii: String = name.chars().map(|c| if (c.is_ascii_graphic() && c != '"') || c == ' ' { c } else { '_' }).collect();
    let kind = if q.inline == Some(1) { "inline" } else { "attachment" };
    let disposition = format!("{}; filename=\"{}\"; filename*=UTF-8''{}", kind, ascii, urlencode(&name));
    Response::builder()
        .header(header::CONTENT_TYPE, mime_of(&name))
        .header(header::CONTENT_LENGTH, len)
        .header(header::CONTENT_DISPOSITION, disposition)
        .header(header::CACHE_CONTROL, "private, max-age=60")
        .body(Body::from_stream(tokio_util::io::ReaderStream::new(file)))
        .unwrap_or_else(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "falha ao enviar"))
}

/// Envio do celular: corpo cru, nome em `x-file-name` (URL-encoded), pasta em ?path=
pub async fn api_upload(Extension(DeviceId(id)): Extension<DeviceId>, Query(q): Query<PathQuery>, headers: HeaderMap, body: Body) -> Response {
    let raw = headers.get("x-file-name").and_then(|v| v.to_str().ok()).map(urldecode).unwrap_or_default();
    let Some(name) = safe_name(&raw) else { return err(StatusCode::BAD_REQUEST, "nome de arquivo inválido") };
    let Some(dir) = resolve(&q.path) else { return err(StatusCode::BAD_REQUEST, "pasta inválida") };
    if let Err(e) = tokio::fs::create_dir_all(&dir).await {
        return err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string());
    }
    // Grava num arquivo oculto e só renomeia no fim: envio interrompido não deixa lixo visível
    let tmp = dir.join(format!(".recebendo-{}-{}", id, now()));
    let mut file = match tokio::fs::File::create(&tmp).await {
        Ok(f) => f,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    };
    let mut stream = body.into_data_stream();
    let mut size: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                tokio::fs::remove_file(&tmp).await.ok();
                return err(StatusCode::BAD_REQUEST, &format!("envio interrompido: {}", e));
            }
        };
        size += chunk.len() as u64;
        if let Err(e) = file.write_all(&chunk).await {
            tokio::fs::remove_file(&tmp).await.ok();
            return err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string());
        }
    }
    file.flush().await.ok();
    drop(file);
    let final_path = unique_path(&dir, &name);
    if let Err(e) = tokio::fs::rename(&tmp, &final_path).await {
        tokio::fs::remove_file(&tmp).await.ok();
        return err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string());
    }
    let saved = final_path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(name);
    notify("Arquivo do celular", &format!("{} salvo na Lumo Nuvem", saved));
    changed();
    Json(json!({ "name": saved, "path": relative(&final_path), "size": size })).into_response()
}

#[derive(Deserialize)]
pub struct MkdirReq {
    path: String,
}

pub async fn api_mkdir(Json(req): Json<MkdirReq>) -> Response {
    match resolve(&req.path) {
        Some(p) if p != root() => match std::fs::create_dir_all(&p) {
            Ok(()) => Json(json!({ "path": relative(&p) })).into_response(),
            Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
        },
        _ => err(StatusCode::BAD_REQUEST, "nome de pasta inválido"),
    }
}

#[derive(Deserialize)]
pub struct RenameReq {
    path: String,
    name: String,
}

pub async fn api_rename(Json(req): Json<RenameReq>) -> Response {
    let Some(from) = resolve(&req.path).filter(|p| *p != root() && p.exists()) else {
        return err(StatusCode::NOT_FOUND, "item não encontrado");
    };
    let Some(name) = safe_name(&req.name) else { return err(StatusCode::BAD_REQUEST, "nome inválido") };
    let to = from.with_file_name(&name);
    if to.exists() {
        return err(StatusCode::CONFLICT, "já existe um item com esse nome");
    }
    match std::fs::rename(&from, &to) {
        Ok(()) => Json(json!({ "path": relative(&to) })).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

#[derive(Deserialize)]
pub struct DeleteReq {
    path: String,
}

/// Apagar = mover para .lixeira da nuvem (o usuário recupera no PC)
pub async fn api_delete(Json(req): Json<DeleteReq>) -> Response {
    let Some(from) = resolve(&req.path).filter(|p| *p != root() && p.exists()) else {
        return err(StatusCode::NOT_FOUND, "item não encontrado");
    };
    let trash = root().join(TRASH);
    std::fs::create_dir_all(&trash).ok();
    let name = from.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let to = unique_path(&trash, &name);
    match std::fs::rename(&from, &to) {
        Ok(()) => {
            changed();
            Json(json!({ "ok": true })).into_response()
        }
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

// ---- Banco de dados -------------------------------------------------------------------------

/// Um mutex para todas as coleções: gravações são raras e pequenas
static DB_LOCK: Mutex<()> = Mutex::new(());

fn collection_file(name: &str) -> Option<PathBuf> {
    let ok = !name.is_empty() && name.len() <= 40 && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_');
    ok.then(|| root().join(DB_DIR).join(format!("{}.json", name)))
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn read_collection(path: &Path) -> Map<String, Value> {
    std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str::<Map<String, Value>>(&t).ok()).unwrap_or_default()
}

fn write_collection(path: &Path, docs: &Map<String, Value>) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(docs)?)?;
    std::fs::rename(&tmp, path)
}

/// Documentos da coleção: [{id, data, updated}], mais recentes primeiro.
/// `?since=<segundos>` devolve só os alterados depois disso (sincronização).
#[derive(Deserialize)]
pub struct SinceQuery {
    #[serde(default)]
    since: u64,
}

pub async fn api_db_list(UrlPath(collection): UrlPath<String>, Query(q): Query<SinceQuery>) -> Response {
    let Some(file) = collection_file(&collection) else { return err(StatusCode::BAD_REQUEST, "coleção inválida") };
    let docs = {
        let _g = DB_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        read_collection(&file)
    };
    let mut list: Vec<Value> = docs
        .into_iter()
        .filter(|(_, v)| v["updated"].as_u64().unwrap_or(0) >= q.since)
        .map(|(id, v)| json!({ "id": id, "data": v["data"], "updated": v["updated"] }))
        .collect();
    list.sort_by(|a, b| b["updated"].as_u64().cmp(&a["updated"].as_u64()));
    Json(json!({ "docs": list, "now": now() })).into_response()
}

#[derive(Deserialize)]
pub struct PutReq {
    data: Value,
}

pub async fn api_db_put(UrlPath((collection, id)): UrlPath<(String, String)>, Json(req): Json<PutReq>) -> Response {
    let Some(file) = collection_file(&collection) else { return err(StatusCode::BAD_REQUEST, "coleção inválida") };
    if !valid_id(&id) {
        return err(StatusCode::BAD_REQUEST, "id inválido");
    }
    if serde_json::to_vec(&req.data).map(|v| v.len()).unwrap_or(usize::MAX) > MAX_DOC {
        return err(StatusCode::PAYLOAD_TOO_LARGE, "documento grande demais (máx. 256 KB)");
    }
    let _g = DB_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut docs = read_collection(&file);
    if !docs.contains_key(&id) && docs.len() >= MAX_DOCS {
        return err(StatusCode::INSUFFICIENT_STORAGE, "coleção cheia");
    }
    let updated = now();
    docs.insert(id.clone(), json!({ "data": req.data, "updated": updated }));
    match write_collection(&file, &docs) {
        Ok(()) => Json(json!({ "id": id, "updated": updated })).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

pub async fn api_db_delete(UrlPath((collection, id)): UrlPath<(String, String)>) -> Response {
    let Some(file) = collection_file(&collection) else { return err(StatusCode::BAD_REQUEST, "coleção inválida") };
    let _g = DB_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut docs = read_collection(&file);
    if docs.remove(&id).is_some() {
        if let Err(e) = write_collection(&file, &docs) {
            return err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string());
        }
    }
    Json(json!({ "ok": true })).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nomes_seguros() {
        assert_eq!(safe_name("../../etc/passwd").as_deref(), Some("passwd"));
        assert_eq!(safe_name("C:\\fotos\\a.jpg").as_deref(), Some("a.jpg"));
        assert_eq!(safe_name(".bashrc"), None);
        assert_eq!(safe_name(".."), None);
        assert_eq!(safe_name("   "), None);
        assert_eq!(safe_name("Férias 2026.mp4").as_deref(), Some("Férias 2026.mp4"));
    }

    #[test]
    fn caminhos_presos_na_nuvem() {
        assert!(resolve("../fora").is_none());
        assert!(resolve("fotos/../../fora").is_none());
        assert!(resolve(".lixeira").is_none());
        assert!(resolve("fotos/.lumo-db/x").is_none());
        assert!(resolve("fotos/2026").unwrap().ends_with("Lumo Nuvem/fotos/2026"));
        assert!(resolve("").unwrap().ends_with("Lumo Nuvem"));
    }

    #[test]
    fn url_ida_e_volta() {
        let n = "Relatório final (v2).pdf";
        assert_eq!(urldecode(&urlencode(n)), n);
        assert_eq!(urldecode("100%"), "100%");
    }

    #[test]
    fn colecoes_e_ids() {
        assert!(collection_file("notas").is_some());
        assert!(collection_file("../x").is_none());
        assert!(collection_file("Notas").is_none());
        assert!(valid_id("a1-b_2"));
        assert!(!valid_id("../x"));
    }
}
