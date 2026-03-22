import { useState, useEffect, useCallback } from "react";
import { Provider } from "react-redux";
import { Tooltip } from "react-tooltip";
import store from "@api/store.js";
import { invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import Auth from "@views/Auth.jsx";
import Editor from "@views/Editor.jsx";
import strings from "@strings";
import "./App.css";

function Sidebar({ activeView, onViewChange, onLogout }) {
    return (
        <div className="bottom-nav">
            <div
                className={"bottom-nav-button" + (activeView === "editor" ? " active" : "")}
                onClick={() => onViewChange("editor")}
                data-tooltip-id="rootp"
                data-tooltip-content={strings.TOOLTIPS.ACTION}
            >
                <i className="fa-solid fa-person"></i>
            </div>
            <div
                className="bottom-nav-button"
                onClick={onLogout}
                data-tooltip-id="rootp"
                data-tooltip-content={strings.TOOLTIPS.LOGOUT}
            >
                <i className="fa-solid fa-person-through-window"></i>
            </div>
        </div>
    );
}

function App() {
    const [isReady, setIsReady] = useState(false);
    const [activeView, setActiveView] = useState("editor");

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
        <Provider store={store}>
            <Tooltip id="rootp" anchorSelect="[data-tooltip-id='rootp']" delayShow={300} delayHide={100} />
            {isReady ? (
                <>
                    <Sidebar activeView={activeView} onViewChange={setActiveView} onLogout={logout} />
                    <Editor />
                </>
            ) : (
                <Auth onAuth={auth} />
            )}
        </Provider>
    );
}

export default App;
