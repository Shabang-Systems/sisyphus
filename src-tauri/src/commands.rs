use crate::state::{GlobalState, Task, Sheet};
use chrono::Timelike;
use chrono::TimeZone;
use tauri::Emitter;
use crate::scheduler::{self, SchedulerOutput, TaskInput, SchedulerParams, ChunkConfig};
use crate::energy;
use crate::nb;
use crate::calendar;

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
pub async fn batch_upsert(tasks: Vec<Task>, state: tauri::State<'_, GlobalState>) -> Result<Vec<Task>, String> {
    state.batch_upsert(&tasks).await.map_err(|e| e.to_string())
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

/// Returns cached calendar busy grid (14×6 = 84 values). Fetches + caches if empty.
#[tauri::command]
pub async fn get_calendar_freebusy(state: tauri::State<'_, GlobalState>) -> Result<Vec<f64>, String> {
    // Return from cache if available
    {
        let cache = state.cal_grid_cache.read().await;
        if let Some(ref grid) = *cache {
            return Ok(grid.clone());
        }
    }

    // Cache miss — fetch, cache, and return
    let grid = fetch_and_cache_cal_grid(state.inner()).await;
    Ok(grid)
}

#[derive(serde::Serialize)]
pub struct CalendarDebugInfo {
    pub urls: Vec<String>,
    pub blocks: Vec<calendar::DebugBusyBlock>,
    pub grid: Vec<f64>,
    pub chunks_per_day: usize,
    pub horizon_days: usize,
    pub hours_per_chunk: usize,
}

/// Fresh-fetch calendar data for debugging: URLs, raw busy blocks with ICS metadata, and the computed grid.
#[tauri::command]
pub async fn get_calendar_debug(state: tauri::State<'_, GlobalState>) -> Result<CalendarDebugInfo, String> {
    let pool_guard = state.pool.read().await;
    let pool = pool_guard.as_ref().ok_or("No database loaded")?;

    let cfg = load_chunk_config(pool).await;

    let cal_urls_json = sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = 'calendars'")
        .fetch_optional(pool).await.map_err(|e| e.to_string())?.unwrap_or_else(|| "[]".to_string());
    let cal_urls: Vec<String> = serde_json::from_str(&cal_urls_json).unwrap_or_default();

    let (busy_blocks, debug_blocks) = if cal_urls.is_empty() {
        (vec![], vec![])
    } else {
        calendar::fetch_busy_blocks_debug(&cal_urls, cfg.horizon_days).await
    };

    let grid = if busy_blocks.is_empty() {
        vec![0.0f64; cfg.horizon_days * cfg.chunks_per_day]
    } else {
        calendar::busy_to_grid(&busy_blocks, &cfg)
    };

    *state.cal_grid_cache.write().await = Some(grid.clone());

    Ok(CalendarDebugInfo {
        urls: cal_urls,
        blocks: debug_blocks,
        grid,
        chunks_per_day: cfg.chunks_per_day,
        horizon_days: cfg.horizon_days,
        hours_per_chunk: cfg.hours_per_chunk(),
    })
}

/// Fetch calendar busy blocks, compute the absolute grid, and store in cache.
async fn fetch_and_cache_cal_grid(state: &GlobalState) -> Vec<f64> {
    let pool_guard = state.pool.read().await;
    let pool = match pool_guard.as_ref() {
        Some(p) => p,
        None => {
            let cfg = ChunkConfig::default();
            let empty = vec![0.0f64; cfg.horizon_days * cfg.chunks_per_day];
            *state.cal_grid_cache.write().await = Some(empty.clone());
            return empty;
        }
    };

    let cfg = load_chunk_config(pool).await;
    let grid_size = cfg.horizon_days * cfg.chunks_per_day;

    let cal_urls_json = sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = 'calendars'")
        .fetch_optional(pool).await.unwrap_or(None).unwrap_or_else(|| "[]".to_string());
    let cal_urls: Vec<String> = serde_json::from_str(&cal_urls_json).unwrap_or_default();

    let grid = if cal_urls.is_empty() {
        vec![0.0f64; grid_size]
    } else {
        let blocks = calendar::fetch_busy_blocks(&cal_urls, cfg.horizon_days).await;
        calendar::busy_to_grid(&blocks, &cfg)
    };

    *state.cal_grid_cache.write().await = Some(grid.clone());
    grid
}

#[tauri::command]
pub async fn compute_schedule(
    global_rebalance: Option<bool>,
    state: tauri::State<'_, GlobalState>,
) -> Result<SchedulerOutput, String> {
    do_compute_schedule(state.inner(), global_rebalance.unwrap_or(false)).await
}

fn parse_local_datetime(s: &str) -> Option<chrono::DateTime<chrono::Local>> {
    use chrono::{Local, NaiveDateTime};

    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        Some(dt.with_timezone(&Local))
    } else if let Ok(dt) = NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S") {
        Local.from_local_datetime(&dt).single()
    } else if let Ok(dt) = NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S") {
        Local.from_local_datetime(&dt).single()
    } else {
        None
    }
}

