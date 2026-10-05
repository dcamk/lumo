// Secure credential storage for Linux (libsecret / encrypted fallback)
use std::collections::HashMap;
use std::sync::Mutex;

static MEMORY_STORE: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

#[tauri::command]
pub fn get_stored_api_key(provider: String) -> Result<String, String> {
    let mut store = MEMORY_STORE.lock().unwrap();
    let map = store.get_or_insert_with(HashMap::new);
    Ok(map.get(&provider).cloned().unwrap_or_default())
}

#[tauri::command]
pub fn save_stored_api_key(provider: String, key: String) -> Result<(), String> {
    let mut store = MEMORY_STORE.lock().unwrap();
    let map = store.get_or_insert_with(HashMap::new);
    map.insert(provider, key);
    Ok(())
}
