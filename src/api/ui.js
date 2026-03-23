import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { invoke } from '@tauri-apps/api/core';
import { snapshot } from "@api/utils.js";

// Rebalance: compute_schedule + snapshot, debounced externally
// Uses a frame delay to ensure spinner renders before heavy work starts
export const rebalance = createAsyncThunk('ui/rebalance', async (_, { dispatch }) => {
    // Let the spinner render
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    await invoke('compute_schedule');
    await dispatch(snapshot());
    // Keep spinner visible briefly so user sees it
    await new Promise(r => setTimeout(r, 300));
});

const ui = createSlice({
    name: "ui",
    initialState: {
        ready: false,
        filePath: null,
        clock: Date.now(),
        rebalancing: false,
    },
    reducers: {
        setFilePath: (state, { payload }) => {
            state.filePath = payload;
        },
        tick: (state) => {
            state.clock = Date.now();
        },
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

export const { setFilePath, tick } = ui.actions;
export default ui.reducer;
