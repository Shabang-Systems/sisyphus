use anyhow::{anyhow, Result};
use serde::Serialize;
use serde_json::{json, Value};
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row, SqlitePool};

use crate::state::GlobalState;

pub const REMOTE_SYNC_URL_KEY: &str = "remote_sync_url";
pub const REMOTE_SYNC_PERIOD_KEY: &str = "remote_sync_period_seconds";

const SYNC_SCHEMA_VERSION: &str = "1";
const APP_DATA_SCHEMA_VERSION: &str = "00000000000011";
const META_INSTANCE_ID: &str = "remote_instance_id";
const META_DEVICE_ID: &str = "device_id";
const META_LAST_EVENT_ID: &str = "last_event_id";

#[derive(Debug, Serialize)]
pub struct RemoteSyncResult {
    pub enabled: bool,
    pub changed: bool,
    pub pushed: u64,
    pub pulled: u64,
}

struct OutboxRow {
    id: i64,
    kind: String,
    table_name: String,
    pk_json: String,
    row_json: Option<String>,
}

struct RemoteEvent {
    event_id: i64,
    kind: String,
    table_name: String,
    pk_json: String,
    row_json: Option<String>,
}

pub fn is_synced_setting(key: &str) -> bool {
    matches!(
        key,
        "calendars" | "chunk_config" | "reschedule_missed_scheduled_tasks"
    )
}

pub async fn sync_now(state: &GlobalState) -> Result<RemoteSyncResult> {
    let _guard = state.remote_sync_lock.lock().await;
    let pool_guard = state.pool.read().await;
    let sqlite = pool_guard
        .as_ref()
        .ok_or_else(|| anyhow!("No database loaded"))?;
    let url = match remote_url(sqlite).await? {
        Some(url) => url,
        None => {
            return Ok(RemoteSyncResult {
                enabled: false,
                changed: false,
                pushed: 0,
                pulled: 0,
            });
        }
    };

    let pg = PgPoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await?;

    let remote_instance_id = ensure_remote_schema(&pg).await?;
    ensure_local_binding(sqlite, &pg, &remote_instance_id).await?;
    let device_id = ensure_device_id(sqlite).await?;

    let mut pushed = 0;
    let mut pulled = 0;
    let remote_is_empty = remote_event_count(&pg).await? == 0;
    let last_event_id = get_local_meta(sqlite, META_LAST_EVENT_ID)
        .await?
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0);

    if last_event_id == 0 && remote_is_empty {
        let (count, max_event_id) = upload_full_snapshot(sqlite, &pg, &device_id).await?;
        pushed += count;
        if max_event_id > 0 {
            set_local_meta(sqlite, META_LAST_EVENT_ID, &max_event_id.to_string()).await?;
        }
        sqlx::query("DELETE FROM remote_sync_outbox")
            .execute(sqlite)
            .await?;
        return Ok(RemoteSyncResult {
            enabled: true,
            changed: false,
            pushed,
            pulled,
        });
    }

    pushed += push_outbox(sqlite, &pg, &device_id).await?;
    pulled += pull_remote(sqlite, &pg, last_event_id, state).await?;
    let changed = pulled > 0;

    Ok(RemoteSyncResult {
        enabled: true,
        changed,
        pushed,
        pulled,
    })
}

async fn remote_url(pool: &SqlitePool) -> Result<Option<String>> {
    let value = sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ?")
        .bind(REMOTE_SYNC_URL_KEY)
        .fetch_optional(pool)
        .await?;
    Ok(value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty()))
}

async fn remote_enabled(pool: &SqlitePool) -> bool {
    remote_url(pool).await.ok().flatten().is_some()
}

async fn get_local_meta(pool: &SqlitePool, key: &str) -> Result<Option<String>> {
    Ok(
        sqlx::query_scalar::<_, String>("SELECT value FROM remote_sync_meta WHERE key = ?")
            .bind(key)
            .fetch_optional(pool)
            .await?,
    )
}

