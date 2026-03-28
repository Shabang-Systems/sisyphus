//! Transaction-based sync between frontend and backend.
//!
//! The frontend sends typed transactions (set field, create task, delete task).
//! This module processes them: writes to SQLite, updates the in-memory cache,
//! re-enriches affected tasks, and returns only tasks whose computed fields changed.

use std::collections::{HashMap, HashSet};
use serde::Deserialize;
use crate::state::{GlobalState, Task, compute_effective_due_map, compute_is_deferred_map};

/// A typed transaction from the frontend.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
pub enum Transaction {
    #[serde(rename = "set")]
    Set { id: String, field: String, value: serde_json::Value },
    #[serde(rename = "create")]
    Create { task: Task },
    #[serde(rename = "delete")]
    Delete { id: String },
}

/// Process a batch of transactions: apply each to the DB and cache,
/// then re-enrich affected tasks and return only those whose computed fields changed.
const SCHEDULE_FIELDS: &[&str] = &[
    "effort", "start_date", "due_date", "completed_at", "locked", "schedule", "parent_id",
];

pub async fn process_transactions(
    gs: &GlobalState,
    transactions: &[Transaction],
) -> anyhow::Result<(Vec<Task>, bool)> {
    let pool_guard = gs.pool.read().await;
    let pool = pool_guard.as_ref().ok_or(anyhow::anyhow!("No database loaded"))?;

    let mut touched_ids: Vec<String> = vec![];
    let mut needs_reschedule = false;

    for tx in transactions {
        match tx {
            Transaction::Set { id, field, value } => {
                let sql = match field.as_str() {
                    "content" | "tags" | "parent_id" | "start_date" | "due_date"
                    | "completed_at" | "rrule" | "schedule" | "created_at" | "updated_at" => {
                        format!("UPDATE tasks SET {} = ?, updated_at = datetime('now') WHERE id = ?", field)
                    }
                    "effort" | "position" => {
                        format!("UPDATE tasks SET {} = ?, updated_at = datetime('now') WHERE id = ?", field)
                    }
                    "locked" => {
                        "UPDATE tasks SET locked = ?, updated_at = datetime('now') WHERE id = ?".to_string()
                    }
                    _ => { continue; }
                };

                match field.as_str() {
                    "effort" | "position" => {
                        let v = value.as_i64().unwrap_or(0);
                        let _ = sqlx::query(&sql).bind(v).bind(id).execute(pool).await;
                    }
                    "locked" => {
                        let v = value.as_bool().unwrap_or(false);
                        let _ = sqlx::query(&sql).bind(v).bind(id).execute(pool).await;
                    }
                    _ => {
                        let v = value.as_str().map(|s| s.to_string());
                        let _ = sqlx::query(&sql).bind(&v).bind(id).execute(pool).await;
                    }
                }

                // Update cache
                {
                    let mut cache = gs.task_cache.write().await;
                    if let Some(task) = cache.get_mut(id) {
                        match field.as_str() {
                            "content" => task.content = value.as_str().unwrap_or("").to_string(),
                            "tags" => task.tags = value.as_str().unwrap_or("[]").to_string(),
                            "parent_id" => task.parent_id = value.as_str().map(|s| s.to_string()),
                            "start_date" => task.start_date = value.as_str().map(|s| s.to_string()),
                            "due_date" => task.due_date = value.as_str().map(|s| s.to_string()),
                            "completed_at" => task.completed_at = value.as_str().map(|s| s.to_string()),
                            "rrule" => task.rrule = value.as_str().map(|s| s.to_string()),
                            "schedule" => task.schedule = value.as_str().map(|s| s.to_string()),
                            "effort" => task.effort = value.as_i64().unwrap_or(0),
                            "locked" => task.locked = value.as_bool().unwrap_or(false),
                            "position" => task.position = value.as_i64().unwrap_or(0),
                            _ => {}
                        }
                    }
                }

                if SCHEDULE_FIELDS.contains(&field.as_str()) {
                    needs_reschedule = true;
                }
                touched_ids.push(id.clone());
            }

            Transaction::Create { task } => {
                needs_reschedule = true;
                let _ = sqlx::query(
                    "INSERT INTO tasks (id, content, position, tags, parent_id, start_date, due_date, \
                     completed_at, rrule, effort, schedule, locked, created_at, updated_at) \
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
                     ON CONFLICT(id) DO UPDATE SET \
                     content = excluded.content, position = excluded.position, tags = excluded.tags, \
                     start_date = excluded.start_date, due_date = excluded.due_date, \
                     completed_at = excluded.completed_at, rrule = excluded.rrule, \
                     effort = excluded.effort, schedule = excluded.schedule, \
                     locked = excluded.locked, updated_at = excluded.updated_at"
                )
                .bind(&task.id).bind(&task.content).bind(task.position).bind(&task.tags)
                .bind(&task.parent_id).bind(&task.start_date).bind(&task.due_date)
                .bind(&task.completed_at).bind(&task.rrule).bind(task.effort)
                .bind(&task.schedule).bind(task.locked)
                .bind(&task.created_at).bind(&task.updated_at)
                .execute(pool).await;

                {
                    let mut cache = gs.task_cache.write().await;
                    let mut children_idx = gs.children_index.write().await;
                    if let Some(ref pid) = task.parent_id {
                        children_idx.entry(pid.clone()).or_default().push(task.id.clone());
                    }
                    cache.insert(task.id.clone(), task.clone());
                }

                touched_ids.push(task.id.clone());
            }

            Transaction::Delete { id } => {
                let _ = sqlx::query("DELETE FROM tasks WHERE id = ?")
                    .bind(id).execute(pool).await;
                {
                    let mut cache = gs.task_cache.write().await;
                    let mut children_idx = gs.children_index.write().await;
                    if let Some(task) = cache.remove(id) {
                        if let Some(ref pid) = task.parent_id {
                            if let Some(children) = children_idx.get_mut(pid) {
                                children.retain(|cid| cid != id);
                            }
                        }
                    }
                }
            }
        }
    }

    if touched_ids.is_empty() {
        return Ok((vec![], false));
    }

    // Re-enrich all affected tasks and diff
    let mut cache = gs.task_cache.write().await;
    let children_idx = gs.children_index.read().await;

    let mut all_affected = HashSet::new();
    for id in &touched_ids {
        for aid in GlobalState::collect_affected(id, &cache, &children_idx) {
            all_affected.insert(aid);
        }
    }

    let before: HashMap<String, (Option<String>, bool)> = all_affected.iter()
        .filter_map(|id| cache.get(id).map(|t| (id.clone(), (t.effective_due.clone(), t.is_deferred))))
        .collect();

    let now = chrono::Local::now();
    let mut due_cache = HashMap::new();
    let mut defer_cache = HashMap::new();

    for aid in &all_affected {
        let new_due = compute_effective_due_map(aid, &cache, &children_idx, &mut due_cache);
        let new_deferred = compute_is_deferred_map(aid, &cache, &now, &mut defer_cache);
        if let Some(t) = cache.get_mut(aid) {
            t.effective_due = new_due;
            t.is_deferred = new_deferred;
        }
    }

    let touched_set: HashSet<String> = touched_ids.into_iter().collect();
    let mut changed: Vec<Task> = vec![];
    for aid in &all_affected {
        if let Some(t) = cache.get(aid) {
            if touched_set.contains(aid) {
                changed.push(t.clone());
            } else if let Some((old_due, old_def)) = before.get(aid) {
                if t.effective_due != *old_due || t.is_deferred != *old_def {
                    changed.push(t.clone());
                }
            }
        }
    }

    Ok((changed, needs_reschedule))
}
