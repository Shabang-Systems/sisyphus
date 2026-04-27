CREATE TABLE IF NOT EXISTS remote_sync_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS remote_sync_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    table_name TEXT NOT NULL,
    pk_json TEXT NOT NULL,
    row_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_remote_sync_outbox_id
    ON remote_sync_outbox(id);
