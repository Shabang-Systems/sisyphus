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
}

impl GlobalState {
    pub fn new() -> Self {
        Self {
            pool: Arc::new(RwLock::new(None)),
            path: Arc::new(Mutex::new(None)),
        }
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

        // Snapshot before
        let before_rows = sqlx::query_as::<_, TaskRow>(
            "SELECT id, content, position, tags, parent_id, start_date, due_date, completed_at, rrule, effort, schedule, locked, created_at, updated_at FROM tasks ORDER BY position ASC"
        ).fetch_all(pool).await?;
        let mut before: Vec<Task> = before_rows.into_iter().map(|r| r.into()).collect();
        enrich_tasks(&mut before);
        let before_map: std::collections::HashMap<String, (Option<String>, bool)> = before.iter()
            .map(|t| (t.id.clone(), (t.effective_due.clone(), t.is_deferred)))
            .collect();

        // Write
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
        let old_tags = before.iter()
            .find(|t| t.id == task.id)
            .map(|t| t.tags.clone())
            .unwrap_or_else(|| "[]".to_string());
        if task.tags != old_tags && task.tags != "[]" {
            // Extract plain text from content JSON
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

        // Snapshot after and diff
        let after_rows = sqlx::query_as::<_, TaskRow>(
            "SELECT id, content, position, tags, parent_id, start_date, due_date, completed_at, rrule, effort, schedule, locked, created_at, updated_at FROM tasks ORDER BY position ASC"
        ).fetch_all(pool).await?;
        let mut after: Vec<Task> = after_rows.into_iter().map(|r| r.into()).collect();
        enrich_tasks(&mut after);

        // Return only tasks whose computed fields changed (plus the upserted task itself)
        let changed: Vec<Task> = after.into_iter().filter(|t| {
            if t.id == task.id { return true; }
            match before_map.get(&t.id) {
                Some((old_due, old_def)) => t.effective_due != *old_due || t.is_deferred != *old_def,
                None => true, // new task
            }
        }).collect();

        Ok(changed)
    }

    pub async fn remove(&self, id: &str) -> Result<()> {
        let pool_guard = self.pool.read().await;
        let pool = pool_guard.as_ref().ok_or(anyhow::anyhow!("No database loaded"))?;

        sqlx::query("DELETE FROM tasks WHERE id = ?")
            .bind(id)
            .execute(pool)
            .await?;

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

        let rows = sqlx::query_as::<_, TaskRow>(
            "SELECT id, content, position, tags, parent_id, start_date, due_date, completed_at, rrule, effort, schedule, locked, created_at, updated_at FROM tasks ORDER BY position ASC"
        )
        .fetch_all(pool)
        .await?;

        let mut tasks: Vec<Task> = rows.into_iter().map(|r| r.into()).collect();
        enrich_tasks(&mut tasks);

        if query.is_empty() {
            return Ok(tasks);
        }

        // Extract plain text from JSON content and match with regex
        let text_re = regex::Regex::new(r#""text"\s*:\s*"([^"]+)""#).unwrap();
        let search_re = regex::RegexBuilder::new(query)
            .case_insensitive(true)
            .build()
            .unwrap_or_else(|_| regex::Regex::new(&regex::escape(query)).unwrap());

        let filtered = tasks.into_iter().filter(|task| {
            // Search in extracted text
            for cap in text_re.captures_iter(&task.content) {
                if search_re.is_match(&cap[1]) {
                    return true;
                }
            }
            // Also search in tags
            if search_re.is_match(&task.tags) {
                return true;
            }
            false
        }).collect();

        Ok(filtered)
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
}
