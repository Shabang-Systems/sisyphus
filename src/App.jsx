import { useState, useEffect, useCallback, useRef } from "react";
import { Provider, useSelector, useDispatch } from "react-redux";
import { Tooltip } from "react-tooltip";
import store from "@api/store.js";
import { invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import { rebalance } from "@api/ui.js";
import { snapshot } from "@api/utils.js";
import { initSyncListener, flushNow } from "@api/sync.js";
import { remoteSyncNow, restartRemoteSyncTimer, stopRemoteSyncTimer } from "@api/remoteSync.js";
import { fetchChunkConfig } from "@api/chunkConfig.js";
import Auth from "@views/Auth.jsx";
import Editor from "@views/Editor.jsx";
import Browse from "@views/Browse.jsx";
import Action from "@views/Action.jsx";
import Completed from "@views/Completed.jsx";
import Settings from "@views/Settings.jsx";
import { useTour } from "@components/Tour.jsx";
import shortcuts from "./shortcuts.js";
import strings from "@strings";
import "./App.css";

function FullScreenOverlay({ label }) {
    const [quote] = useState(() => strings.SYNC_QUOTES[Math.floor(Math.random() * strings.SYNC_QUOTES.length)]);
    return (
        <div className="sync-overlay">
            <div className="sync-overlay-content">
                <div className="sync-overlay-boulder" />
                <div className="sync-overlay-text">
                    <div className="sync-overlay-label">{label}</div>
                    <div className="sync-overlay-quote">{quote}</div>
                </div>
            </div>
        </div>
    );
}

function LoadingOverlay() {
    const ready = useSelector(state => state.ui.ready);
    if (ready) return null;
    return <FullScreenOverlay label={strings.SYNC_LOADING} />;
}

function SyncButton() {
    const dispatch = useDispatch();
    const pending = useSelector(state => state.ui.syncPending > 0);
    const remotePending = useSelector(state => state.ui.remoteSyncPending > 0);
    const [animating, setAnimating] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const timerRef = useRef(null);
    const anyPending = pending || remotePending;

    useEffect(() => {
        if (anyPending) {
            setAnimating(true);
            if (timerRef.current) clearTimeout(timerRef.current);
        } else if (animating) {
            timerRef.current = setTimeout(() => setAnimating(false), 600);
        }
    }, [anyPending]);

    const forceSync = useCallback(async () => {
        if (syncing) return;
        setSyncing(true);
        flushNow();
        await dispatch(rebalance());
        await dispatch(snapshot());
        await remoteSyncNow();
        setSyncing(false);
    }, [dispatch, syncing]);

    return (
        <>
            <div className="sync-dot-wrap" onClick={forceSync}>
                {animating && <div className={`sync-dot-pulse${remotePending && !pending ? " remote" : ""}`} />}
                <div className="sync-dot-idle" />
            </div>
            {syncing && <FullScreenOverlay label={strings.SYNC_RESCHEDULING} />}
        </>
    );
}

// Global hook: idle-debounced rebalance trigger.
// Resets on every call. Only fires after 5s of inactivity — long enough that
// typing a new task or editing text won't trigger mid-composition, but short
// enough that pausing to think will pick up changes.
function useRebalance() {
    const dispatch = useDispatch();
    const timerRef = useRef(null);

    return useCallback(() => {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => dispatch(rebalance()), 5000);
    }, [dispatch]);
}

function Sidebar({ activeView, onViewChange }) {
    return (
        <div className="bottom-nav">
            <div
                className={"bottom-nav-button" + (activeView === "action" ? " active" : "")}
                onClick={() => onViewChange("action")}
                data-tooltip-id="rootp"
                data-tooltip-content={strings.TOOLTIPS.ACTION}
            >
                <i className="fa-solid fa-people-pulling"></i>
            </div>
            <div
                className={"bottom-nav-button" + (activeView === "editor" ? " active" : "")}
                onClick={() => onViewChange("editor")}
                data-tooltip-id="rootp"
                data-tooltip-content={strings.TOOLTIPS.PLANNING}
            >
                <i className="fa-solid fa-child-reaching"></i>
            </div>
            <div
                className={"bottom-nav-button" + (activeView === "browse" ? " active" : "")}
                onClick={() => onViewChange("browse")}
                data-tooltip-id="rootp"
                data-tooltip-content={strings.TOOLTIPS.BROWSE}
            >
                <i className="fa-solid fa-person-hiking"></i>
            </div>
            <div
                className={"bottom-nav-button" + (activeView === "completed" ? " active" : "")}
                onClick={() => onViewChange("completed")}
                data-tooltip-id="rootp"
                data-tooltip-content={strings.TOOLTIPS.COMPLETED}
            >
                <i className="fa-solid fa-user-graduate"></i>
            </div>
            <div
                className={"bottom-nav-button" + (activeView === "settings" ? " active" : "")}
                onClick={() => onViewChange("settings")}
                data-tooltip-id="rootp"
                data-tooltip-content={strings.TOOLTIPS.SETTINGS}
            >
                <i className="fa-solid fa-gear"></i>
            </div>
        </div>
    );
}

