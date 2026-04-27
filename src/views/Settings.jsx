import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCachedChunkConfig, fetchChunkConfig, setChunkConfigCache } from "@api/chunkConfig.js";
import { restartRemoteSyncTimer } from "@api/remoteSync.js";
import strings from "@strings";
import Training from "@views/Training.jsx";
import Debug from "@views/Debug.jsx";
import "./Settings.css";

const VALID_CHUNKS = [1, 2, 3, 4, 6, 8, 12, 24];

// Default labels for each chunks_per_day value
const DEFAULT_LABELS = {
    1: ["all day"],
    2: ["day", "night"],
    3: ["morning", "afternoon", "evening"],
    4: ["morning", "midday", "afternoon", "evening"],
    6: ["midnight", "dawn", "morning", "afternoon", "evening", "night"],
    8: ["late night", "dawn", "early morning", "morning", "midday", "afternoon", "evening", "night"],
    12: Array.from({ length: 12 }, (_, i) => `${String(i * 2).padStart(2, "0")}:00`),
    24: Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, "0")}:00`),
};

export default function Settings({ onLogout, triggerRebalance, onStartTour }) {
    const [subView, setSubView] = useState(null); // "training" | "debug" | null
    const [calendars, setCalendars] = useState([]);
    const [chunkConfig, setChunkConfig] = useState(getCachedChunkConfig);
    const [rescheduleMissedScheduledTasks, setRescheduleMissedScheduledTasks] = useState(true);
    const [remoteSyncUrl, setRemoteSyncUrl] = useState("");
    const [remoteSyncPeriod, setRemoteSyncPeriod] = useState(60);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        (async () => {
            try {
                const val = await invoke("get_setting", { key: "remote_sync_url" });
                if (val) setRemoteSyncUrl(val);
            } catch {}
            try {
                const val = await invoke("get_setting", { key: "remote_sync_period_seconds" });
                if (val !== null) setRemoteSyncPeriod(parseInt(val, 10) || 60);
            } catch {}
            try {
                const val = await invoke("get_setting", { key: "calendars" });
                if (val) setCalendars(JSON.parse(val));
            } catch {}
            try {
                const val = await invoke("get_setting", { key: "reschedule_missed_scheduled_tasks" });
                if (val !== null) setRescheduleMissedScheduledTasks(val !== "false");
            } catch {}
            try {
                const cfg = await fetchChunkConfig();
                setChunkConfig(cfg);
            } catch {}
            setLoading(false);
        })();
    }, []);

    const saveRemoteSyncUrl = useCallback(async (value) => {
        setRemoteSyncUrl(value);
        try {
            await invoke("set_setting", { key: "remote_sync_url", value: value.trim() });
            await restartRemoteSyncTimer();
        } catch (e) {
            console.error("Failed to save remote sync URL:", e);
        }
    }, []);

    const saveRemoteSyncPeriod = useCallback(async (value) => {
        const seconds = Math.max(5, parseInt(value, 10) || 60);
        setRemoteSyncPeriod(seconds);
        try {
            await invoke("set_setting", { key: "remote_sync_period_seconds", value: String(seconds) });
            await restartRemoteSyncTimer();
        } catch (e) {
            console.error("Failed to save remote sync period:", e);
        }
    }, []);

    const saveChunkConfig = useCallback(async (cfg) => {
        setChunkConfig(cfg);
        setChunkConfigCache(cfg); // update module-level cache for other views
        try {
            await invoke("set_chunk_config", { config: cfg });
            if (triggerRebalance) triggerRebalance();
        } catch (e) { console.error("Failed to save chunk config:", e); }
    }, [triggerRebalance]);

    const updateChunksPerDay = (val) => {
        const cpd = parseInt(val, 10);
        if (!VALID_CHUNKS.includes(cpd)) return;
        const labels = DEFAULT_LABELS[cpd] || Array.from({ length: cpd }, (_, i) => `chunk ${i + 1}`);
        saveChunkConfig({ ...chunkConfig, chunks_per_day: cpd, labels });
    };

    const updateHorizon = (val) => {
        const h = parseInt(val, 10);
        if (h >= 1 && h <= 60) saveChunkConfig({ ...chunkConfig, horizon_days: h });
    };

    const updateLabel = (i, value) => {
        const labels = [...chunkConfig.labels];
        labels[i] = value;
        saveChunkConfig({ ...chunkConfig, labels });
    };

    const saveRescheduleMissedScheduledTasks = useCallback(async (enabled) => {
        setRescheduleMissedScheduledTasks(enabled);
        try {
            await invoke("set_setting", {
                key: "reschedule_missed_scheduled_tasks",
                value: String(enabled),
            });
            if (triggerRebalance) triggerRebalance();
        } catch (e) {
            console.error("Failed to save global reschedule setting:", e);
        }
    }, [triggerRebalance]);

    const save = useCallback(async (urls) => {
        setCalendars(urls);
        try {
            await invoke("set_setting", { key: "calendars", value: JSON.stringify(urls) });
            if (triggerRebalance) triggerRebalance();
        } catch (e) { console.error("Failed to save calendars:", e); }
    }, [triggerRebalance]);

    const updateUrl = (i, value) => {
        const copy = [...calendars];
        copy[i] = value;
        save(copy.map(u => u.trim()).filter(u => u !== ""));
    };

    const addUrl = () => save([...calendars, ""]);

    const removeUrl = (i) => {
        const copy = [...calendars];
        copy.splice(i, 1);
        save(copy);
    };

    if (loading) return <div className="settings"><div className="drag-region" data-tauri-drag-region /></div>;

    if (subView === "training") return <Training onBack={() => setSubView(null)} />;
    if (subView === "debug") return <Debug />;

    return (
        <div className="settings">
            <div className="drag-region" data-tauri-drag-region />
            <div className="settings-main">
                <div className="settings-section settings-first-section">
                    <div className="settings-section-label">{strings.VIEWS__SETTINGS_REMOTE_SYNC}</div>
                    <div className="settings-section-hint">{strings.VIEWS__SETTINGS_REMOTE_SYNC_HINT}</div>
                    <div className="settings-cal-row">
                        <input
                            className="settings-cal-input"
                            value={remoteSyncUrl}
                            onChange={(e) => setRemoteSyncUrl(e.target.value)}
                            onBlur={(e) => saveRemoteSyncUrl(e.target.value)}
                            placeholder="postgres://user:password@host:5432/database"
                            spellCheck={false}
                            autoComplete="off"
                        />
                    </div>
                    <div className="settings-grid-row">
                        <span className="settings-grid-field-label">{strings.VIEWS__SETTINGS_REMOTE_SYNC_PERIOD}</span>
                        <input
                            className="settings-grid-input"
                            type="number"
                            min={5}
                            value={remoteSyncPeriod}
                            onChange={(e) => saveRemoteSyncPeriod(e.target.value)}
                        />
                        <span className="settings-grid-derived">{strings.VIEWS__SETTINGS_REMOTE_SYNC_SECONDS}</span>
                    </div>
                </div>

                <div className="settings-section">
                    <div className="settings-section-label">{strings.VIEWS__SETTINGS_CALENDARS}</div>
                    <div className="settings-section-hint">{strings.VIEWS__SETTINGS_CALENDARS_HINT}</div>
                    {calendars.map((url, i) => (
                        <div key={i} className="settings-cal-row">
                            <input
                                className="settings-cal-input"
                                value={url}
                                onChange={(e) => updateUrl(i, e.target.value)}
                                placeholder="https://calendar.google.com/...ical"
                                spellCheck={false}
                                autoComplete="off"
                            />
                            <span className="settings-cal-remove" onClick={() => removeUrl(i)}>
                                <i className="fa-solid fa-xmark" />
                            </span>
                        </div>
                    ))}
                    <div className="settings-cal-add-btn" onClick={addUrl}>
                        <i className="fa-solid fa-plus" />
                    </div>
                </div>

                {chunkConfig && (
                    <div className="settings-section">
                        <div className="settings-section-label">{strings.VIEWS__SETTINGS_GRID}</div>
                        <div className="settings-section-hint">{strings.VIEWS__SETTINGS_GRID_HINT}</div>

                        <div className="settings-grid-row">
                            <span className="settings-grid-field-label">{strings.VIEWS__SETTINGS_GRID_CHUNKS}</span>
                            <div className="settings-grid-chips">
                                {VALID_CHUNKS.map(v => (
                                    <div
                                        key={v}
                                        className={`settings-grid-chip${v === chunkConfig.chunks_per_day ? " active" : ""}`}
                                        onClick={() => updateChunksPerDay(v)}
                                    >
                                        {v}
                                    </div>
                                ))}
                            </div>
                            <span className="settings-grid-derived">
                                {24 / chunkConfig.chunks_per_day}h each, {(24 / chunkConfig.chunks_per_day) * 2} slots
                            </span>
                        </div>

                        <div className="settings-grid-row">
                            <span className="settings-grid-field-label">{strings.VIEWS__SETTINGS_GRID_HORIZON}</span>
                            <input
                                className="settings-grid-input"
                                type="number"
                                min={1}
                                max={60}
                                value={chunkConfig.horizon_days}
                                onChange={(e) => updateHorizon(e.target.value)}
                            />
                            <span className="settings-grid-derived">
                                = {chunkConfig.chunks_per_day * chunkConfig.horizon_days} total chunks
                            </span>
                        </div>

                        <div className="settings-grid-labels">
                            <span className="settings-grid-field-label">{strings.VIEWS__SETTINGS_GRID_LABELS}</span>
                            <div className="settings-grid-label-list">
                                {chunkConfig.labels.map((label, i) => {
                                    const hpc = 24 / chunkConfig.chunks_per_day;
                                    const startH = i * hpc;
                                    const endH = startH + hpc;
                                    return (
                                        <div key={i} className="settings-grid-label-row">
                                            <span className="settings-grid-label-time">
                                                {String(startH).padStart(2, "0")}:00–{String(endH).padStart(2, "0")}:00
                                            </span>
                                            <input
                                                className="settings-grid-label-input"
                                                value={label}
                                                onChange={(e) => updateLabel(i, e.target.value)}
                                                spellCheck={false}
                                            />
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                )}

                <div className="settings-section">
                    <div className="settings-section-label">{strings.VIEWS__SETTINGS_GLOBAL_RESCHEDULE}</div>
                    <div className="settings-section-hint">{strings.VIEWS__SETTINGS_GLOBAL_RESCHEDULE_HINT}</div>
                    <label className="settings-toggle-row">
                        <input
                            className="settings-toggle-input"
                            type="checkbox"
                            checked={rescheduleMissedScheduledTasks}
                            onChange={(e) => saveRescheduleMissedScheduledTasks(e.target.checked)}
                        />
                        <span className="settings-toggle-copy">
                            <span className="settings-toggle-label">{strings.VIEWS__SETTINGS_RESCHEDULE_MISSED_SCHEDULES}</span>
                            <span className="settings-toggle-hint">{strings.VIEWS__SETTINGS_RESCHEDULE_MISSED_SCHEDULES_HINT}</span>
                        </span>
                    </label>
                </div>

                <div className="settings-section">
                    <div className="settings-section-label">{strings.VIEWS__SETTINGS_TRAINING}</div>
                    <div className="settings-section-hint">
                        <span className="settings-cal-add" onClick={() => setSubView("training")}>{strings.VIEWS__SETTINGS_TRAINING_CTA}</span> {strings.VIEWS__SETTINGS_TRAINING_HINT}
                    </div>
                </div>

                <div className="settings-section">
                    <div className="settings-section-label">{strings.VIEWS__DEBUG_TITLE}</div>
                    <div className="settings-section-hint">
                        <span className="settings-cal-add" onClick={() => setSubView("debug")}>{strings.VIEWS__DEBUG_CTA}</span> {strings.VIEWS__DEBUG_HINT}
                    </div>
                </div>

                <div className="settings-section">
                    <div className="settings-section-label">{strings.VIEWS__SETTINGS_TUTORIAL}</div>
                    <div className="settings-section-hint">
                        <span className="settings-cal-add" onClick={onStartTour}>{strings.VIEWS__SETTINGS_TUTORIAL_CTA}</span> {strings.VIEWS__SETTINGS_TUTORIAL_HINT}
                    </div>
                </div>

                <div className="settings-section">
                    <div className="settings-logout" onClick={onLogout}>
                        <i className="fa-solid fa-person-through-window" /> {strings.TOOLTIPS.LOGOUT}
                    </div>
                </div>
            </div>
        </div>
    );
}
