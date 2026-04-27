import { invoke } from "@tauri-apps/api/core";
import store from "./store.js";
import { snapshot } from "@api/utils.js";
import { fetchChunkConfig, invalidateChunkConfig } from "@api/chunkConfig.js";
import { remoteSyncStart, remoteSyncEnd } from "./ui.js";

const DEFAULT_PERIOD_SECONDS = 60;

let timer = null;
let running = false;

export function stopRemoteSyncTimer() {
    if (timer) clearInterval(timer);
    timer = null;
}

export async function restartRemoteSyncTimer() {
    stopRemoteSyncTimer();

    const url = await invoke("get_setting", { key: "remote_sync_url" }).catch(() => null);
    if (!url || !url.trim()) return;

    const rawPeriod = await invoke("get_setting", { key: "remote_sync_period_seconds" }).catch(() => null);
    const period = Math.max(5, parseInt(rawPeriod || `${DEFAULT_PERIOD_SECONDS}`, 10) || DEFAULT_PERIOD_SECONDS);

    timer = setInterval(() => {
        remoteSyncNow();
    }, period * 1000);

    remoteSyncNow();
}

export async function remoteSyncNow() {
    if (running) return null;
    running = true;
    store.dispatch(remoteSyncStart());
    try {
        const result = await invoke("remote_sync_now");
        if (result?.changed) {
            invalidateChunkConfig();
            await fetchChunkConfig();
            await store.dispatch(snapshot());
        }
        return result;
    } catch (e) {
        console.error("[remote-sync] failed:", e);
        return null;
    } finally {
        store.dispatch(remoteSyncEnd());
        running = false;
    }
}