async fn load_bool_setting(pool: &sqlx::SqlitePool, key: &str, default: bool) -> bool {
    let value = sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten();

    match value.as_deref() {
        Some("true") => true,
        Some("false") => false,
        _ => default,
    }
}

async fn clear_past_schedules_for_global_rebalance(
    state: &GlobalState,
    pool: &sqlx::SqlitePool,
    tasks: &[Task],
) -> Result<bool, String> {
    let now = chrono::Local::now();
    let stale_ids: Vec<&str> = tasks.iter()
        .filter(|t| {
            t.completed_at.is_none()
                && !t.locked
                && t.schedule.as_deref()
                    .and_then(parse_local_datetime)
                    .map(|dt| dt < now)
                    .unwrap_or(false)
        })
        .map(|t| t.id.as_str())
        .collect();

    if stale_ids.is_empty() {
        return Ok(false);
    }

    for id in stale_ids {
        sqlx::query(
            "UPDATE tasks SET schedule = NULL, updated_at = datetime('now') \
             WHERE id = ? AND (locked = 0 OR locked IS NULL)"
        )
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    }

    *state.cal_grid_cache.write().await = None;

    Ok(true)
}

async fn do_compute_schedule(state: &GlobalState, global_rebalance: bool) -> Result<SchedulerOutput, String> {
    let pool_guard = state.pool.read().await;
    let pool = pool_guard.as_ref().ok_or("No database loaded".to_string())?;

    // Load chunk config from settings
    let cfg = load_chunk_config(pool).await;
    let hours_per_chunk = cfg.hours_per_chunk();

    let reschedule_missed_scheduled_tasks = if global_rebalance {
        load_bool_setting(pool, "reschedule_missed_scheduled_tasks", true).await
    } else {
        false
    };

    let mut tasks = state.snapshot().await.map_err(|e| e.to_string())?;
    if reschedule_missed_scheduled_tasks
        && clear_past_schedules_for_global_rebalance(state, pool, &tasks).await?
    {
        tasks = state.snapshot().await.map_err(|e| e.to_string())?;
    }

    // Fetch active tasks (not completed, not deferred, not empty)
    let text_check = regex::Regex::new(r#""text"\s*:\s*"[^"]+""#).unwrap();
    let active: Vec<&Task> = tasks.iter()
        .filter(|t| {
            t.completed_at.is_none()
            && !t.is_deferred
            && text_check.is_match(&t.content) // has actual text content
        })
        .collect();

    // Load models
    let dirichlet = energy::load_dirichlet(pool, hours_per_chunk).await.map_err(|e| e.to_string())?;
    // Extract text from content JSON for NB tag prediction
    let text_re = regex::Regex::new(r#""text"\s*:\s*"([^"]+)""#).unwrap();

    // Load NB tag model for untagged task prediction
    let (word_tag, tag_priors) = nb::load_tag_model(pool).await.map_err(|e| e.to_string())?;

    // Predict tags for untagged tasks using NB Model 2
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
    // Current day-of-week (1=Mon, 7=Sun) and within-day chunk position
    let now = chrono::Local::now();
    let start_dow = now.format("%u").to_string().parse::<usize>().unwrap_or(1);
    let start_h = now.hour() as usize / hours_per_chunk; // within-day chunk position

    // Build a map from task_params for predicted tags
    let predicted_tags: std::collections::HashMap<String, String> = task_params.iter()
        .map(|(id, tag, _)| (id.clone(), tag.clone()))
        .collect();

    // Separate locked tasks from free tasks (to be solved).
    // Also pin unlocked tasks already scheduled in the current chunk —
    // they occupy capacity but aren't rescheduled.
    let mut scheduler_tasks: Vec<TaskInput> = Vec::new();
    let mut pinned_current_effort: Vec<i64> = Vec::new();
    for t in &active {
        // Skip locked tasks — they don't enter the solver, with or without a schedule
        if t.locked { continue; }

        // Compute current scheduled chunk for stability seeding
        let current_chunk = t.schedule.as_ref().map(|s| date_to_chunk(&Some(s.clone()), 0, &cfg));

        // Tasks scheduled in the current chunk (chunk 0) are pinned in place
        if current_chunk == Some(0) {
            pinned_current_effort.push(t.effort);
            continue;
        }

        let tag = predicted_tags.get(&t.id).cloned().unwrap_or_else(|| "__untagged__".to_string());
        let t_s = date_to_chunk_start(&t.start_date, &cfg);
        let t_f = date_to_chunk_end(&t.effective_due, &cfg);

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
            current_chunk,
            &cfg,
        ));
    }

    // Compute capacity consumed by completed, locked tasks, and calendar events
    let total_chunks = cfg.total_chunks();
    let mut capacity_used = vec![0.0f64; total_chunks];
    // Unlocked tasks pinned to the current chunk consume capacity
    for &effort in &pinned_current_effort {
        capacity_used[0] += scheduler::effort_to_slots(effort);
    }
    for t in &tasks {
        if t.locked && t.completed_at.is_none() {
            if let Some(ref sched) = t.schedule {
                let chunk = date_to_chunk(&Some(sched.clone()), 0, &cfg);
                if chunk < total_chunks {
                    capacity_used[chunk] += scheduler::effort_to_slots(t.effort);
                }
            }
            continue;
        }
        if let Some(ref done) = t.completed_at {
            let chunk = date_to_chunk(&Some(done.clone()), 0, &cfg);
            if chunk < total_chunks {
                capacity_used[chunk] += scheduler::effort_to_slots(t.effort);
            }
        }
    }

    // Fetch calendar busy times and subtract from capacity
    let cal_urls_json = sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = 'calendars'")
        .fetch_optional(pool).await.map_err(|e| e.to_string())?.unwrap_or_else(|| "[]".to_string());
    let cal_urls: Vec<String> = serde_json::from_str(&cal_urls_json).unwrap_or_default();
    if !cal_urls.is_empty() {
        let blocks = calendar::fetch_busy_blocks(&cal_urls, cfg.horizon_days).await;
        let cal_used = calendar::busy_to_capacity(&blocks, start_h, &cfg);
        for i in 0..total_chunks {
            capacity_used[i] += cal_used[i];
        }
        // Update the absolute grid cache for get_calendar_freebusy
        let grid = calendar::busy_to_grid(&blocks, &cfg);
        *state.cal_grid_cache.write().await = Some(grid);
    } else {
        let grid_size = cfg.horizon_days * cfg.chunks_per_day;
        *state.cal_grid_cache.write().await = Some(vec![0.0f64; grid_size]);
    }

    let params = SchedulerParams::default();
    let output = scheduler::solve(&scheduler_tasks, &dirichlet, &params, start_dow, start_h, &capacity_used, &cfg);

    // Write schedule dates to DB — use the chunk where the task has the most slots.
    // This ensures an L task split across two chunks (e.g. 7+1) shows in the chunk
    // with the bulk of its work, not the chunk with a 1-slot spillover.
    let mut best: std::collections::HashMap<String, (f64, String)> = std::collections::HashMap::new();
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
        for (tid, slots) in &alloc.tasks {
            best.entry(tid.clone())
                .and_modify(|(prev_slots, prev_date)| {
                    if *slots > *prev_slots {
                        *prev_slots = *slots;
                        *prev_date = sched_date.clone();
                    }
                })
                .or_insert((*slots, sched_date.clone()));
        }
    }
    let mut earliest: std::collections::HashMap<String, String> = best.into_iter()
        .map(|(id, (_, date))| (id, date))
        .collect();
    // Park tasks with garbage duals (ν > 1e10 = solver didn't converge)
    let mut all_parked: Vec<String> = output.parked.clone();
    for info in &output.task_info {
        if info.completion_pressure > 1e10 && !all_parked.contains(&info.id) {
            all_parked.push(info.id.clone());
            earliest.remove(&info.id);
        }
    }

    // Write schedule for properly solved tasks
    for (tid, sched_date) in &earliest {
        let _ = sqlx::query(
            "UPDATE tasks SET schedule = ?, updated_at = datetime('now') WHERE id = ? AND (locked = 0 OR locked IS NULL)"
        )
        .bind(sched_date)
        .bind(tid)
        .execute(pool)
        .await;
    }

    // Clear schedule for parked tasks
    for tid in &all_parked {
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

    // Update cache and return only the changed task via upsert path
    let task = {
        let cache = state.task_cache.read().await;
        cache.get(&id).cloned()
    };
    if let Some(mut t) = task {
        t.schedule = Some(schedule);
        t.locked = true;
        state.upsert(&t).await.map_err(|e| e.to_string())
    } else {
        // Cache miss — fall back to full snapshot
        state.snapshot().await.map_err(|e| e.to_string())
    }
}

