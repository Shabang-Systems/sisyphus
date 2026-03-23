import { useState, useEffect, useCallback, useRef } from "react";
import { Provider, useSelector, useDispatch } from "react-redux";
import { Tooltip } from "react-tooltip";
import store from "@api/store.js";
import { invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import { rebalance } from "@api/ui.js";
import Auth from "@views/Auth.jsx";
import Editor from "@views/Editor.jsx";
import Browse from "@views/Browse.jsx";
import Action from "@views/Action.jsx";
import Completed from "@views/Completed.jsx";
import Settings from "@views/Settings.jsx";
import Debug from "@views/Debug.jsx";
import strings from "@strings";
import "./App.css";

function RebalanceSpinner() {
    const rebalancing = useSelector(state => state.ui.rebalancing);
    if (!rebalancing) return null;
    return <div className="rebalance-spinner" />;
}

// Global hook: debounced rebalance trigger
// Defers execution if editor is focused at fire time; retries after blur
function useRebalance() {
    const dispatch = useDispatch();
    const timerRef = useRef(null);
    const pendingRef = useRef(false);

    const tryFire = useCallback(() => {
        const active = document.activeElement;
        const inEditor = active?.closest?.(".ProseMirror");
        if (inEditor) {
            pendingRef.current = true;
            return;
        }
        pendingRef.current = false;
        dispatch(rebalance());
    }, [dispatch]);

    useEffect(() => {
        const onBlur = () => {
            if (pendingRef.current) {
                setTimeout(tryFire, 500);
            }
        };
        document.addEventListener("focusout", onBlur);
        return () => document.removeEventListener("focusout", onBlur);
    }, [tryFire]);

    return useCallback(() => {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(tryFire, 1500);
    }, [tryFire]);
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
                className={"bottom-nav-button" + (activeView === "debug" ? " active" : "")}
                onClick={() => onViewChange("debug")}
                data-tooltip-id="rootp"
                data-tooltip-content={strings.TOOLTIPS.DEBUG}
            >
                <i className="fa-solid fa-user-ninja"></i>
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
    const [activeView, setActiveView] = useState("action");
    const [jumpToTaskId, setJumpToTaskId] = useState(null);

    const [replyToTaskId, setReplyToTaskId] = useState(null);

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
                if (success) setIsReady(true);
            })();
        }
    }, []);

    const auth = useCallback((path) => {
        localStorage.setItem("sisyphus__workspace", path);
        setIsReady(true);
    }, []);

    const logout = useCallback(async () => {
        const ok = await confirm(strings.VIEWS__AUTH_LOGOUT_CONFIRM, {
            title: strings.TOOLTIPS.LOGOUT,
            kind: "warning",
        });
        if (ok) {
            localStorage.removeItem("sisyphus__workspace");
            setIsReady(false);
        }
    }, []);

    return (
        <>
            <Tooltip id="rootp" anchorSelect="[data-tooltip-id='rootp']" delayShow={0} delayHide={0} />
            {isReady ? (
                <>
                    <Sidebar activeView={activeView} onViewChange={setActiveView} />
                    <RebalanceSpinner />
                    {activeView === "action" && <Action onJumpToTask={jumpToTask} triggerRebalance={triggerRebalance} />}
                    {activeView === "editor" && <Editor jumpToTaskId={jumpToTaskId} replyToTaskId={replyToTaskId} onJumpHandled={() => { setJumpToTaskId(null); setReplyToTaskId(null); }} triggerRebalance={triggerRebalance} />}
                    {activeView === "browse" && <Browse onJumpToTask={jumpToTask} />}
                    {activeView === "completed" && <Completed />}
                    {activeView === "settings" && <Settings onLogout={logout} triggerRebalance={triggerRebalance} />}
                    {activeView === "debug" && <Debug />}
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
