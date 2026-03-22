use crate::state::{GlobalState, Task, Sheet};

#[tauri::command]
pub async fn bootstrap(path: String, state: tauri::State<'_, GlobalState>) -> Result<bool, String> {
    state.load(&path).await.map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub async fn load(path: String, state: tauri::State<'_, GlobalState>) -> Result<bool, String> {
    match state.load(&path).await {
        Ok(_) => Ok(true),
        Err(_) => Ok(false),
    }
}

#[tauri::command]
pub async fn snapshot(state: tauri::State<'_, GlobalState>) -> Result<Vec<Task>, String> {
    state.snapshot().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_task(content: String, position: i64, state: tauri::State<'_, GlobalState>) -> Result<Task, String> {
    state.create_task(&content, position).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn upsert(task: Task, state: tauri::State<'_, GlobalState>) -> Result<Vec<Task>, String> {
    state.upsert(&task).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remove(id: String, state: tauri::State<'_, GlobalState>) -> Result<(), String> {
    state.remove(&id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_parent(id: String, parent_id: Option<String>, state: tauri::State<'_, GlobalState>) -> Result<(), String> {
    state.set_parent(&id, parent_id.as_deref()).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_sheets(state: tauri::State<'_, GlobalState>) -> Result<Vec<Sheet>, String> {
    state.list_sheets().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn upsert_sheet(id: i64, query: String, state: tauri::State<'_, GlobalState>) -> Result<Sheet, String> {
    state.upsert_sheet(id, &query).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn add_sheet(state: tauri::State<'_, GlobalState>) -> Result<Sheet, String> {
    state.add_sheet().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remove_sheet(id: i64, state: tauri::State<'_, GlobalState>) -> Result<(), String> {
    state.remove_sheet(id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn search(query: String, state: tauri::State<'_, GlobalState>) -> Result<Vec<Task>, String> {
    state.search(&query).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_tags(state: tauri::State<'_, GlobalState>) -> Result<Vec<String>, String> {
    state.list_tags().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn reorder(ids: Vec<String>, state: tauri::State<'_, GlobalState>) -> Result<(), String> {
    state.reorder(&ids).await.map_err(|e| e.to_string())
}
