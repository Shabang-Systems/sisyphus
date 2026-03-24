import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import strings from "@strings";
import Training from "@views/Training.jsx";
import Debug from "@views/Debug.jsx";
import "./Settings.css";

export default function Settings({ onLogout, triggerRebalance }) {
    const [subView, setSubView] = useState(null); // "training" | "debug" | null
    const [calendars, setCalendars] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        (async () => {
            try {
                const val = await invoke("get_setting", { key: "calendars" });
                if (val) setCalendars(JSON.parse(val));
            } catch {}
            setLoading(false);
        })();
    }, []);

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
                <div className="settings-greeting">{strings.VIEWS__SETTINGS_TITLE}</div>

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
                    <div className="settings-cal-add" onClick={addUrl}>
                        <i className="fa-solid fa-plus" /> {strings.VIEWS__SETTINGS_ADD_CALENDAR}
                    </div>
                </div>

                <div className="settings-section">
                    <div className="settings-section-label">{strings.VIEWS__SETTINGS_TRAINING}</div>
                    <div className="settings-section-hint">{strings.VIEWS__SETTINGS_TRAINING_HINT}</div>
                    <div className="settings-cal-add" onClick={() => setSubView("training")}>
                        <i className="fa-solid fa-flask" /> {strings.VIEWS__SETTINGS_OPEN_TRAINING}
                    </div>
                </div>

                <div className="settings-section">
                    <div className="settings-section-label">{strings.VIEWS__DEBUG_TITLE}</div>
                    <div className="settings-cal-add" onClick={() => setSubView("debug")}>
                        <i className="fa-solid fa-user-ninja" /> {strings.VIEWS__DEBUG_TITLE.toLowerCase()}
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
