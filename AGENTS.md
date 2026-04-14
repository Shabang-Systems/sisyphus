# AGENTS.md

This file is a working guide for coding agents in this repository. It is based on the current codebase, not just `CLAUDE.md`.

## Stack

- Tauri v2 desktop app
- React 18 + Vite frontend
- Redux Toolkit for client state
- Tiptap/ProseMirror editor where each paragraph node maps to one task row
- Rust backend with SQLite via `sqlx`
- Scheduler implemented in Rust with OSQP, calendar free/busy ingestion, and learned energy/tag models

## Standard Commands

Prefer `yarn` in this repo because the lockfile is `yarn.lock`.

```bash
# Frontend only
yarn dev

# Full desktop app
yarn tauri dev

# Frontend production build
yarn build

# Rust compile check
cd src-tauri && cargo check

# Desktop production build
yarn tauri build
```

Notes:
- `package.json` only defines `dev`, `build`, `preview`, and `tauri`.
- There is no dedicated test suite in the repo today, so build/compile checks are the main verification path.

## Repo Map

- `src/`: React app, Redux slices, views, editor/node views, sync client
- `src-tauri/src/`: Rust commands, state/cache, scheduler, sync processing, calendar integration
- `src-tauri/migrations/`: SQLite schema migrations
- `misc/convex_task_scheduling_v2.md`: scheduler design notes

Current migration count: 11 files (`00000000000000` through `00000000000010`).

## Core Architecture

### Task Model

- Each Tiptap paragraph is one task.
- Task content is stored as serialized ProseMirror JSON in SQLite.
- Important stored scheduling fields include `parent_id`, `start_date`, `due_date`, `completed_at`, `rrule`, `effort`, `schedule`, and `locked`.
- Important computed fields are `effective_due` and `is_deferred`; these are recomputed in Rust, not by JS tree walking.

### Main Data Flow

1. User edits in `src/views/Editor.jsx`.
2. `runPipeline()` diffs the visible ProseMirror document against a local `visible` map.
3. New/changed/deleted tasks are sent through the optimistic Redux + background sync path.
4. `src/api/sync.js` batches transactions and invokes Rust `sync_tasks`.
5. Rust applies DB/cache updates in `src-tauri/src/sync.rs`.
6. If scheduling-relevant fields changed, Rust may call `compute_schedule`.
7. Frontend merges `sync-result` updates into Redux.

### Key Backend Entry Points

Important Tauri commands currently exposed from `src-tauri/src/lib.rs`:

- workspace/db: `bootstrap`, `load`, `snapshot`
- tasks: `create_task`, `upsert`, `batch_upsert`, `remove`, `set_parent`, `insert_task_at`, `reorder`
- browse/search: `search`, `list_tags`, `list_sheets`, `upsert_sheet`, `add_sheet`, `remove_sheet`
- scheduling/settings: `compute_schedule`, `accept_task_schedule`, `get_calendar_freebusy`, `get_calendar_debug`, `get_setting`, `set_setting`, `get_chunk_config`, `set_chunk_config`, `sync_tasks`

## Frontend Patterns That Matter

### Tiptap / NodeView Rules

- `taskId` is a paragraph attribute with `rendered: false`. Do not assume it is present in `HTMLAttributes`.
- Tiptap duplicates node attrs on Enter-split. The pipeline's dedup logic is what prevents duplicated `taskId`s from becoming corrupt task identity.
- Internal editor transactions use `tr.setMeta("sync", true)` and guard refs to avoid re-entrant pipeline runs.

### Styling Rules

- Dynamic task visual states rely on injected `<style id="sisyphus-*-style">` tags.
- Do not rely on `classList` mutations on Tiptap-managed DOM; re-renders will wipe them.

### Strings

- User-facing strings belong in `src/strings.js`.
- Existing string naming is flat with `__` namespacing, e.g. `VIEWS__AUTH_WELCOME`, `TOOLTIPS.ACTION_SCHEDULE`.

### Redux / Portal Detail

- `TaskNodeView.jsx` reads tasks via `useSyncExternalStore(store.subscribe, ...)` instead of normal `useSelector`, because Tiptap node views are rendered through portals and should not depend on Provider context behaving like regular React children.

## Scheduling Model

### Main Files

- `src-tauri/src/commands.rs`: schedule orchestration, DB writes, sync command
- `src-tauri/src/scheduler.rs`: solver input/output, packing, stability bias, precedence rules
- `src-tauri/src/calendar.rs`: ICS busy-block conversion into capacity/grid
- `src-tauri/src/energy.rs` and `src-tauri/src/nb.rs`: learned scheduling preference inputs

### What `compute_schedule` Does

- Loads active tasks from the Rust snapshot
- Predicts/reads task tag classes
- Builds scheduler inputs for unlocked tasks
- Treats locked tasks as fixed capacity consumers
- Pins unlocked tasks already in the current chunk instead of rescheduling them
- Subtracts calendar busy time from capacity
- Solves and writes `schedule` dates back to SQLite for unlocked tasks
- Clears `schedule` for parked tasks

### Important Scheduling Behavior

- Locked tasks are excluded from the solver.
- Manually scheduling a task typically also locks it.
- Overdue/past scheduled timestamps map to chunk `0`, so they behave like "current chunk" work rather than being automatically bumped forward.
- There is a small stability bonus that prefers a task's current scheduled chunk when ties are otherwise close.

### Recompute Triggers

Automatic/global rescheduling currently happens when:

- `sync_tasks` processes a batch that touches scheduling-relevant fields in `src-tauri/src/sync.rs`
- the user clicks the sync dot, which calls `flushNow()` and then `compute_schedule`
- settings changes call the debounced rebalance path
- the Debug view explicitly invokes `compute_schedule`

Notable current gaps:

- delete transactions do not mark `needs_reschedule`
- `content` and `tags` influence solver inputs but do not currently trigger auto-reschedule by themselves
- there is no app-shutdown flush hook for pending sync work

## Sync Behavior

### Client Sync Path

- `src/api/sync.js` batches transactions with a 1500 ms debounce.
- `flushNow()` only starts the flush; it does not wait for the background Rust task to complete.
- The pulsing sync dot is driven by `ui.syncPending > 0`, not by the reschedule overlay state.

### Failure Caveat

- Immediate `invoke("sync_tasks")` failure on the frontend re-queues the batch and clears the pulse.
- If the Rust background task fails after `sync_tasks` has already returned, the current code only logs the error and does not emit `sync-result`; this can leave the pulse stuck and does not automatically re-queue the batch.

## Current UI Behavior Worth Knowing

- `Action.jsx` is implemented and is the main scheduled-task timeline view; `CLAUDE.md` is stale on this point.
- Dragging in Action reschedules a task and locks it immediately.
- The schedule icon in task UI:
  - left click opens the schedule date picker
  - middle click clears `schedule` and unlocks the task

## Editing Guidance

- Preserve existing optimistic-update patterns unless you intentionally redesign both frontend and Rust sync behavior.
- When touching task upsert/update paths, be careful to preserve nullable scheduling fields exactly; this codebase relies on distinguishing `null` from `undefined`.
- When changing scheduler behavior, inspect both the frontend trigger path and the Rust writeback path. The solver alone is not the whole feature.
- If you touch `Editor.jsx`, assume small mistakes can break task identity, reply chains, or scheduling fields.

## Recommended Verification by Area

- Frontend-only UI changes: `yarn build`
- Rust/backend changes: `cd src-tauri && cargo check`
- Scheduling/sync changes: run the app and manually verify Action view, sync dot behavior, and schedule persistence