function AppInner() {
    const triggerRebalance = useRebalance();
    const [isReady, setIsReady] = useState(false);

    // Initialize background sync listener (Tauri events from Rust)
    useEffect(() => { initSyncListener(); }, []);
    useEffect(() => () => stopRemoteSyncTimer(), []);
    const [activeView, setActiveView] = useState("action");
    const [jumpToTaskId, setJumpToTaskId] = useState(null);

    const [replyToTaskId, setReplyToTaskId] = useState(null);
    const tour = useTour({ onViewChange: setActiveView });

    const views = ["action", "editor", "browse", "completed", "settings"];

    useEffect(() => {
        function matchShortcut(e, shortcut) {
            const parts = shortcut.split("+");
            const key = parts[parts.length - 1].toLowerCase();
            const needsMod = parts.includes("mod");
            const needsShift = parts.includes("shift");
            const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);
            const mod = isMac ? e.metaKey : e.ctrlKey;
            return mod === needsMod && e.shiftKey === needsShift && e.key.toLowerCase() === key;
        }

        function onKeyDown(e) {
            const navShortcuts = [shortcuts.NAV_1, shortcuts.NAV_2, shortcuts.NAV_3, shortcuts.NAV_4, shortcuts.NAV_5];
            for (let i = 0; i < navShortcuts.length; i++) {
                if (matchShortcut(e, navShortcuts[i])) {
                    e.preventDefault();
                    e.stopPropagation();
                    setActiveView(views[i]);
                    return;
                }
            }
        }

        document.addEventListener("keydown", onKeyDown, true);
        return () => document.removeEventListener("keydown", onKeyDown, true);
    }, []);

    // Jump to a task in Planning view from any page
    const jumpToTask = useCallback((taskId) => {
        setJumpToTaskId(taskId);
        setReplyToTaskId(taskId);
        setActiveView("editor");
    }, []);

    useEffect(() => {
        let workspace = localStorage.getItem("sisyphus__workspace");
        if (workspace) {
            (async () => {
                let success = await invoke("load", { path: workspace });
                if (success) {
                    fetchChunkConfig(); // warm cache before views mount
                    restartRemoteSyncTimer();
                    setIsReady(true);
                }
            })();
        }
    }, []);

    const auth = useCallback((path) => {
        localStorage.setItem("sisyphus__workspace", path);
        fetchChunkConfig(); // warm cache before views mount
        restartRemoteSyncTimer();
        setIsReady(true);
    }, []);

    const logout = useCallback(async () => {
        const ok = await confirm(strings.VIEWS__AUTH_LOGOUT_CONFIRM, {
            title: strings.TOOLTIPS.LOGOUT,
            kind: "warning",
        });
        if (ok) {
            localStorage.removeItem("sisyphus__workspace");
            stopRemoteSyncTimer();
            setIsReady(false);
        }
    }, []);

    return (
        <>
            <Tooltip id="rootp" anchorSelect="[data-tooltip-id='rootp']" delayShow={600} delayHide={0} />
            {isReady ? (
                <>
                    <Sidebar activeView={activeView} onViewChange={setActiveView} />
                    <SyncButton />
                    <LoadingOverlay />
                    {activeView === "action" && <Action onJumpToTask={jumpToTask} triggerRebalance={triggerRebalance} onViewChange={setActiveView} />}
                    {activeView === "editor" && <Editor jumpToTaskId={jumpToTaskId} replyToTaskId={replyToTaskId} onJumpHandled={() => { setJumpToTaskId(null); setReplyToTaskId(null); }} triggerRebalance={triggerRebalance} />}
                    {activeView === "browse" && <Browse onJumpToTask={jumpToTask} />}
                    {activeView === "completed" && <Completed />}
                    {activeView === "settings" && <Settings onLogout={logout} triggerRebalance={triggerRebalance} onStartTour={() => tour.start()} />}
                </>
            ) : (
                <Auth onAuth={auth} />
            )}
        </>
    );
}

function App() {
    return (
        <Provider store={store}>
            <AppInner />
        </Provider>
    );
}

export default App;