/// Insert a new task at a given position, shifting all tasks at or after that position.
/// Atomic: runs shift + insert in one go.
/// Returns only the inserted task (with computed fields) instead of a full snapshot.
#[tauri::command]
pub async fn insert_task_at(
    task: Task,
    after_id: Option<String>,
    state: tauri::State<'_, GlobalState>,
) -> Result<Vec<Task>, String> {
    let pool_guard = state.pool.read().await;
    let pool = pool_guard.as_ref().ok_or("No database loaded".to_string())?;

    // Determine insertion position
    let insert_pos: i64 = if let Some(ref aid) = after_id {
        let row = sqlx::query_scalar::<_, i64>("SELECT position FROM tasks WHERE id = ?")
            .bind(aid)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?
            .unwrap_or(task.position);
        row + 1
    } else {
        task.position
    };

    // Shift all tasks at or after insert_pos
    sqlx::query("UPDATE tasks SET position = position + 1 WHERE position >= ?")
        .bind(insert_pos)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

    // Insert the new task
    sqlx::query(
        "INSERT INTO tasks (id, content, position, tags, parent_id, start_date, due_date, completed_at, rrule, effort, schedule, locked, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(&task.id)
    .bind(&task.content)
    .bind(insert_pos)
    .bind(&task.tags)
    .bind(&task.parent_id)
    .bind(&task.start_date)
    .bind(&task.due_date)
    .bind(&task.completed_at)
    .bind(&task.rrule)
    .bind(task.effort)
    .bind(&task.schedule)
    .bind(task.locked)
    .bind(&task.created_at)
    .bind(&task.updated_at)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;

    // Use upsert to add to cache and enrich (task already written to DB above)
    // Re-read the inserted task to get its actual position
    let mut inserted = task.clone();
    inserted.position = insert_pos;
    // Update positions in cache
    {
        let mut cache = state.task_cache.write().await;
        for t in cache.values_mut() {
            if t.position >= insert_pos {
                t.position += 1;
            }
        }
    }
    // Use the regular upsert path for enrichment (the DB row already exists)
    state.upsert(&inserted).await.map_err(|e| e.to_string())
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
fn date_to_chunk_start(date: &Option<String>, cfg: &ChunkConfig) -> usize {
    let total_chunks = cfg.total_chunks();
    let hours_per_chunk = cfg.hours_per_chunk();
    match date_to_hours_from_now(date) {
        Some(h) if h > 0 => (h as usize / hours_per_chunk).min(total_chunks - 1),
        _ => 0,
    }
}

/// due_date → chunk. Absent → total_chunks-1 (full horizon).
/// Past (overdue) → 0 (deadline already passed, maximum urgency).
/// Future → that chunk.
fn date_to_chunk_end(date: &Option<String>, cfg: &ChunkConfig) -> usize {
    let total_chunks = cfg.total_chunks();
    let hours_per_chunk = cfg.hours_per_chunk();
    match date_to_hours_from_now(date) {
        Some(h) if h > 0 => (h as usize / hours_per_chunk).min(total_chunks - 1),
        Some(_) => 0, // overdue: deadline passed, treat as maximally urgent
        None => total_chunks - 1,
    }
}

/// Converts an ISO date string to a scheduler chunk index, accounting for start_h offset.
/// The scheduler's chunk 0 = the current time block. Chunks fill the rest of today,
/// then wrap to midnight of the next day.
/// Returns `default` if the date is None or unparseable.
fn date_to_chunk(date: &Option<String>, default: usize, cfg: &ChunkConfig) -> usize {
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

    let total_chunks = cfg.total_chunks();
    let hours_per_chunk = cfg.hours_per_chunk();
    let now_h = now.hour() as usize / hours_per_chunk;
    let remaining_today = cfg.chunks_per_day - now_h;

    let diff = target.signed_duration_since(now);
    if diff.num_seconds() < 0 {
        // Past date — return 0 (earliest possible chunk)
        return 0;
    }

    // Days and hour-of-day for the target
    let target_day_start = target.date_naive().and_hms_opt(0, 0, 0).unwrap();
    let now_day_start = now.date_naive().and_hms_opt(0, 0, 0).unwrap();
    let day_diff = (target_day_start - now_day_start).num_days() as usize;
    let target_h = target.hour() as usize / hours_per_chunk;

    if day_diff == 0 {
        if target_h >= now_h {
            (target_h - now_h).min(total_chunks - 1)
        } else {
            0
        }
    } else {
        let chunk = remaining_today + (day_diff - 1) * cfg.chunks_per_day + target_h;
        chunk.min(total_chunks - 1)
    }
}

// ── Settings ──

#[tauri::command]
pub async fn get_setting(key: String, state: tauri::State<'_, GlobalState>) -> Result<Option<String>, String> {
    let pool_guard = state.pool.read().await;
    let pool = pool_guard.as_ref().ok_or("No database loaded".to_string())?;
    let row = sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ?")
        .bind(&key)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(row)
}

#[tauri::command]
pub async fn set_setting(key: String, value: String, state: tauri::State<'_, GlobalState>) -> Result<(), String> {
    let pool_guard = state.pool.read().await;
    let pool = pool_guard.as_ref().ok_or("No database loaded".to_string())?;
    sqlx::query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(&key)
        .bind(&value)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Chunk Config ──

/// Load ChunkConfig from settings, or return the default if not set.
async fn load_chunk_config(pool: &sqlx::SqlitePool) -> ChunkConfig {
    let json = sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = 'chunk_config'")
        .fetch_optional(pool).await.unwrap_or(None);
    match json {
        Some(s) => serde_json::from_str(&s).unwrap_or_default(),
        None => ChunkConfig::default(),
    }
}

#[tauri::command]
pub async fn get_chunk_config(state: tauri::State<'_, GlobalState>) -> Result<ChunkConfig, String> {
    let pool_guard = state.pool.read().await;
    let pool = pool_guard.as_ref().ok_or("No database loaded".to_string())?;
    Ok(load_chunk_config(pool).await)
}

#[tauri::command]
pub async fn set_chunk_config(config: ChunkConfig, state: tauri::State<'_, GlobalState>) -> Result<(), String> {
    // Validate: chunks_per_day must divide 24 evenly
    if 24 % config.chunks_per_day != 0 || config.chunks_per_day == 0 {
        return Err("chunks_per_day must divide 24 evenly (1,2,3,4,6,8,12,24)".to_string());
    }
    if config.horizon_days == 0 || config.horizon_days > 60 {
        return Err("horizon_days must be between 1 and 60".to_string());
    }
    if config.labels.len() != config.chunks_per_day {
        return Err(format!("labels length ({}) must equal chunks_per_day ({})", config.labels.len(), config.chunks_per_day));
    }

    let pool_guard = state.pool.read().await;
    let pool = pool_guard.as_ref().ok_or("No database loaded".to_string())?;
    let json = serde_json::to_string(&config).map_err(|e| e.to_string())?;
    sqlx::query("INSERT INTO settings (key, value) VALUES ('chunk_config', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(&json)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

    // Invalidate calendar cache since grid dimensions may have changed
    *state.cal_grid_cache.write().await = None;

    Ok(())
}


/// Background sync: processes a batch of typed transactions, persists to SQLite,
/// recomputes computed fields, and emits a 'sync-result' event with changed tasks.
/// Returns immediately — work happens in a spawned background task.
#[tauri::command]
pub async fn sync_tasks(
    transactions: Vec<crate::sync::Transaction>,
    seq: u64,
    app: tauri::AppHandle,
    state: tauri::State<'_, GlobalState>,
) -> Result<(), String> {
    let gs = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        match crate::sync::process_transactions(&gs, &transactions).await {
            Ok((mut changed, needs_reschedule)) => {
                // If scheduling-relevant fields changed, re-run the solver
                // and merge all updated tasks into one response.
                if needs_reschedule {
                    if let Ok(_) = do_compute_schedule(&gs, false).await {
                        if let Ok(all_tasks) = gs.snapshot().await {
                            changed = all_tasks;
                        }
                    }
                }

                let _ = app.emit("sync-result", serde_json::json!({
                    "seq": seq,
                    "changed": changed,
                }));
            }
            Err(e) => {
                eprintln!("sync_tasks error: {}", e);
            }
        }
    });
    Ok(())
}
