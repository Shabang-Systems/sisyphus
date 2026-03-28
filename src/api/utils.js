import { invoke } from '@tauri-apps/api/core';
import { createAsyncThunk } from '@reduxjs/toolkit';
import moment from 'moment';

const snapshot = createAsyncThunk(
    'snapshot',
    async (_, thunkAPI) => {
        return await invoke('snapshot');
    },
);

/** Format a Date as ISO 8601 with local timezone offset. */
const localISO = (d = new Date()) => moment(d).format();

export { snapshot, localISO };
