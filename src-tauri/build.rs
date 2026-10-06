fn main() {
    // Login Google "só escolher a conta": se existir src-tauri/google-client.json (o JSON
    // baixado do Google Cloud, cliente "App para computador"), o ID entra no binário.
    println!("cargo:rerun-if-changed=google-client.json");
    if let Ok(text) = std::fs::read_to_string("google-client.json") {
        let field = |name: &str| -> Option<String> {
            let i = text.find(&format!("\"{}\"", name))?;
            let rest = &text[i + name.len() + 2..];
            let rest = rest[rest.find(':')? + 1..].trim_start();
            let rest = rest.strip_prefix('"')?;
            Some(rest[..rest.find('"')?].to_string())
        };
        if let Some(id) = field("client_id") {
            println!("cargo:rustc-env=LUMO_GOOGLE_CLIENT_ID={}", id);
        }
        if let Some(secret) = field("client_secret") {
            println!("cargo:rustc-env=LUMO_GOOGLE_CLIENT_SECRET={}", secret);
        }
    }
    tauri_build::build()
}
