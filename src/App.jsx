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
import strings from "@strings";
import "./App.css";

function RebalanceSpinner() {
    const rebalancing = useSelector(state => state.ui.rebalancing);
    if (!rebalancing) return null;
    return <div className="rebalance-spinner" />;
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
