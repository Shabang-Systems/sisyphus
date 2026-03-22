use anyhow::Result;
use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool};
use std::str::FromStr;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
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
    pub created_at: String,
    pub updated_at: String,
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

        let tasks = sqlx::query_as::<_, Task>(
            "SELECT id, content, position, tags, parent_id, start_date, due_date, completed_at, rrule, created_at, updated_at FROM tasks ORDER BY position ASC"
        )
        .fetch_all(pool)
        .await?;

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

        let task = sqlx::query_as::<_, Task>(
            "SELECT id, content, position, tags, parent_id, start_date, due_date, completed_at, rrule, created_at, updated_at FROM tasks WHERE id = ?"
        )
        .bind(&id)
        .fetch_one(pool)
        .await?;

        Ok(task)
    }

    pub async fn upsert(&self, task: &Task) -> Result<()> {
        let pool_guard = self.pool.read().await;
        let pool = pool_guard.as_ref().ok_or(anyhow::anyhow!("No database loaded"))?;

        sqlx::query(
            "INSERT INTO tasks (id, content, position, tags, parent_id, start_date, due_date, completed_at, rrule, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(id) DO UPDATE SET \
             content = excluded.content, \
             position = excluded.position, \
             tags = excluded.tags, \
             start_date = excluded.start_date, \
             due_date = excluded.due_date, \
             completed_at = excluded.completed_at, \
             rrule = excluded.rrule, \
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
        .bind(&task.created_at)
        .bind(&task.updated_at)
        .execute(pool)
        .await?;

        Ok(())
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
