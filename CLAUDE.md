# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development

```bash
# Full app (frontend + Rust backend)
yarn tauri dev

# Frontend only
yarn dev          # Vite dev server on port 1420

# Rust only (check compilation)
cd src-tauri && cargo check

# Build for production
yarn tauri build
```

Package manager is **yarn**. Frontend is Vite on port 1420 with HMR. Tauri handles the Rust backend build automatically via `beforeDevCommand`.

## Architecture

Tauri v2 desktop app: Rust backend with SQLite (via sqlx), React 18 frontend with Tiptap rich text editor. Each Tiptap paragraph node = one task in the database.

### Data Flow
1. User edits in Tiptap editor
2. `onUpdate` triggers `runPipeline()` in `Editor.jsx`
3. Pipeline diffs the ProseMirror doc against `visible` ref (Map of known tasks)
4. New/changed/deleted tasks dispatched to Redux thunks → `invoke()` Rust commands
5. Rust `upsert` writes to SQLite and returns changed tasks with recomputed fields (`effective_due`, `is_deferred`)
6. Redux reducer merges returned tasks; scheduling styles effect regenerates injected `<style>` tags

### Critical Patterns

**Injected Stylesheets**: ProseMirror re-renders wipe DOM class/style changes. All dynamic visual states MUST use injected `<style id="sisyphus-*-style">` tags (4 exist: schedule, collapse, search, drag). Never use `classList` on Tiptap-managed DOM.

**Tiptap Paragraph Splitting**: When Enter splits a paragraph, Tiptap copies ALL node attributes (including `taskId`) to the new half. The pipeline's `dedup()` function detects duplicate taskIds and nullifies the copy so it gets a fresh UUID.

**`rendered: false` Attributes**: `taskId` has `rendered: false` so it's NOT in `HTMLAttributes`. Always use `node.attrs.taskId` in `renderHTML`, never destructure from `HTMLAttributes`.

**Pipeline Transaction Guard**: Internal transactions use `tr.setMeta("sync", true)` + a `guard` ref to prevent `onUpdate` → `runPipeline` re-entrancy.

**Computed Fields in Rust**: `effective_due` (earliest due date in descendant tree) and `is_deferred` (cascading start_date check up ancestor chain) are computed by `enrich_tasks()` in `state.rs`. The `upsert` command snapshots before/after, diffs, and returns only tasks whose computed fields changed. No JS-side tree walking.

**Scheduling Field Preservation**: The debounced update path in `runPipeline` must spread `...existing` from `tasksRef` to preserve `parent_id`, `start_date`, `due_date`, `completed_at`, `rrule`. The `upsert` thunk uses `??` (not `||`) to distinguish explicit `null` from `undefined`.

### Views
- **Planning** (`Editor.jsx`): Main freeform editor. Tasks, tags (@mentions), replies (parent_id arrows), focus mode (collapse subtree), drag-to-reorder, find (Cmd+F with ProseMirror decorations).
- **Browse** (`Browse.jsx`): Saved search sheets. Search bar filters tasks via Rust regex. Sheets persisted in `sheets` table. Right-side dot navigation (cao-style).
- **Action** (`Action.jsx`): Blank, TBD.

### Vite Path Aliases
`@api` → `src/api`, `@views` → `src/views`, `@components` → `src/components`, `@strings` → `src/strings.js`

## Database Schema

Tasks table with 9 stored columns + 2 computed fields. SQLite file chosen by user at startup (`.db` extension). Migrations in `src-tauri/migrations/` (5 files, applied via `sqlx::migrate!`).

Key constraint: `upsert` ON CONFLICT updates content/position/tags/scheduling fields but does NOT touch `parent_id` (only `set_parent` command changes it).

## Tauri IPC Commands

`bootstrap`, `load`, `snapshot`, `create_task`, `upsert` (returns `Vec<Task>` of changed tasks), `remove`, `set_parent`, `search` (regex on content + tags), `list_tags` (extracts from content JSON), `list_sheets`, `upsert_sheet`, `add_sheet`, `remove_sheet`, `reorder`

## Strings & i18n

All user-facing strings in `src/strings.js` as a flat object with `__` namespacing (e.g. `VIEWS__AUTH_WELCOME`, `TOOLTIPS.ACTION`). No bare strings in components.

## Keyboard Shortcuts

Defined in `src/shortcuts.js`. Format: `"mod+key"` where `mod` = Cmd (Mac) / Ctrl (Win). Handled via capture-phase document keydown listener in `Editor.jsx` with `stopPropagation` to prevent Tiptap from processing them.

## Color Palette

CSS variables in `src/theme.css`. Font: Rubik (bundled in `src/extern/`). Font Awesome icons also bundled locally in `src/extern/fa/`.
