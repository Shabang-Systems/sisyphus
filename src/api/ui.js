import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { invoke } from '@tauri-apps/api/core';
import { snapshot } from "@api/utils.js";

// Rebalance: compute_schedule + snapshot, debounced externally
// Uses a frame delay to ensure spinner renders before heavy work starts
export const rebalance = createAsyncThunk('ui/rebalance', async (_, { dispatch }) => {
    await invoke('compute_schedule', { globalRebalance: true });
    await dispatch(snapshot());
});

const ui = createSlice({
    name: "ui",
    initialState: {
        ready: false,
        filePath: null,
        clock: Date.now(),
        rebalancing: false,
        syncPending: 0,
        remoteSyncPending: 0,
    },
    reducers: {
        setFilePath: (state, { payload }) => {
            state.filePath = payload;
        },
        tick: (state) => {
            state.clock = Date.now();
        },
        syncStart: (state) => { state.syncPending++; },
        syncEnd: (state) => { state.syncPending = Math.max(0, state.syncPending - 1); },
        remoteSyncStart: (state) => { state.remoteSyncPending++; },
        remoteSyncEnd: (state) => { state.remoteSyncPending = Math.max(0, state.remoteSyncPending - 1); },
    },
    extraReducers: (builder) => {
        builder
            .addCase(snapshot.fulfilled, (state) => {
                state.ready = true;
            })
            .addCase(snapshot.rejected, (state, { error }) => {
                console.error("snapshot failed:", error);
            })
            .addCase(rebalance.pending, (state) => {
                state.rebalancing = true;
            })
            .addCase(rebalance.fulfilled, (state) => {
                state.rebalancing = false;
            })
            .addCase(rebalance.rejected, (state) => {
                state.rebalancing = false;
            });
    },
});

export const { setFilePath, tick, syncStart, syncEnd, remoteSyncStart, remoteSyncEnd } = ui.actions;
export default ui.reducer;
