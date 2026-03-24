use anyhow::Result;
use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool};
use std::str::FromStr;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Sheet {
    pub id: i64,
    pub query: String,
    pub position: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub content: String,
    pub position: i64,
    pub tags: String,
    pub parent_id: Option<String>,
    pub start_date: Option<String>,
    pub due_date: Option<String>,
    pub completed_at: Option<String>,
    pub rrule: Option<String>,
    pub effort: i64,
    pub schedule: Option<String>,
    pub locked: bool,
    pub created_at: String,
    pub updated_at: String,
    // Computed fields (not stored in DB)
    #[serde(default)]
    pub effective_due: Option<String>,
    #[serde(default)]
    pub is_deferred: bool,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct TaskRow {
    pub id: String,
    pub content: String,
    pub position: i64,
    pub tags: String,
    pub parent_id: Option<String>,
    pub start_date: Option<String>,
    pub due_date: Option<String>,
    pub completed_at: Option<String>,
    pub rrule: Option<String>,
    pub effort: i64,
    pub schedule: Option<String>,
    pub locked: bool,
    pub created_at: String,
    pub updated_at: String,
}

impl From<TaskRow> for Task {
    fn from(r: TaskRow) -> Self {
        Task {
            id: r.id, content: r.content, position: r.position,
            tags: r.tags, parent_id: r.parent_id,
            start_date: r.start_date, due_date: r.due_date,
            completed_at: r.completed_at, rrule: r.rrule,
            effort: r.effort, schedule: r.schedule, locked: r.locked,
            created_at: r.created_at, updated_at: r.updated_at,
            effective_due: None, is_deferred: false,
        }
    }
}

fn compute_effective_due(
    task_id: &str,
    tasks: &[Task],
    cache: &mut std::collections::HashMap<String, Option<String>>,
) -> Option<String> {
    if let Some(cached) = cache.get(task_id) {
        return cached.clone();
    }

    let task = tasks.iter().find(|t| t.id == task_id)?;
    let mut earliest = task.due_date.clone();

    for child in tasks.iter() {
        if child.parent_id.as_deref() == Some(task_id) && child.completed_at.is_none() {
            if let Some(child_due) = compute_effective_due(&child.id, tasks, cache) {
                if earliest.is_none() || child_due < *earliest.as_ref().unwrap() {
                    earliest = Some(child_due);
                }
            }
        }
    }

    cache.insert(task_id.to_string(), earliest.clone());
    earliest
}

// HashMap-based versions for incremental enrichment (O(1) lookups instead of O(n) scans)
fn compute_effective_due_map(
    task_id: &str,
    task_map: &std::collections::HashMap<String, Task>,
    children_map: &std::collections::HashMap<String, Vec<String>>,
    cache: &mut std::collections::HashMap<String, Option<String>>,
) -> Option<String> {
    if let Some(cached) = cache.get(task_id) {
        return cached.clone();
    }

    let task = task_map.get(task_id)?;
    let mut earliest = task.due_date.clone();

    if let Some(child_ids) = children_map.get(task_id) {
        for child_id in child_ids {
            if let Some(child) = task_map.get(child_id) {
                if child.completed_at.is_some() { continue; }
                if let Some(child_due) = compute_effective_due_map(child_id, task_map, children_map, cache) {
                    if earliest.is_none() || child_due < *earliest.as_ref().unwrap() {
                        earliest = Some(child_due);
                    }
                }
            }
        }
    }

    cache.insert(task_id.to_string(), earliest.clone());
    earliest
}

fn compute_is_deferred_map(
    task_id: &str,
    task_map: &std::collections::HashMap<String, Task>,
    now: &str,
    cache: &mut std::collections::HashMap<String, bool>,
) -> bool {
    if let Some(&cached) = cache.get(task_id) {
        return cached;
    }

    let task = match task_map.get(task_id) {
        Some(t) => t,
        None => { cache.insert(task_id.to_string(), false); return false; }
    };

    if task.completed_at.is_some() {
        cache.insert(task_id.to_string(), false);
        return false;
    }

    if let Some(ref start) = task.start_date {
        if start.as_str() > now {
            cache.insert(task_id.to_string(), true);
            return true;
        }
    }

    let result = if let Some(ref pid) = task.parent_id {
        compute_is_deferred_map(pid, task_map, now, cache)
    } else {
        false
    };

    cache.insert(task_id.to_string(), result);
    result
}

fn compute_is_deferred(
    task_id: &str,
    tasks: &[Task],
    now: &str,
    cache: &mut std::collections::HashMap<String, bool>,
) -> bool {
    if let Some(&cached) = cache.get(task_id) {
        return cached;
    }

    let task = match tasks.iter().find(|t| t.id == task_id) {
        Some(t) => t,
        None => { cache.insert(task_id.to_string(), false); return false; }
    };

    if task.completed_at.is_some() {
        cache.insert(task_id.to_string(), false);
        return false;
    }

    if let Some(ref start) = task.start_date {
        if start.as_str() > now {
            cache.insert(task_id.to_string(), true);
            return true;
        }
    }

    let result = if let Some(ref pid) = task.parent_id {
        compute_is_deferred(pid, tasks, now, cache)
    } else {
        false
    };

    cache.insert(task_id.to_string(), result);
    result
}

fn enrich_tasks(tasks: &mut Vec<Task>) {
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S").to_string();
    let snapshot: Vec<Task> = tasks.clone();
    let mut due_cache = std::collections::HashMap::new();
    let mut defer_cache = std::collections::HashMap::new();

    for task in tasks.iter_mut() {
        task.effective_due = compute_effective_due(&task.id, &snapshot, &mut due_cache);
        task.is_deferred = compute_is_deferred(&task.id, &snapshot, &now, &mut defer_cache);
    }
}

pub struct GlobalState {
    pub pool: Arc<RwLock<Option<SqlitePool>>>,
    pub path: Arc<Mutex<Option<String>>>,
    /// In-memory task cache for incremental enrichment. Populated on snapshot(), updated on upsert/remove.
    pub task_cache: Arc<RwLock<std::collections::HashMap<String, Task>>>,
    /// Parent→children index for fast subtree traversal.
    pub children_index: Arc<RwLock<std::collections::HashMap<String, Vec<String>>>>,
}

impl GlobalState {
    pub fn new() -> Self {
        Self {
            pool: Arc::new(RwLock::new(None)),
            path: Arc::new(Mutex::new(None)),
            task_cache: Arc::new(RwLock::new(std::collections::HashMap::new())),
            children_index: Arc::new(RwLock::new(std::collections::HashMap::new())),
        }
    }

    /// Rebuild children_index from a task map.
    fn rebuild_children_index(task_map: &std::collections::HashMap<String, Task>) -> std::collections::HashMap<String, Vec<String>> {
        let mut idx: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
        for task in task_map.values() {
            if let Some(ref pid) = task.parent_id {
                idx.entry(pid.clone()).or_default().push(task.id.clone());
            }
        }
        idx
    }

    /// Collect the affected set for incremental enrichment: the task itself, its ancestors, and its descendants.
    fn collect_affected(task_id: &str, task_map: &std::collections::HashMap<String, Task>, children_index: &std::collections::HashMap<String, Vec<String>>) -> Vec<String> {
        let mut affected = Vec::new();
        let mut seen = std::collections::HashSet::new();

        // Walk up ancestors
        let mut cur = Some(task_id.to_string());
        while let Some(ref id) = cur {
            if !seen.insert(id.clone()) { break; }
            affected.push(id.clone());
            cur = task_map.get(id).and_then(|t| t.parent_id.clone());
        }

        // Walk down descendants (BFS)
        let mut queue = std::collections::VecDeque::new();
        if let Some(children) = children_index.get(task_id) {
            for c in children { queue.push_back(c.clone()); }
        }
        while let Some(id) = queue.pop_front() {
            if !seen.insert(id.clone()) { continue; }
            affected.push(id.clone());
            if let Some(children) = children_index.get(&id) {
                for c in children { queue.push_back(c.clone()); }
            }
        }

        affected
    }

    pub async fn load(&self, path: &str) -> Result<()> {
        let options = SqliteConnectOptions::from_str(path)?
            .create_if_missing(true);

        let pool = SqlitePool::connect_with(options).await?;
        sqlx::migrate!("./migrations").run(&pool).await?;

        *self.pool.write().await = Some(pool);
        *self.path.lock().await = Some(path.to_string());

        Ok(())
    }

    pub async fn snapshot(&self) -> Result<Vec<Task>> {
        let pool_guard = self.pool.read().await;
        let pool = pool_guard.as_ref().ok_or(anyhow::anyhow!("No database loaded"))?;

        let rows = sqlx::query_as::<_, TaskRow>(
            "SELECT id, content, position, tags, parent_id, start_date, due_date, completed_at, rrule, effort, schedule, locked, created_at, updated_at FROM tasks ORDER BY position ASC"
        )
        .fetch_all(pool)
        .await?;

        let mut tasks: Vec<Task> = rows.into_iter().map(|r| r.into()).collect();
        enrich_tasks(&mut tasks);

        // Populate in-memory cache
        let cache_map: std::collections::HashMap<String, Task> = tasks.iter()
            .map(|t| (t.id.clone(), t.clone()))
            .collect();
        let children_idx = Self::rebuild_children_index(&cache_map);
        *self.task_cache.write().await = cache_map;
        *self.children_index.write().await = children_idx;

        Ok(tasks)
    }

    pub async fn create_task(&self, content: &str, position: i64) -> Result<Task> {
        let pool_guard = self.pool.read().await;
        let pool = pool_guard.as_ref().ok_or(anyhow::anyhow!("No database loaded"))?;

        let id = uuid::Uuid::new_v4().to_string();

        sqlx::query(
            "INSERT INTO tasks (id, content, position) VALUES (?, ?, ?)"
        )
        .bind(&id)
        .bind(content)
        .bind(position)
        .execute(pool)
        .await?;

        let row = sqlx::query_as::<_, TaskRow>(
            "SELECT id, content, position, tags, parent_id, start_date, due_date, completed_at, rrule, effort, schedule, locked, created_at, updated_at FROM tasks WHERE id = ?"
        )
        .bind(&id)
        .fetch_one(pool)
        .await?;
        let task: Task = row.into();

        Ok(task)
    }

    pub async fn upsert(&self, task: &Task) -> Result<Vec<Task>> {
        let pool_guard = self.pool.read().await;
        let pool = pool_guard.as_ref().ok_or(anyhow::anyhow!("No database loaded"))?;

        // Read old state from cache (O(1) instead of full-table scan)
        let old_task = {
            let cache = self.task_cache.read().await;
            cache.get(&task.id).cloned()
        };
        let old_tags = old_task.as_ref().map(|t| t.tags.clone()).unwrap_or_else(|| "[]".to_string());
        let was_completed = old_task.as_ref().map(|t| t.completed_at.is_some()).unwrap_or(false);
        // Capture old computed fields for affected tasks before we update
        let before_computed: std::collections::HashMap<String, (Option<String>, bool)> = {
            let cache = self.task_cache.read().await;
            let children_idx = self.children_index.read().await;
            let affected = Self::collect_affected(&task.id, &cache, &children_idx);
            affected.into_iter()
                .filter_map(|id| cache.get(&id).map(|t| (id, (t.effective_due.clone(), t.is_deferred))))
                .collect()
        };

        // Write to DB
        sqlx::query(
            "INSERT INTO tasks (id, content, position, tags, parent_id, start_date, due_date, completed_at, rrule, effort, schedule, locked, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(id) DO UPDATE SET \
             content = excluded.content, \
             position = excluded.position, \
             tags = excluded.tags, \
             start_date = excluded.start_date, \
             due_date = excluded.due_date, \
             completed_at = excluded.completed_at, \
             rrule = excluded.rrule, \
             effort = excluded.effort, \
             schedule = excluded.schedule, \
             locked = excluded.locked, \
             updated_at = excluded.updated_at"
        )
        .bind(&task.id)
        .bind(&task.content)
        .bind(task.position)
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
        .await?;

        // Update NB Model 2 if tags changed
        if task.tags != old_tags && task.tags != "[]" {
            let text_re = regex::Regex::new(r#""text"\s*:\s*"([^"]+)""#).unwrap();
            let text: String = text_re.captures_iter(&task.content)
                .filter_map(|c| c.get(1).map(|m| m.as_str().to_string()))
                .collect::<Vec<_>>()
                .join(" ");
            if !text.is_empty() {
                if let Ok(tags) = serde_json::from_str::<Vec<String>>(&task.tags) {
                    for tag in &tags {
                        let _ = crate::nb::update_tag_model(pool, &text, tag).await;
                    }
                }
            }
        }

        // Update NB Model 1 (duration debiasing) if task was just completed
        let now_completed = task.completed_at.is_some();
        if now_completed && !was_completed {
            if let Some(ref schedule) = old_task.as_ref().and_then(|t| t.schedule.clone()).or(task.schedule.clone()) {
                if let Some(ref completed_at) = task.completed_at {
                    let parse = |s: &str| -> Option<chrono::NaiveDateTime> {
                        chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").ok()
                            .or_else(|| chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.naive_utc()))
                    };
                    if let (Some(sched_dt), Some(comp_dt)) = (parse(schedule), parse(completed_at)) {
                        let delta_mins = (comp_dt - sched_dt).num_minutes().max(0) as f64;
                        let delta_slots = delta_mins / 30.0;
                        let tag = if let Ok(tags) = serde_json::from_str::<Vec<String>>(&task.tags) {
                            tags.into_iter().next().unwrap_or_else(|| "__untagged__".to_string())
                        } else {
                            "__untagged__".to_string()
                        };
                        let _ = crate::nb::update_duration_model(pool, &tag, task.effort, delta_slots).await;
                    }
                }
            }
        }

        // Update in-memory cache with the new task data, then incrementally re-enrich affected set
        let changed = {
            let mut cache = self.task_cache.write().await;
            let mut children_idx = self.children_index.write().await;

            // Check if parent_id changed — need to update children_index
            let old_parent = old_task.as_ref().and_then(|t| t.parent_id.clone());
            let new_parent = task.parent_id.clone();
            if old_parent != new_parent {
                // Remove from old parent's children list
                if let Some(ref opid) = old_parent {
                    if let Some(children) = children_idx.get_mut(opid) {
                        children.retain(|id| id != &task.id);
                    }
                }
                // Add to new parent's children list
                if let Some(ref npid) = new_parent {
                    children_idx.entry(npid.clone()).or_default().push(task.id.clone());
                }
            }

            // Update the cached task (preserve computed fields temporarily, will re-enrich below)
            cache.insert(task.id.clone(), task.clone());

            // Collect affected set and incrementally re-enrich
            let affected_ids = Self::collect_affected(&task.id, &cache, &children_idx);
            let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S").to_string();
            let mut due_cache = std::collections::HashMap::new();
            let mut defer_cache = std::collections::HashMap::new();

            // Re-enrich affected tasks
            for aid in &affected_ids {
                let new_due = compute_effective_due_map(aid, &cache, &children_idx, &mut due_cache);
                let new_deferred = compute_is_deferred_map(aid, &cache, &now, &mut defer_cache);
                if let Some(t) = cache.get_mut(aid) {
                    t.effective_due = new_due;
                    t.is_deferred = new_deferred;
                }
            }

            // Diff: find tasks whose computed fields changed
            let mut changed_tasks: Vec<Task> = Vec::new();
            for aid in &affected_ids {
                if let Some(t) = cache.get(aid) {
                    if aid == &task.id {
                        // Always return the upserted task
                        changed_tasks.push(t.clone());
                    } else if let Some((old_due, old_def)) = before_computed.get(aid) {
                        if t.effective_due != *old_due || t.is_deferred != *old_def {
                            changed_tasks.push(t.clone());
                        }
                    } else {
                        // New task not in before_computed
                        changed_tasks.push(t.clone());
                    }
                }
            }

            changed_tasks
        };

        Ok(changed)
    }

    pub async fn remove(&self, id: &str) -> Result<()> {
        let pool_guard = self.pool.read().await;
        let pool = pool_guard.as_ref().ok_or(anyhow::anyhow!("No database loaded"))?;

        sqlx::query("DELETE FROM tasks WHERE id = ?")
            .bind(id)
            .execute(pool)
            .await?;

        // Update cache
        {
            let mut cache = self.task_cache.write().await;
            let mut children_idx = self.children_index.write().await;
            if let Some(removed) = cache.remove(id) {
                if let Some(ref pid) = removed.parent_id {
                    if let Some(children) = children_idx.get_mut(pid) {
                        children.retain(|cid| cid != id);
                    }
                }
            }
            children_idx.remove(id);
        }

        Ok(())
    }

    pub async fn set_parent(&self, id: &str, parent_id: Option<&str>) -> Result<()> {
        let pool_guard = self.pool.read().await;
        let pool = pool_guard.as_ref().ok_or(anyhow::anyhow!("No database loaded"))?;

        sqlx::query("UPDATE tasks SET parent_id = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(parent_id)
            .bind(id)
            .execute(pool)
            .await?;

        // Update cache
        {
            let mut cache = self.task_cache.write().await;
            let mut children_idx = self.children_index.write().await;

            // Remove from old parent's children list
            if let Some(task) = cache.get(id) {
                if let Some(ref old_pid) = task.parent_id {
                    if let Some(children) = children_idx.get_mut(old_pid) {
                        children.retain(|cid| cid != id);
                    }
                }
            }

            // Update task's parent_id
            if let Some(task) = cache.get_mut(id) {
                task.parent_id = parent_id.map(|s| s.to_string());
            }

            // Add to new parent's children list
            if let Some(pid) = parent_id {
                children_idx.entry(pid.to_string()).or_default().push(id.to_string());
            }
        }

        Ok(())
    }

    pub async fn list_tags(&self) -> Result<Vec<String>> {
        let pool_guard = self.pool.read().await;
        let pool = pool_guard.as_ref().ok_or(anyhow::anyhow!("No database loaded"))?;

        // Extract tags from content JSON rather than trusting the tags column
        let rows: Vec<(String,)> = sqlx::query_as(
            "SELECT content FROM tasks"
        )
        .fetch_all(pool)
        .await?;

        let tag_re = regex::Regex::new(r#""type"\s*:\s*"tag"[^}]*"id"\s*:\s*"([^"]+)""#).unwrap();
        let mut all_tags = std::collections::BTreeSet::new();
        for (content,) in rows {
            for cap in tag_re.captures_iter(&content) {
                all_tags.insert(cap[1].to_string());
            }
        }

        Ok(all_tags.into_iter().collect())
    }

    pub async fn list_sheets(&self) -> Result<Vec<Sheet>> {
        let pool_guard = self.pool.read().await;
        let pool = pool_guard.as_ref().ok_or(anyhow::anyhow!("No database loaded"))?;
        let sheets = sqlx::query_as::<_, Sheet>("SELECT id, query, position FROM sheets ORDER BY position ASC")
            .fetch_all(pool).await?;
        Ok(sheets)
    }

    pub async fn upsert_sheet(&self, id: i64, query: &str) -> Result<Sheet> {
        let pool_guard = self.pool.read().await;
        let pool = pool_guard.as_ref().ok_or(anyhow::anyhow!("No database loaded"))?;
        sqlx::query("UPDATE sheets SET query = ? WHERE id = ?")
            .bind(query).bind(id).execute(pool).await?;
        let sheet = sqlx::query_as::<_, Sheet>("SELECT id, query, position FROM sheets WHERE id = ?")
            .bind(id).fetch_one(pool).await?;
        Ok(sheet)
    }

    pub async fn add_sheet(&self) -> Result<Sheet> {
        let pool_guard = self.pool.read().await;
        let pool = pool_guard.as_ref().ok_or(anyhow::anyhow!("No database loaded"))?;
        let max_pos: (i64,) = sqlx::query_as("SELECT COALESCE(MAX(position), -1) FROM sheets")
            .fetch_one(pool).await?;
        sqlx::query("INSERT INTO sheets (query, position) VALUES ('', ?)")
            .bind(max_pos.0 + 1).execute(pool).await?;
        let sheet = sqlx::query_as::<_, Sheet>("SELECT id, query, position FROM sheets ORDER BY id DESC LIMIT 1")
            .fetch_one(pool).await?;
        Ok(sheet)
    }

    pub async fn remove_sheet(&self, id: i64) -> Result<()> {
        let pool_guard = self.pool.read().await;
        let pool = pool_guard.as_ref().ok_or(anyhow::anyhow!("No database loaded"))?;
        sqlx::query("DELETE FROM sheets WHERE id = ?").bind(id).execute(pool).await?;
        Ok(())
    }

    pub async fn search(&self, query: &str) -> Result<Vec<Task>> {
        let pool_guard = self.pool.read().await;
        let pool = pool_guard.as_ref().ok_or(anyhow::anyhow!("No database loaded"))?;

        if query.is_empty() {
            let rows = sqlx::query_as::<_, TaskRow>(
                "SELECT id, content, position, tags, parent_id, start_date, due_date, completed_at, rrule, effort, schedule, locked, created_at, updated_at FROM tasks ORDER BY position ASC"
            ).fetch_all(pool).await?;
            let mut tasks: Vec<Task> = rows.into_iter().map(|r| r.into()).collect();
            enrich_tasks(&mut tasks);
            return Ok(tasks);
        }

        // Use SQLite LIKE for the search — pushes filtering to the DB engine.
        // content and tags are both TEXT columns containing JSON; LIKE searches within them.
        // Pass user's query directly — they can use % and _ for fuzzy matching
        let like_pattern = format!("%{}%", query);
        let rows = sqlx::query_as::<_, TaskRow>(
            "SELECT id, content, position, tags, parent_id, start_date, due_date, completed_at, rrule, effort, schedule, locked, created_at, updated_at \
             FROM tasks \
             WHERE content LIKE ? OR tags LIKE ? \
             ORDER BY position ASC"
        )
        .bind(&like_pattern)
        .bind(&like_pattern)
        .fetch_all(pool)
        .await?;

        let mut tasks: Vec<Task> = rows.into_iter().map(|r| r.into()).collect();
        enrich_tasks(&mut tasks);
        Ok(tasks)
    }

    pub async fn reorder(&self, ids: &[String]) -> Result<()> {
        let pool_guard = self.pool.read().await;
        let pool = pool_guard.as_ref().ok_or(anyhow::anyhow!("No database loaded"))?;

        for (i, id) in ids.iter().enumerate() {
            sqlx::query("UPDATE tasks SET position = ?, updated_at = datetime('now') WHERE id = ?")
                .bind(i as i64)
                .bind(id)
                .execute(pool)
                .await?;
        }

        Ok(())
    }

    /// Batch upsert: write multiple tasks in a single transaction, then incrementally re-enrich.
    /// Returns only tasks whose computed fields changed (plus all upserted tasks).
    pub async fn batch_upsert(&self, tasks: &[Task]) -> Result<Vec<Task>> {
        let pool_guard = self.pool.read().await;
        let pool = pool_guard.as_ref().ok_or(anyhow::anyhow!("No database loaded"))?;

        if tasks.is_empty() {
            return Ok(vec![]);
        }

        // Capture before-state from cache for all affected tasks
        let (before_computed, all_affected_before) = {
            let cache = self.task_cache.read().await;
            let children_idx = self.children_index.read().await;
            let mut all_affected = std::collections::HashSet::new();
            for t in tasks {
                for aid in Self::collect_affected(&t.id, &cache, &children_idx) {
                    all_affected.insert(aid);
                }
            }
            let bc: std::collections::HashMap<String, (Option<String>, bool)> = all_affected.iter()
                .filter_map(|id| cache.get(id).map(|t| (id.clone(), (t.effective_due.clone(), t.is_deferred))))
                .collect();
            (bc, all_affected)
        };

        // Write all tasks to DB in sequence (SQLite doesn't benefit from concurrent writes)
        for task in tasks {
            sqlx::query(
                "INSERT INTO tasks (id, content, position, tags, parent_id, start_date, due_date, completed_at, rrule, effort, schedule, locked, created_at, updated_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
                 ON CONFLICT(id) DO UPDATE SET \
                 content = excluded.content, \
                 position = excluded.position, \
                 tags = excluded.tags, \
                 start_date = excluded.start_date, \
                 due_date = excluded.due_date, \
                 completed_at = excluded.completed_at, \
                 rrule = excluded.rrule, \
                 effort = excluded.effort, \
                 schedule = excluded.schedule, \
                 locked = excluded.locked, \
                 updated_at = excluded.updated_at"
            )
            .bind(&task.id)
            .bind(&task.content)
            .bind(task.position)
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
            .await?;
        }

        // Update cache and incrementally re-enrich
        let changed = {
            let mut cache = self.task_cache.write().await;
            let mut children_idx = self.children_index.write().await;
            let task_ids: std::collections::HashSet<String> = tasks.iter().map(|t| t.id.clone()).collect();

            // Update cache entries and children index
            for task in tasks {
                let old_parent = cache.get(&task.id).and_then(|t| t.parent_id.clone());
                let new_parent = task.parent_id.clone();
                if old_parent != new_parent {
                    if let Some(ref opid) = old_parent {
                        if let Some(children) = children_idx.get_mut(opid) {
                            children.retain(|id| id != &task.id);
                        }
                    }
                    if let Some(ref npid) = new_parent {
                        children_idx.entry(npid.clone()).or_default().push(task.id.clone());
                    }
                }
                cache.insert(task.id.clone(), task.clone());
            }

            // Collect all affected tasks (union of affected sets for all upserted tasks)
            let mut all_affected = std::collections::HashSet::new();
            for t in tasks {
                for aid in Self::collect_affected(&t.id, &cache, &children_idx) {
                    all_affected.insert(aid);
                }
            }
            // Also include tasks that were affected before the update
            for aid in &all_affected_before {
                all_affected.insert(aid.clone());
            }

            // Re-enrich
            let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S").to_string();
            let mut due_cache = std::collections::HashMap::new();
            let mut defer_cache = std::collections::HashMap::new();

            for aid in &all_affected {
                let new_due = compute_effective_due_map(aid, &cache, &children_idx, &mut due_cache);
                let new_deferred = compute_is_deferred_map(aid, &cache, &now, &mut defer_cache);
                if let Some(t) = cache.get_mut(aid) {
                    t.effective_due = new_due;
                    t.is_deferred = new_deferred;
                }
            }

            // Diff
            let mut changed_tasks: Vec<Task> = Vec::new();
            for aid in &all_affected {
                if let Some(t) = cache.get(aid) {
                    if task_ids.contains(aid) {
                        changed_tasks.push(t.clone());
                    } else if let Some((old_due, old_def)) = before_computed.get(aid) {
                        if t.effective_due != *old_due || t.is_deferred != *old_def {
                            changed_tasks.push(t.clone());
                        }
                    } else {
                        changed_tasks.push(t.clone());
                    }
                }
            }

            changed_tasks
        };

        Ok(changed)
    }
}
