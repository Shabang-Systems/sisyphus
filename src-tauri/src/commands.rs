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

    // Fetch active tasks (not completed, not deferred, not empty)
    let tasks = state.snapshot().await.map_err(|e| e.to_string())?;
    let text_check = regex::Regex::new(r#""text"\s*:\s*"[^"]+""#).unwrap();
    let active: Vec<&Task> = tasks.iter()
        .filter(|t| {
            t.completed_at.is_none()
            && !t.is_deferred
            && text_check.is_match(&t.content) // has actual text content
        })
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

    // Separate locked tasks (fixed schedule) from free tasks (to be solved)
    let mut scheduler_tasks: Vec<TaskInput> = Vec::new();
    for t in &active {
        // Skip locked tasks — they don't enter the solver
        if t.locked && t.schedule.is_some() { continue; }

        let tag = predicted_tags.get(&t.id).cloned().unwrap_or_else(|| "__untagged__".to_string());
        let t_s = date_to_chunk_start(&t.start_date);
        let t_f = date_to_chunk_end(&t.effective_due);

        let name = text_re.captures(&t.content)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string())
            .unwrap_or_else(|| t.id[..8.min(t.id.len())].to_string());

        scheduler_tasks.push(TaskInput::new(
            t.id.clone(),
            scheduler::effort_to_slots(t.effort),
            t_s, t_f, tag,
            t.parent_id.clone(),
            name,
            start_h,
        ));
    }

    // Compute capacity consumed by completed and locked tasks
    let mut capacity_used = vec![0.0f64; scheduler::TOTAL_CHUNKS];
    for t in &tasks {
        if t.locked && t.completed_at.is_none() {
            if let Some(ref sched) = t.schedule {
                let chunk = date_to_chunk(&Some(sched.clone()), 0);
                if chunk < scheduler::TOTAL_CHUNKS {
                    capacity_used[chunk] += scheduler::effort_to_slots(t.effort);
                }
            }
            continue;
        }
        if let Some(ref done) = t.completed_at {
            let chunk = date_to_chunk(&Some(done.clone()), 0);
            if chunk < scheduler::TOTAL_CHUNKS {
                capacity_used[chunk] += scheduler::effort_to_slots(t.effort);
            }
        }
    }

    let params = SchedulerParams::default();
    let output = scheduler::solve(&scheduler_tasks, &dirichlet, &debiased, &params, start_dow, start_h, &capacity_used);

    // Write schedule dates to DB — use the earliest chunk per task
    let mut earliest: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for alloc in &output.allocations {
        let day_offset = alloc.day as i64;
        let hour = alloc.hour_start as u32;
        let sched_date = {
            let d = chrono::Local::now().date_naive() + chrono::Duration::days(day_offset);
            let dt = d.and_hms_opt(hour, 0, 0).unwrap();
            dt.and_local_timezone(chrono::Local).single()
                .map(|t| t.to_rfc3339())
                .unwrap_or_default()
        };
        for (tid, _slots) in &alloc.tasks {
            earliest.entry(tid.clone())
                .and_modify(|existing| { if sched_date < *existing { *existing = sched_date.clone(); } })
                .or_insert(sched_date.clone());
        }
    }
    for (tid, sched_date) in &earliest {
        let _ = sqlx::query(
            "UPDATE tasks SET schedule = ?, updated_at = datetime('now') WHERE id = ? AND (locked = 0 OR locked IS NULL)"
        )
        .bind(sched_date)
        .bind(tid)
        .execute(pool)
        .await;
    }

    // Clear schedule for parked (unallocated, non-locked) tasks
    for tid in &output.parked {
        let _ = sqlx::query(
            "UPDATE tasks SET schedule = NULL, updated_at = datetime('now') WHERE id = ? AND (locked = 0 OR locked IS NULL)"
        )
        .bind(tid)
        .execute(pool)
        .await;
    }

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

/// Parses a date string into hours-from-now. Returns None if unparseable or absent.
fn date_to_hours_from_now(date: &Option<String>) -> Option<i64> {
    date.as_ref().and_then(|d| {
        let now = chrono::Local::now();
        if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(d) {
            Some(dt.signed_duration_since(now).num_hours())
        } else if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(d, "%Y-%m-%d %H:%M:%S") {
            Some(dt.signed_duration_since(now.naive_local()).num_hours())
        } else {
            None
        }
    })
}

/// start_date → chunk. Absent or past → 0 (eligible now). Future → that chunk.
fn date_to_chunk_start(date: &Option<String>) -> usize {
    match date_to_hours_from_now(date) {
        Some(h) if h > 0 => (h as usize / 4).min(scheduler::TOTAL_CHUNKS - 1),
        _ => 0,
    }
}

/// due_date → chunk. Absent → TOTAL_CHUNKS-1 (full horizon).
/// Past (overdue) → 0 (deadline already passed, maximum urgency).
/// Future → that chunk.
fn date_to_chunk_end(date: &Option<String>) -> usize {
    match date_to_hours_from_now(date) {
        Some(h) if h > 0 => (h as usize / 4).min(scheduler::TOTAL_CHUNKS - 1),
        Some(_) => 0, // overdue: deadline passed, treat as maximally urgent
        None => scheduler::TOTAL_CHUNKS - 1,
    }
}

/// Converts an ISO date string to a scheduler chunk index, accounting for start_h offset.
/// The scheduler's chunk 0 = the current 4-hour block. Chunks fill the rest of today,
/// then wrap to midnight of the next day.
/// Returns `default` if the date is None or unparseable.
fn date_to_chunk(date: &Option<String>, default: usize) -> usize {
    let d = match date {
        Some(s) => s,
        None => return default,
    };
    let now = chrono::Local::now();
    let target = if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(d) {
        dt.with_timezone(&chrono::Local)
    } else if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(d, "%Y-%m-%d %H:%M:%S") {
        dt.and_local_timezone(chrono::Local).single().unwrap_or(now)
    } else {
        return default;
    };

    // Compute which 4-hour block the target falls in, as a scheduler chunk index
    let now_h = now.hour() as usize / 4; // start_h equivalent
    let remaining_today = scheduler::CHUNKS_PER_DAY - now_h;

    let diff = target.signed_duration_since(now);
    if diff.num_seconds() < 0 {
        // Past date — return 0 (earliest possible chunk)
        return 0;
    }

    // Days and hour-of-day for the target
    let target_day_start = target.date_naive().and_hms_opt(0, 0, 0).unwrap();
    let now_day_start = now.date_naive().and_hms_opt(0, 0, 0).unwrap();
    let day_diff = (target_day_start - now_day_start).num_days() as usize;
    let target_h = target.hour() as usize / 4; // 0-5 position within day

    if day_diff == 0 {
        // Same day: chunk = target_h - now_h (offset within today's remaining chunks)
        if target_h >= now_h {
            (target_h - now_h).min(scheduler::TOTAL_CHUNKS - 1)
        } else {
            0 // earlier today = past
        }
    } else {
        // Future day: remaining_today chunks for rest of today, then full days
        let chunk = remaining_today + (day_diff - 1) * scheduler::CHUNKS_PER_DAY + target_h;
        chunk.min(scheduler::TOTAL_CHUNKS - 1)
    }
}
