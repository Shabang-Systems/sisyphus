import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCachedChunkConfig, fetchChunkConfig, setChunkConfigCache } from "@api/chunkConfig.js";
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
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        (async () => {
            try {
                const val = await invoke("get_setting", { key: "calendars" });
                if (val) setCalendars(JSON.parse(val));
            } catch {}
            try {
                const cfg = await fetchChunkConfig();
                setChunkConfig(cfg);
            } catch {}
            setLoading(false);
        })();
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

    const save = useCallback(async (urls) => {
        setCalendars(urls);
        try {
            await invoke("set_setting", { key: "calendars", value: JSON.stringify(urls) });
            if (triggerRebalance) triggerRebalance();
        } catch (e) { console.error("Failed to save calendars:", e); }
    }, []);

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
