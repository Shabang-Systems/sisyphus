import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { invoke } from '@tauri-apps/api/core';
import { snapshot } from "@api/utils.js";

const search = createAsyncThunk('tasks/search', async (query) => {
    return await invoke('search', { query });
});

const createTask = createAsyncThunk('tasks/create', async ({ content, position }) => {
    return await invoke('create_task', { content, position });
});

const insertTaskAt = createAsyncThunk('tasks/insertAt', async ({ task, afterId }) => {
    const payload = {
        ...task,
        tags: task.tags ?? "[]",
        parent_id: task.parent_id ?? null,
        start_date: task.start_date ?? null,
        due_date: task.due_date ?? null,
        completed_at: task.completed_at ?? null,
        rrule: task.rrule ?? null,
        effort: task.effort ?? 0,
        schedule: task.schedule ?? null,
        locked: task.locked ?? false,
    };
    return await invoke('insert_task_at', { task: payload, afterId: afterId ?? null });
});

const upsert = createAsyncThunk('tasks/upsert', async (task) => {
    // Ensure all fields exist for Rust deserialization
    const payload = {
        ...task,
        tags: task.tags ?? "[]",
        parent_id: task.parent_id ?? null,
        start_date: task.start_date ?? null,
        due_date: task.due_date ?? null,
        completed_at: task.completed_at ?? null,
        rrule: task.rrule ?? null,
        effort: task.effort ?? 0,
        schedule: task.schedule ?? null,
        locked: task.locked ?? false,
    };
    const changed = await invoke('upsert', { task: payload });
    return changed; // array of tasks with updated computed fields
});

const batchUpsert = createAsyncThunk('tasks/batchUpsert', async (tasks) => {
    const payloads = tasks.map(task => ({
        ...task,
        tags: task.tags ?? "[]",
        parent_id: task.parent_id ?? null,
        start_date: task.start_date ?? null,
        due_date: task.due_date ?? null,
        completed_at: task.completed_at ?? null,
        rrule: task.rrule ?? null,
        effort: task.effort ?? 0,
        schedule: task.schedule ?? null,
        locked: task.locked ?? false,
    }));
    const changed = await invoke('batch_upsert', { tasks: payloads });
    return changed;
});

const remove = createAsyncThunk('tasks/remove', async (id) => {
    await invoke('remove', { id });
    return id;
});

const setParent = createAsyncThunk('tasks/setParent', async ({ id, parentId }) => {
    await invoke('set_parent', { id, parentId });
    return { id, parentId };
});

const reorder = createAsyncThunk('tasks/reorder', async (ids) => {
    await invoke('reorder', { ids });
    return ids;
});

const tasksSlice = createSlice({
    name: "tasks",
    initialState: { db: [], loading: true, searchResults: null, searchQuery: "" },
    reducers: {
        // Optimistic local update — instant, no Rust roundtrip
        updateTask(state, { payload: { id, changes } }) {
            const task = state.db.find(t => t.id === id);
            if (task) Object.assign(task, changes);
        },
        // Optimistic local insert (client-side UUID)
        addTask(state, { payload: task }) {
            state.db.push(task);
        },
        // Merge computed fields from Rust background sync
        mergeSyncResult(state, { payload: tasks }) {
            for (const updated of tasks) {
                const idx = state.db.findIndex(t => t.id === updated.id);
                if (idx >= 0) state.db[idx] = { ...state.db[idx], ...updated };
                else state.db.push(updated);
            }
        },
        // Optimistic remove
        dropTask(state, { payload: id }) {
            state.db = state.db.filter(t => t.id !== id);
        },
    },
    extraReducers: (builder) => {
        builder
            .addCase(snapshot.fulfilled, (state, { payload }) => {
                state.db = payload;
                state.loading = false;
            })
            .addCase(createTask.fulfilled, (state, { payload }) => {
                state.db.push(payload);
            })
            .addCase(createTask.rejected, (_, { error }) => console.error("create failed:", error))
            .addCase(upsert.fulfilled, (state, { payload }) => {
                // payload is an array of changed tasks with fresh computed fields
                for (const updated of payload) {
                    const idx = state.db.findIndex(t => t.id === updated.id);
                    if (idx >= 0) {
                        state.db[idx] = { ...state.db[idx], ...updated };
                    } else {
                        state.db.push(updated);
                    }
                }
            })
            .addCase(remove.fulfilled, (state, { payload }) => {
                state.db = state.db.filter(t => t.id !== payload);
            })
            .addCase(setParent.fulfilled, (state, { payload }) => {
                const task = state.db.find(t => t.id === payload.id);
                if (task) task.parent_id = payload.parentId;
            })
            .addCase(reorder.fulfilled, (state, { payload }) => {
                const orderMap = Object.fromEntries(payload.map((id, i) => [id, i]));
                state.db.sort((a, b) => (orderMap[a.id] ?? 0) - (orderMap[b.id] ?? 0));
                state.db.forEach((t, i) => { t.position = i; });
            })
            .addCase(search.fulfilled, (state, { payload, meta }) => {
                state.searchResults = payload;
                state.searchQuery = meta.arg;
            })
            .addCase(batchUpsert.fulfilled, (state, { payload }) => {
                for (const updated of payload) {
                    const idx = state.db.findIndex(t => t.id === updated.id);
                    if (idx >= 0) {
                        state.db[idx] = { ...state.db[idx], ...updated };
                    } else {
                        state.db.push(updated);
                    }
                }
            })
            .addCase(insertTaskAt.fulfilled, (state, { payload }) => {
                // Now returns only the inserted task(s) with computed fields
                for (const updated of payload) {
                    const idx = state.db.findIndex(t => t.id === updated.id);
                    if (idx >= 0) {
                        state.db[idx] = { ...state.db[idx], ...updated };
                    } else {
                        state.db.push(updated);
                    }
                }
            })
            .addCase(upsert.rejected, (_, { error }) => console.error("upsert failed:", error))
            .addCase(remove.rejected, (_, { error }) => console.error("remove failed:", error))
            .addCase(insertTaskAt.rejected, (_, { error }) => console.error("insertTaskAt failed:", error));
    },
});

const { updateTask, addTask, mergeSyncResult, dropTask } = tasksSlice.actions;
export { createTask, upsert, batchUpsert, remove, setParent, search, reorder, insertTaskAt };
export { updateTask, addTask, mergeSyncResult, dropTask };
export default tasksSlice.reducer;