async fn set_local_meta(pool: &SqlitePool, key: &str, value: &str) -> Result<()> {
    sqlx::query(
        "INSERT INTO remote_sync_meta (key, value) VALUES (?, ?) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(key)
    .bind(value)
    .execute(pool)
    .await?;
    Ok(())
}

async fn ensure_device_id(pool: &SqlitePool) -> Result<String> {
    if let Some(id) = get_local_meta(pool, META_DEVICE_ID).await? {
        return Ok(id);
    }
    let id = uuid::Uuid::new_v4().to_string();
    set_local_meta(pool, META_DEVICE_ID, &id).await?;
    Ok(id)
}

async fn ensure_remote_schema(pg: &PgPool) -> Result<String> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS sisyphus_sync_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )",
    )
    .execute(pg)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS sisyphus_sync_events (
            event_id BIGSERIAL PRIMARY KEY,
            server_time TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
            device_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            table_name TEXT NOT NULL,
            pk JSONB NOT NULL,
            row_data JSONB
        )",
    )
    .execute(pg)
    .await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_sisyphus_sync_events_event_id
         ON sisyphus_sync_events(event_id)",
    )
    .execute(pg)
    .await?;

    let sync_version = ensure_remote_meta(pg, "sync_schema_version", SYNC_SCHEMA_VERSION).await?;
    if sync_version != SYNC_SCHEMA_VERSION {
        return Err(anyhow!(
            "Remote sync schema mismatch: expected {}, got {}",
            SYNC_SCHEMA_VERSION,
            sync_version
        ));
    }

    let app_version =
        ensure_remote_meta(pg, "app_data_schema_version", APP_DATA_SCHEMA_VERSION).await?;
    if app_version != APP_DATA_SCHEMA_VERSION {
        return Err(anyhow!(
            "Remote app data schema mismatch: expected {}, got {}",
            APP_DATA_SCHEMA_VERSION,
            app_version
        ));
    }

    let instance_id = match remote_meta(pg, "instance_id").await? {
        Some(id) => id,
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            set_remote_meta(pg, "instance_id", &id).await?;
            id
        }
    };

    Ok(instance_id)
}

async fn remote_meta(pg: &PgPool, key: &str) -> Result<Option<String>> {
    Ok(
        sqlx::query_scalar::<_, String>("SELECT value FROM sisyphus_sync_meta WHERE key = $1")
            .bind(key)
            .fetch_optional(pg)
            .await?,
    )
}

async fn set_remote_meta(pg: &PgPool, key: &str, value: &str) -> Result<()> {
    sqlx::query(
        "INSERT INTO sisyphus_sync_meta (key, value) VALUES ($1, $2) \
         ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value",
    )
    .bind(key)
    .bind(value)
    .execute(pg)
    .await?;
    Ok(())
}

async fn ensure_remote_meta(pg: &PgPool, key: &str, default: &str) -> Result<String> {
    if let Some(value) = remote_meta(pg, key).await? {
        return Ok(value);
    }
    set_remote_meta(pg, key, default).await?;
    Ok(default.to_string())
}

async fn ensure_local_binding(
    sqlite: &SqlitePool,
    pg: &PgPool,
    remote_instance_id: &str,
) -> Result<()> {
    if let Some(bound) = get_local_meta(sqlite, META_INSTANCE_ID).await? {
        if bound != remote_instance_id {
            return Err(anyhow!(
                "This workspace is already bound to a different remote sync database"
            ));
        }
        return Ok(());
    }

    let remote_empty = remote_event_count(pg).await? == 0;
    let local_empty = local_workspace_empty(sqlite).await?;
    if !remote_empty && !local_empty {
        return Err(anyhow!(
            "Remote sync database already has data. Open an empty local workspace before binding to it."
        ));
    }

    set_local_meta(sqlite, META_INSTANCE_ID, remote_instance_id).await?;
    Ok(())
}

async fn remote_event_count(pg: &PgPool) -> Result<i64> {
    Ok(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sisyphus_sync_events")
            .fetch_one(pg)
            .await?,
    )
}

async fn local_workspace_empty(pool: &SqlitePool) -> Result<bool> {
    let task_count = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM tasks")
        .fetch_one(pool)
        .await?;
    let sheet_count = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sheets WHERE query != ''")
        .fetch_one(pool)
        .await?;
    let setting_count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM settings WHERE key IN ('calendars', 'chunk_config', 'reschedule_missed_scheduled_tasks')",
    )
    .fetch_one(pool)
    .await?;
    let model_count = model_row_count(pool).await?;

    Ok(task_count == 0 && sheet_count == 0 && setting_count == 0 && model_count == 0)
}

