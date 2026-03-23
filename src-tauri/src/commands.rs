use crate::state::{GlobalState, Task, Sheet};
use chrono::Timelike;
use crate::scheduler::{self, SchedulerOutput, TaskInput, SchedulerParams};
use crate::energy;
use crate::nb;

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

#[tauri::command]
pub async fn compute_schedule(state: tauri::State<'_, GlobalState>) -> Result<SchedulerOutput, String> {
    let pool_guard = state.pool.read().await;
    let pool = pool_guard.as_ref().ok_or("No database loaded".to_string())?;

    // Fetch active tasks (not completed). Default effort to S (2) if unset.
    let tasks = state.snapshot().await.map_err(|e| e.to_string())?;
    let active: Vec<&Task> = tasks.iter()
        .filter(|t| t.completed_at.is_none())
        .collect();

    // Load models
    let dirichlet = energy::load_dirichlet(pool).await.map_err(|e| e.to_string())?;
    let duration_model = nb::load_duration_model(pool).await.map_err(|e| e.to_string())?;

    // Extract text from content JSON for NB tag prediction
    let text_re = regex::Regex::new(r#""text"\s*:\s*"([^"]+)""#).unwrap();

    // Load NB tag model for untagged task prediction
    let (word_tag, tag_priors) = nb::load_tag_model(pool).await.map_err(|e| e.to_string())?;

    // Compute debiased work requirements, using predicted tags for untagged tasks
    let task_params: Vec<(String, String, i64)> = active.iter()
        .map(|t| {
            let mut tag = extract_first_tag(&t.tags);
            if tag == "__untagged__" && !tag_priors.is_empty() {
                // Predict tag from task text
                let text: String = text_re.captures_iter(&t.content)
                    .filter_map(|c| c.get(1).map(|m| m.as_str().to_string()))
                    .collect::<Vec<_>>()
                    .join(" ");
                if !text.is_empty() {
                    let posterior = nb::predict_tag(&text, &word_tag, &tag_priors);
                    if let Some((best_tag, prob)) = posterior.iter().max_by(|a, b| a.1.partial_cmp(b.1).unwrap()) {
                        if *prob > 0.3 { // only use prediction if confident
                            tag = best_tag.clone();
                        }
                    }
                }
            }
            (t.id.clone(), tag, t.effort)
        })
        .collect();
    let debiased = nb::compute_debiased_w(&task_params, &duration_model);

    // Current day-of-week (1=Mon, 7=Sun) and within-day chunk position
    let now = chrono::Local::now();
    let start_dow = now.format("%u").to_string().parse::<usize>().unwrap_or(1);
    let start_h = now.hour() as usize / 4; // 0–5 within-day chunk position

    // Build a map from task_params for predicted tags
    let predicted_tags: std::collections::HashMap<String, String> = task_params.iter()
        .map(|(id, tag, _)| (id.clone(), tag.clone()))
        .collect();

    // Map tasks to scheduler input
    let scheduler_tasks: Vec<TaskInput> = active.iter().map(|t| {
        let tag = predicted_tags.get(&t.id).cloned().unwrap_or_else(|| "__untagged__".to_string());
        let t_s = date_to_chunk(&t.start_date, 0);
        // Use effective_due (earliest deadline in dependency chain) instead of own due_date
        let t_f = date_to_chunk(&t.effective_due, scheduler::TOTAL_CHUNKS - 1);

        // Extract task name from content
        let name = text_re.captures(&t.content)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string())
            .unwrap_or_else(|| t.id[..8.min(t.id.len())].to_string());

        // If locked, fix to the scheduled chunk
        let (t_s, t_f) = if t.locked {
            if let Some(ref sched) = t.schedule {
                let c = date_to_chunk(&Some(sched.clone()), 0);
                (c, c)
            } else {
                (t_s, t_f)
            }
        } else {
            (t_s, t_f)
        };

        TaskInput {
            id: t.id.clone(),
            w: scheduler::effort_to_slots(t.effort),
            t_s,
            t_f,
            tag,
            parent_id: t.parent_id.clone(),
            name,
        }
    }).collect();

    let params = SchedulerParams::default();
    let output = scheduler::solve(&scheduler_tasks, &dirichlet, &debiased, &params, start_dow, start_h);

    Ok(output)
}

#[tauri::command]
pub async fn accept_task_schedule(
    id: String,
    schedule: String,
    state: tauri::State<'_, GlobalState>,
) -> Result<Vec<Task>, String> {
    let pool_guard = state.pool.read().await;
    let pool = pool_guard.as_ref().ok_or("No database loaded".to_string())?;

    sqlx::query("UPDATE tasks SET schedule = ?, locked = 1, updated_at = datetime('now') WHERE id = ?")
        .bind(&schedule)
        .bind(&id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

    // Return refreshed snapshot
    state.snapshot().await.map_err(|e| e.to_string())
}

/// Extracts the first tag from a JSON array string like `["tag1", "tag2"]`.
/// Returns "__untagged__" if no tags.
fn extract_first_tag(tags_json: &str) -> String {
    if let Ok(tags) = serde_json::from_str::<Vec<String>>(tags_json) {
        tags.into_iter().next().unwrap_or_else(|| "__untagged__".to_string())
    } else {
        "__untagged__".to_string()
    }
}

/// Converts an ISO date string to a chunk index relative to now.
/// Returns `default` if the date is None or in the past.
fn date_to_chunk(date: &Option<String>, default: usize) -> usize {
    match date {
        Some(d) => {
            let now = chrono::Local::now();
            if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(d) {
                let diff = dt.signed_duration_since(now);
                let hours = diff.num_hours().max(0) as usize;
                let chunk = hours / 4;
                chunk.min(scheduler::TOTAL_CHUNKS - 1)
            } else if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(d, "%Y-%m-%d %H:%M:%S") {
                let local = chrono::Local::now().naive_local();
                let diff = dt.signed_duration_since(local);
                let hours = diff.num_hours().max(0) as usize;
                let chunk = hours / 4;
                chunk.min(scheduler::TOTAL_CHUNKS - 1)
            } else {
                default
            }
        }
        None => default,
    }
}
