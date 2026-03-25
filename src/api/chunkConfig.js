import { invoke } from "@tauri-apps/api/core";
import strings from "@strings";

const DEFAULT = {
    chunks_per_day: 6,
    horizon_days: 14,
    labels: strings.CHUNK_LABELS,
};

let _cached = null;
let _promise = null;

/** Return cached config synchronously (default if not yet fetched). */
export function getCachedChunkConfig() {
    return _cached || DEFAULT;
}

/** Fetch config from backend, caching the result. Returns a promise. */
export function fetchChunkConfig() {
    if (!_promise) {
        _promise = invoke("get_chunk_config").then(cfg => {
            _cached = cfg;
            return cfg;
        }).catch(() => DEFAULT);
    }
    return _promise;
}

/** Update the cache directly (called after settings save). */
export function setChunkConfigCache(cfg) {
    _cached = cfg;
    _promise = Promise.resolve(cfg);
}

/** Invalidate cache so next fetch hits the backend. */
export function invalidateChunkConfig() {
    _cached = null;
    _promise = null;
}