async fn model_row_count(pool: &SqlitePool) -> Result<i64> {
    let dirichlet = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM dirichlet_state")
        .fetch_one(pool)
        .await?;
    let nb_duration = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM nb_duration")
        .fetch_one(pool)
        .await?;
    let nb_tags = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM nb_tags")
        .fetch_one(pool)
        .await?;
    let nb_priors = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM nb_tag_priors")
        .fetch_one(pool)
        .await?;
    Ok(dirichlet + nb_duration + nb_tags + nb_priors)
}

async fn upload_full_snapshot(
    sqlite: &SqlitePool,
    pg: &PgPool,
    device_id: &str,
) -> Result<(u64, i64)> {
    let rows = snapshot_rows(sqlite).await?;
    let mut count = 0;
    let mut max_event_id = 0;
    for (table_name, pk, row) in rows {
        let pk_json = serde_json::to_string(&pk)?;
        let row_json = serde_json::to_string(&row)?;
        let event_id = insert_remote_event(
            pg,
            device_id,
            "row_put",
            &table_name,
            &pk_json,
            Some(&row_json),
        )
        .await?;
        max_event_id = max_event_id.max(event_id);
        count += 1;
    }
    Ok((count, max_event_id))
}

async fn push_outbox(sqlite: &SqlitePool, pg: &PgPool, device_id: &str) -> Result<u64> {
    let rows = sqlx::query(
        "SELECT id, kind, table_name, pk_json, row_json FROM remote_sync_outbox ORDER BY id ASC",
    )
    .fetch_all(sqlite)
    .await?;

    let mut count = 0;
    let mut max_id = 0;
    for row in rows {
        let outbox = OutboxRow {
            id: row.get("id"),
            kind: row.get("kind"),
            table_name: row.get("table_name"),
            pk_json: row.get("pk_json"),
            row_json: row.get("row_json"),
        };
        insert_remote_event(
            pg,
            device_id,
            &outbox.kind,
            &outbox.table_name,
            &outbox.pk_json,
            outbox.row_json.as_deref(),
        )
        .await?;
        max_id = max_id.max(outbox.id);
        count += 1;
    }

    if max_id > 0 {
        sqlx::query("DELETE FROM remote_sync_outbox WHERE id <= ?")
            .bind(max_id)
            .execute(sqlite)
            .await?;
    }

    Ok(count)
}

async fn insert_remote_event(
    pg: &PgPool,
    device_id: &str,
    kind: &str,
    table_name: &str,
    pk_json: &str,
    row_json: Option<&str>,
) -> Result<i64> {
    Ok(sqlx::query_scalar::<_, i64>(
        "INSERT INTO sisyphus_sync_events (device_id, kind, table_name, pk, row_data)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
         RETURNING event_id",
    )
    .bind(device_id)
    .bind(kind)
    .bind(table_name)
    .bind(pk_json)
    .bind(row_json)
    .fetch_one(pg)
    .await?)
}

async fn pull_remote(
    sqlite: &SqlitePool,
    pg: &PgPool,
    last_event_id: i64,
    state: &GlobalState,
) -> Result<u64> {
    let rows = sqlx::query(
        "SELECT event_id, kind, table_name, pk::text AS pk_json, row_data::text AS row_json
         FROM sisyphus_sync_events
         WHERE event_id > $1
         ORDER BY event_id ASC",
    )
    .bind(last_event_id)
    .fetch_all(pg)
    .await?;

    let mut count = 0;
    let mut touched_tasks = false;
    let mut touched_settings = false;

    for row in rows {
        let event = RemoteEvent {
            event_id: row.get("event_id"),
            kind: row.get("kind"),
            table_name: row.get("table_name"),
            pk_json: row.get("pk_json"),
            row_json: row.get("row_json"),
        };
        let table = event.table_name.clone();
        apply_event(sqlite, &event).await?;
        if table == "tasks" {
            touched_tasks = true;
        }
        if table == "settings" {
            touched_settings = true;
        }
        set_local_meta(sqlite, META_LAST_EVENT_ID, &event.event_id.to_string()).await?;
        count += 1;
    }

    if touched_tasks {
        let _ = state.snapshot().await?;
    }
    if touched_settings {
        *state.cal_grid_cache.write().await = None;
    }

    Ok(count)
}

