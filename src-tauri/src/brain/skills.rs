// Skills: pastas com um SKILL.md (formato do Claude Code / Agent Skills) em
// <config do app>/skills/. O prompt só carrega nome + descrição; o conteúdo completo
// vem quando o modelo chama `use_skill` (carregamento sob demanda, não gasta contexto).
// Instalação: pasta local, URL de um SKILL.md ou repositório do GitHub (git clone raso).
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone)]
pub struct Skill {
    pub name: String,
    pub description: String,
}

fn root() -> Option<PathBuf> {
    super::dir().map(|d| d.join("skills"))
}

fn frontmatter(text: &str) -> (String, String) {
    let mut name = String::new();
    let mut desc = String::new();
    if let Some(rest) = text.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            let mut lines = rest[..end].lines().peekable();
            while let Some(l) = lines.next() {
                if let Some(v) = l.strip_prefix("name:") {
                    name = v.trim().trim_matches(|c| c == '"' || c == '\'').to_string();
                } else if let Some(v) = l.strip_prefix("description:") {
                    let mut d = v.trim().to_string();
                    // descrição em várias linhas (> ou |)
                    if d == ">" || d == "|" || d.is_empty() {
                        d.clear();
                        while let Some(n) = lines.peek() {
                            if n.starts_with(' ') || n.starts_with('\t') {
                                d.push_str(n.trim());
                                d.push(' ');
                                lines.next();
                            } else {
                                break;
                            }
                        }
                    }
                    desc = d.trim().trim_matches(|c| c == '"' || c == '\'').to_string();
                }
            }
        }
    }
    (name, desc)
}

fn safe_name(s: &str) -> String {
    let n: String = s.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' }).collect();
    n.trim_matches('-').to_lowercase().chars().take(48).collect()
}

pub fn list() -> Vec<Skill> {
    let Some(root) = root() else { return vec![] };
    let mut out: Vec<Skill> = std::fs::read_dir(root)
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| {
                    let text = std::fs::read_to_string(e.path().join("SKILL.md")).ok()?;
                    let (_, desc) = frontmatter(&text);
                    Some(Skill { name: e.file_name().to_string_lossy().into_owned(), description: desc })
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

pub fn prompt_block() -> String {
    let skills = list();
    if skills.is_empty() {
        return String::new();
    }
    let mut s = String::from("\nSKILLS INSTALADAS (chame use_skill com o nome para carregar as instruções completas quando a tarefa combinar):\n");
    for k in skills.iter().take(60) {
        let d: String = k.description.chars().take(220).collect();
        s.push_str(&format!("- {}: {}\n", k.name, d));
    }
    s
}

pub fn read(name: &str) -> String {
    let Some(dir) = root().map(|r| r.join(safe_name(name))) else { return "Skills indisponíveis.".into() };
    match std::fs::read_to_string(dir.join("SKILL.md")) {
        Ok(t) => {
            let mut body: String = t.chars().take(30_000).collect();
            let files: Vec<String> = std::fs::read_dir(&dir)
                .map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n != "SKILL.md").collect())
                .unwrap_or_default();
            if !files.is_empty() {
                body.push_str(&format!("\n\n[Arquivos da skill em {}: {}]", dir.display(), files.join(", ")));
            }
            body
        }
        Err(_) => format!("Skill '{}' não encontrada.", name),
    }
}

pub fn remove(name: &str) -> Result<(), String> {
    let dir = root().ok_or("pasta indisponível")?.join(safe_name(name));
    if dir.exists() {
        std::fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn copy_dir(from: &Path, to: &Path, depth: u32) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)? {
        let e = e?;
        let ty = e.file_type()?;
        let name = e.file_name();
        if name == ".git" || ty.is_symlink() {
            continue;
        }
        if ty.is_dir() && depth < 6 {
            copy_dir(&e.path(), &to.join(&name), depth + 1)?;
        } else if ty.is_file() {
            std::fs::copy(e.path(), to.join(&name))?;
        }
    }
    Ok(())
}

/// Pastas com SKILL.md dentro de `dir` (ela mesma ou subpastas até 3 níveis)
fn find_skills(dir: &Path, depth: u32, out: &mut Vec<PathBuf>) {
    if dir.join("SKILL.md").is_file() {
        out.push(dir.to_path_buf());
        return;
    }
    if depth >= 3 {
        return;
    }
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) && e.file_name() != ".git" && e.file_name() != "node_modules" {
                find_skills(&e.path(), depth + 1, out);
            }
        }
    }
}

