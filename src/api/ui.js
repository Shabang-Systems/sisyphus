import { createSlice } from '@reduxjs/toolkit';
import { snapshot } from "@api/utils.js";

const ui = createSlice({
    name: "ui",
    initialState: {
        ready: false,
        filePath: null,
        clock: Date.now(),
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
            });
    },
});

export const { setFilePath, tick } = ui.actions;
export default ui.reducer;
