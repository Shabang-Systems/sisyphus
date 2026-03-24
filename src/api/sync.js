import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import store from "./store.js";
import { mergeSyncResult } from "./tasks.js";
import { syncStart, syncEnd } from "./ui.js";

let pending = [];
let timer = null;
let seq = 0;
let lastApplied = 0;
const SYNC_DELAY = 1500;

let listenerInit = false;

// Listen for Rust sync results. Call once at app startup.
export async function initSyncListener() {
    if (listenerInit) return;
    listenerInit = true;
    console.log("[sync] initSyncListener called");
    await listen("sync-result", (event) => {
        const { seq: resultSeq, changed } = event.payload;
        console.log("[sync] received sync-result seq=", resultSeq, "changed=", changed?.length, "lastApplied=", lastApplied);
        if (resultSeq < lastApplied) {
            console.log("[sync] stale, discarding");
            return;
        }
        lastApplied = resultSeq;
        if (changed && changed.length > 0) {
            store.dispatch(mergeSyncResult(changed));
        }
        store.dispatch(syncEnd());
        console.log("[sync] syncPending =", store.getState().ui.syncPending);
    });

}

// Queue a transaction. No debounce here — just push and let the
// Redux subscriber handle batching.
export function txSet(id, field, value) {
    pending.push({ type: "set", id, field, value: value ?? null });
    scheduleBatch();
}

export function txCreate(task) {
    pending.push({ type: "create", task });
    scheduleBatch();
}

export function txDelete(id) {
    pending.push({ type: "delete", id });
    scheduleBatch();
}

export function flushNow() {
    if (timer) clearTimeout(timer);
    flush();
}

// --- Internal ---

function scheduleBatch() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, SYNC_DELAY);
}

function flush() {
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    timer = null;

    seq++;
    const currentSeq = seq;
    console.log("[sync] flush", batch.length, "transactions, seq=", currentSeq);
    store.dispatch(syncStart());
    console.log("[sync] syncPending =", store.getState().ui.syncPending);
    invoke("sync_tasks", { transactions: batch, seq: currentSeq }).catch(e => {
        console.error("[sync] sync_tasks failed:", e);
        pending = batch.concat(pending);
        store.dispatch(syncEnd());
    });
}