async fn apply_event(pool: &SqlitePool, event: &RemoteEvent) -> Result<()> {
    match event.kind.as_str() {
        "row_put" => {
            let row_json = event
                .row_json
                .as_deref()
                .ok_or_else(|| anyhow!("row_put event missing row_data"))?;
            let row: Value = serde_json::from_str(row_json)?;
            apply_row_put(pool, &event.table_name, &row).await
        }
        "row_delete" => {
            let pk: Value = serde_json::from_str(&event.pk_json)?;
            apply_row_delete(pool, &event.table_name, &pk).await
        }
        other => Err(anyhow!("Unknown remote sync event kind {}", other)),
    }
}

async fn apply_row_put(pool: &SqlitePool, table: &str, row: &Value) -> Result<()> {
    match table {
        "tasks" => {
            sqlx::query(
                "INSERT INTO tasks (id, content, position, tags, parent_id, start_date, due_date, completed_at, rrule, effort, schedule, locked, created_at, updated_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
                 ON CONFLICT(id) DO UPDATE SET \
                 content = excluded.content, \
                 position = excluded.position, \
                 tags = excluded.tags, \
                 parent_id = excluded.parent_id, \
                 start_date = excluded.start_date, \
                 due_date = excluded.due_date, \
                 completed_at = excluded.completed_at, \
                 rrule = excluded.rrule, \
                 effort = excluded.effort, \
                 schedule = excluded.schedule, \
                 locked = excluded.locked, \
                 created_at = excluded.created_at, \
                 updated_at = excluded.updated_at",
            )
            .bind(json_text(row, "id")?)
            .bind(json_text(row, "content")?)
            .bind(json_i64(row, "position")?)
            .bind(json_text(row, "tags")?)
            .bind(json_opt_text(row, "parent_id")?)
            .bind(json_opt_text(row, "start_date")?)
            .bind(json_opt_text(row, "due_date")?)
            .bind(json_opt_text(row, "completed_at")?)
            .bind(json_opt_text(row, "rrule")?)
            .bind(json_i64(row, "effort")?)
            .bind(json_opt_text(row, "schedule")?)
            .bind(json_bool(row, "locked")?)
            .bind(json_text(row, "created_at")?)
            .bind(json_text(row, "updated_at")?)
            .execute(pool)
            .await?;
        }
        "sheets" => {
            sqlx::query(
                "INSERT INTO sheets (id, query, position) VALUES (?, ?, ?) \
                 ON CONFLICT(id) DO UPDATE SET query = excluded.query, position = excluded.position",
            )
            .bind(json_i64(row, "id")?)
            .bind(json_text(row, "query")?)
            .bind(json_i64(row, "position")?)
            .execute(pool)
            .await?;
        }
        "settings" => {
            let key = json_text(row, "key")?;
            if is_synced_setting(&key) {
                sqlx::query(
                    "INSERT INTO settings (key, value) VALUES (?, ?) \
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                )
                .bind(key)
                .bind(json_text(row, "value")?)
                .execute(pool)
                .await?;
            }
        }
        "dirichlet_state" => {
            sqlx::query(
                "INSERT INTO dirichlet_state (dow, hour, tag, xi) VALUES (?, ?, ?, ?) \
                 ON CONFLICT(dow, hour, tag) DO UPDATE SET xi = excluded.xi",
            )
            .bind(json_i64(row, "dow")?)
            .bind(json_i64(row, "hour")?)
            .bind(json_text(row, "tag")?)
            .bind(json_f64(row, "xi")?)
            .execute(pool)
            .await?;
        }
        "nb_duration" => {
            sqlx::query(
                "INSERT INTO nb_duration (tag, size, total_observed, count) VALUES (?, ?, ?, ?) \
                 ON CONFLICT(tag, size) DO UPDATE SET total_observed = excluded.total_observed, count = excluded.count",
            )
            .bind(json_text(row, "tag")?)
            .bind(json_i64(row, "size")?)
            .bind(json_f64(row, "total_observed")?)
            .bind(json_i64(row, "count")?)
            .execute(pool)
            .await?;
        }
        "nb_tags" => {
            sqlx::query(
                "INSERT INTO nb_tags (word, tag, count) VALUES (?, ?, ?) \
                 ON CONFLICT(word, tag) DO UPDATE SET count = excluded.count",
            )
            .bind(json_text(row, "word")?)
            .bind(json_text(row, "tag")?)
            .bind(json_i64(row, "count")?)
            .execute(pool)
            .await?;
        }
        "nb_tag_priors" => {
            sqlx::query(
                "INSERT INTO nb_tag_priors (tag, count) VALUES (?, ?) \
                 ON CONFLICT(tag) DO UPDATE SET count = excluded.count",
            )
            .bind(json_text(row, "tag")?)
            .bind(json_i64(row, "count")?)
            .execute(pool)
            .await?;
        }
        _ => {}
    }

    Ok(())
}

async fn apply_row_delete(pool: &SqlitePool, table: &str, pk: &Value) -> Result<()> {
    match table {
        "tasks" => {
            sqlx::query("DELETE FROM tasks WHERE id = ?")
                .bind(json_text(pk, "id")?)
                .execute(pool)
                .await?;
        }
        "sheets" => {
            sqlx::query("DELETE FROM sheets WHERE id = ?")
                .bind(json_i64(pk, "id")?)
                .execute(pool)
                .await?;
        }
        "settings" => {
            let key = json_text(pk, "key")?;
            if is_synced_setting(&key) {
                sqlx::query("DELETE FROM settings WHERE key = ?")
                    .bind(key)
                    .execute(pool)
                    .await?;
            }
        }
        "dirichlet_state" => {
            sqlx::query("DELETE FROM dirichlet_state WHERE dow = ? AND hour = ? AND tag = ?")
                .bind(json_i64(pk, "dow")?)
                .bind(json_i64(pk, "hour")?)
                .bind(json_text(pk, "tag")?)
                .execute(pool)
                .await?;
        }
        "nb_duration" => {
            sqlx::query("DELETE FROM nb_duration WHERE tag = ? AND size = ?")
                .bind(json_text(pk, "tag")?)
                .bind(json_i64(pk, "size")?)
                .execute(pool)
                .await?;
        }
        "nb_tags" => {
            sqlx::query("DELETE FROM nb_tags WHERE word = ? AND tag = ?")
                .bind(json_text(pk, "word")?)
                .bind(json_text(pk, "tag")?)
                .execute(pool)
                .await?;
        }
        "nb_tag_priors" => {
            sqlx::query("DELETE FROM nb_tag_priors WHERE tag = ?")
                .bind(json_text(pk, "tag")?)
                .execute(pool)
                .await?;
        }
        _ => {}
    }

    Ok(())
}

pub async fn enqueue_task_put_by_id(pool: &SqlitePool, id: &str) {
    if let Err(e) = enqueue_task_put_by_id_result(pool, id).await {
        eprintln!("remote sync enqueue task put failed: {}", e);
    }
}

pub async fn enqueue_task_puts_by_id(pool: &SqlitePool, ids: &[String]) {
    for id in ids {
        enqueue_task_put_by_id(pool, id).await;
    }
}

async fn enqueue_task_put_by_id_result(pool: &SqlitePool, id: &str) -> Result<()> {
    if !remote_enabled(pool).await {
        return Ok(());
    }
    if let Some((pk, row)) = task_row(pool, id).await? {
        enqueue_row_put(pool, "tasks", &pk, &row).await?;
    }
    Ok(())
}

pub async fn enqueue_task_delete(pool: &SqlitePool, id: &str) {
    if let Err(e) = enqueue_row_delete_if_enabled(pool, "tasks", &json!({ "id": id })).await {
        eprintln!("remote sync enqueue task delete failed: {}", e);
    }
}

pub async fn enqueue_sheet_put_by_id(pool: &SqlitePool, id: i64) {
    if let Err(e) = enqueue_sheet_put_by_id_result(pool, id).await {
        eprintln!("remote sync enqueue sheet put failed: {}", e);
    }
}

async fn enqueue_sheet_put_by_id_result(pool: &SqlitePool, id: i64) -> Result<()> {
    if !remote_enabled(pool).await {
        return Ok(());
    }
    if let Some((pk, row)) = sheet_row(pool, id).await? {
        enqueue_row_put(pool, "sheets", &pk, &row).await?;
    }
    Ok(())
}

pub async fn enqueue_sheet_delete(pool: &SqlitePool, id: i64) {
    if let Err(e) = enqueue_row_delete_if_enabled(pool, "sheets", &json!({ "id": id })).await {
        eprintln!("remote sync enqueue sheet delete failed: {}", e);
    }
}

pub async fn enqueue_setting_put(pool: &SqlitePool, key: &str) {
    if !is_synced_setting(key) {
        return;
    }
    if let Err(e) = enqueue_setting_put_result(pool, key).await {
        eprintln!("remote sync enqueue setting put failed: {}", e);
    }
}

async fn enqueue_setting_put_result(pool: &SqlitePool, key: &str) -> Result<()> {
    if !remote_enabled(pool).await {
        return Ok(());
    }
    if let Some((pk, row)) = setting_row(pool, key).await? {
        enqueue_row_put(pool, "settings", &pk, &row).await?;
    }
    Ok(())
}

async fn enqueue_row_put(
    pool: &SqlitePool,
    table_name: &str,
    pk: &Value,
    row: &Value,
) -> Result<()> {
    let pk_json = serde_json::to_string(pk)?;
    let row_json = serde_json::to_string(row)?;
    sqlx::query(
        "INSERT INTO remote_sync_outbox (kind, table_name, pk_json, row_json) VALUES ('row_put', ?, ?, ?)",
    )
    .bind(table_name)
    .bind(pk_json)
    .bind(row_json)
    .execute(pool)
    .await?;
    Ok(())
}

async fn enqueue_row_delete_if_enabled(
    pool: &SqlitePool,
    table_name: &str,
    pk: &Value,
) -> Result<()> {
    if !remote_enabled(pool).await {
        return Ok(());
    }
    let pk_json = serde_json::to_string(pk)?;
    sqlx::query(
        "INSERT INTO remote_sync_outbox (kind, table_name, pk_json, row_json) VALUES ('row_delete', ?, ?, NULL)",
    )
    .bind(table_name)
    .bind(pk_json)
    .execute(pool)
    .await?;
    Ok(())
}

async fn snapshot_rows(pool: &SqlitePool) -> Result<Vec<(String, Value, Value)>> {
    let mut out = Vec::new();

    for row in sqlx::query("SELECT id FROM tasks ORDER BY position ASC")
        .fetch_all(pool)
        .await?
    {
        let id: String = row.get("id");
        if let Some((pk, data)) = task_row(pool, &id).await? {
            out.push(("tasks".to_string(), pk, data));
        }
    }

    for row in sqlx::query("SELECT id FROM sheets ORDER BY position ASC")
        .fetch_all(pool)
        .await?
    {
        let id: i64 = row.get("id");
        if let Some((pk, data)) = sheet_row(pool, id).await? {
            out.push(("sheets".to_string(), pk, data));
        }
    }

    for row in sqlx::query("SELECT key FROM settings")
        .fetch_all(pool)
        .await?
    {
        let key: String = row.get("key");
        if let Some((pk, data)) = setting_row(pool, &key).await? {
            out.push(("settings".to_string(), pk, data));
        }
    }

    append_model_rows(pool, &mut out).await?;
    Ok(out)
}

async fn task_row(pool: &SqlitePool, id: &str) -> Result<Option<(Value, Value)>> {
    let row = sqlx::query(
        "SELECT id, content, position, tags, parent_id, start_date, due_date, completed_at, rrule, effort, schedule, locked, created_at, updated_at \
         FROM tasks WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|row| {
        let id: String = row.get("id");
        let locked: i64 = row.get("locked");
        (
            json!({ "id": id }),
            json!({
                "id": id,
                "content": row.get::<String, _>("content"),
                "position": row.get::<i64, _>("position"),
                "tags": row.get::<String, _>("tags"),
                "parent_id": row.get::<Option<String>, _>("parent_id"),
                "start_date": row.get::<Option<String>, _>("start_date"),
                "due_date": row.get::<Option<String>, _>("due_date"),
                "completed_at": row.get::<Option<String>, _>("completed_at"),
                "rrule": row.get::<Option<String>, _>("rrule"),
                "effort": row.get::<i64, _>("effort"),
                "schedule": row.get::<Option<String>, _>("schedule"),
                "locked": locked != 0,
                "created_at": row.get::<String, _>("created_at"),
                "updated_at": row.get::<String, _>("updated_at"),
            }),
        )
    }))
}

