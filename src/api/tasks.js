import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { invoke } from '@tauri-apps/api/core';
import { snapshot } from "@api/utils.js";

const createTask = createAsyncThunk('tasks/create', async ({ content, position }) => {
    return await invoke('create_task', { content, position });
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
    };
    await invoke('upsert', { task: payload });
    return payload;
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
    initialState: { db: [], loading: true },
    reducers: {},
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
                const idx = state.db.findIndex(t => t.id === payload.id);
                if (idx >= 0) {
                    state.db[idx] = { ...state.db[idx], ...payload };
                } else {
                    state.db.push(payload);
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
            .addCase(upsert.rejected, (_, { error }) => console.error("upsert failed:", error))
            .addCase(remove.rejected, (_, { error }) => console.error("remove failed:", error));
    },
});

export { createTask, upsert, remove, setParent, reorder };
export default tasksSlice.reducer;
