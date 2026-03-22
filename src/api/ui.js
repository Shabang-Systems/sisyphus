import { createSlice } from '@reduxjs/toolkit';
import { snapshot } from "@api/utils.js";

const ui = createSlice({
    name: "ui",
    initialState: {
        ready: false,
        filePath: null,
    },
    reducers: {
        setFilePath: (state, { payload }) => {
            state.filePath = payload;
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

export const { setFilePath } = ui.actions;
export default ui.reducer;