fn install_dir(src: &Path) -> Result<Vec<String>, String> {
    let root = root().ok_or("pasta de configuração indisponível")?;
    let mut found = Vec::new();
    find_skills(src, 0, &mut found);
    if found.is_empty() {
        return Err("Não achei nenhum SKILL.md nessa origem.".into());
    }
    let mut names = Vec::new();
    for dir in found {
        let text = std::fs::read_to_string(dir.join("SKILL.md")).map_err(|e| e.to_string())?;
        let (fm_name, _) = frontmatter(&text);
        let base = if fm_name.is_empty() { dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default() } else { fm_name };
        let name = safe_name(&base);
        if name.is_empty() {
            continue;
        }
        let dest = root.join(&name);
        std::fs::remove_dir_all(&dest).ok();
        copy_dir(&dir, &dest, 0).map_err(|e| e.to_string())?;
        names.push(name);
    }
    Ok(names)
}

/// "owner/repo[/subpasta]" ou URL do GitHub (com /tree/ramo/subpasta) → (url do repositório, ramo, subpasta)
fn parse_github(src: &str) -> Option<(String, Option<String>, String)> {
    let s = src.trim().trim_end_matches('/').trim_end_matches(".git");
    let path = s.strip_prefix("https://github.com/").or_else(|| s.strip_prefix("github.com/")).or_else(|| {
        let looks = !s.contains("://") && !s.starts_with('/') && !s.starts_with('~') && !s.starts_with('.') && s.matches('/').count() >= 1;
        looks.then_some(s)
    })?;
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() < 2 {
        return None;
    }
    let repo = format!("https://github.com/{}/{}.git", parts[0], parts[1]);
    if parts.len() >= 4 && parts[2] == "tree" {
        Some((repo, Some(parts[3].to_string()), parts[4..].join("/")))
    } else {
        Some((repo, None, parts[2..].join("/")))
    }
}

pub async fn install(src: &str) -> Result<Vec<String>, String> {
    let src = src.trim();
    let expanded = crate::agent::expand_home(src);
    let local = Path::new(&expanded);
    if local.exists() {
        if local.is_file() {
            let tmp = std::env::temp_dir().join(format!("lumo-skill-{}", std::process::id()));
            std::fs::remove_dir_all(&tmp).ok();
            std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
            std::fs::copy(local, tmp.join("SKILL.md")).map_err(|e| e.to_string())?;
            let r = install_dir(&tmp);
            std::fs::remove_dir_all(&tmp).ok();
            return r;
        }
        return install_dir(local);
    }
    if src.starts_with("http") && !src.contains("github.com/") || src.contains("raw.githubusercontent.com") || (src.starts_with("http") && src.ends_with(".md")) {
        let text = reqwest::get(src).await.map_err(|e| e.to_string())?.text().await.map_err(|e| e.to_string())?;
        let tmp = std::env::temp_dir().join(format!("lumo-skill-{}", std::process::id()));
        std::fs::remove_dir_all(&tmp).ok();
        std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
        std::fs::write(tmp.join("SKILL.md"), text).map_err(|e| e.to_string())?;
        let r = install_dir(&tmp);
        std::fs::remove_dir_all(&tmp).ok();
        return r;
    }
    let (repo, branch, sub) = parse_github(src).ok_or("Origem não reconhecida: use uma pasta, a URL de um SKILL.md ou 'dono/repositório'.")?;
    let tmp = std::env::temp_dir().join(format!("lumo-skill-git-{}", std::process::id()));
    std::fs::remove_dir_all(&tmp).ok();
    let mut cmd = tokio::process::Command::new("git");
    cmd.args(["clone", "--depth", "1"]);
    if let Some(b) = &branch {
        cmd.args(["--branch", b]);
    }
    let out = cmd.arg(&repo).arg(&tmp).env("GIT_TERMINAL_PROMPT", "0").output().await.map_err(|e| format!("git indisponível: {}", e))?;
    if !out.status.success() {
        return Err(format!("git clone falhou: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    let r = install_dir(&tmp.join(&sub));
    std::fs::remove_dir_all(&tmp).ok();
    r
}