async fn sheet_row(pool: &SqlitePool, id: i64) -> Result<Option<(Value, Value)>> {
    let row = sqlx::query("SELECT id, query, position FROM sheets WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|row| {
        let id: i64 = row.get("id");
        (
            json!({ "id": id }),
            json!({
                "id": id,
                "query": row.get::<String, _>("query"),
                "position": row.get::<i64, _>("position"),
            }),
        )
    }))
}

async fn setting_row(pool: &SqlitePool, key: &str) -> Result<Option<(Value, Value)>> {
    if !is_synced_setting(key) {
        return Ok(None);
    }
    let row = sqlx::query("SELECT key, value FROM settings WHERE key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|row| {
        let key: String = row.get("key");
        (
            json!({ "key": key }),
            json!({
                "key": key,
                "value": row.get::<String, _>("value"),
            }),
        )
    }))
}

async fn append_model_rows(pool: &SqlitePool, out: &mut Vec<(String, Value, Value)>) -> Result<()> {
    for row in sqlx::query("SELECT dow, hour, tag, xi FROM dirichlet_state")
        .fetch_all(pool)
        .await?
    {
        let dow: i64 = row.get("dow");
        let hour: i64 = row.get("hour");
        let tag: String = row.get("tag");
        out.push((
            "dirichlet_state".to_string(),
            json!({ "dow": dow, "hour": hour, "tag": tag }),
            json!({ "dow": dow, "hour": hour, "tag": tag, "xi": row.get::<f64, _>("xi") }),
        ));
    }

    for row in sqlx::query("SELECT tag, size, total_observed, count FROM nb_duration")
        .fetch_all(pool)
        .await?
    {
        let tag: String = row.get("tag");
        let size: i64 = row.get("size");
        out.push((
            "nb_duration".to_string(),
            json!({ "tag": tag, "size": size }),
            json!({
                "tag": tag,
                "size": size,
                "total_observed": row.get::<f64, _>("total_observed"),
                "count": row.get::<i64, _>("count"),
            }),
        ));
    }

    for row in sqlx::query("SELECT word, tag, count FROM nb_tags")
        .fetch_all(pool)
        .await?
    {
        let word: String = row.get("word");
        let tag: String = row.get("tag");
        out.push((
            "nb_tags".to_string(),
            json!({ "word": word, "tag": tag }),
            json!({ "word": word, "tag": tag, "count": row.get::<i64, _>("count") }),
        ));
    }

    for row in sqlx::query("SELECT tag, count FROM nb_tag_priors")
        .fetch_all(pool)
        .await?
    {
        let tag: String = row.get("tag");
        out.push((
            "nb_tag_priors".to_string(),
            json!({ "tag": tag }),
            json!({ "tag": tag, "count": row.get::<i64, _>("count") }),
        ));
    }

    Ok(())
}

fn json_text(row: &Value, key: &str) -> Result<String> {
    row.get(key)
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| anyhow!("remote sync row missing string field {}", key))
}

fn json_opt_text(row: &Value, key: &str) -> Result<Option<String>> {
    match row.get(key) {
        Some(Value::Null) | None => Ok(None),
        Some(v) => v
            .as_str()
            .map(|s| Some(s.to_string()))
            .ok_or_else(|| anyhow!("remote sync row field {} is not a string", key)),
    }
}

fn json_i64(row: &Value, key: &str) -> Result<i64> {
    row.get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| anyhow!("remote sync row missing integer field {}", key))
}

fn json_f64(row: &Value, key: &str) -> Result<f64> {
    row.get(key)
        .and_then(Value::as_f64)
        .ok_or_else(|| anyhow!("remote sync row missing number field {}", key))
}

fn json_bool(row: &Value, key: &str) -> Result<bool> {
    match row.get(key) {
        Some(Value::Bool(v)) => Ok(*v),
        Some(Value::Number(n)) => Ok(n.as_i64().unwrap_or(0) != 0),
        _ => Err(anyhow!("remote sync row missing boolean field {}", key)),
    }
}
