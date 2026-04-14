import strings from "@strings";
import "./Auth.css";

import { open, save, message } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { useCallback } from "react";

function getGreeting() {
    let time = new Date();
    if (time.getHours() < 12) {
        return strings.TEMPORAL_GREETINGS[0];
    } else if (time.getHours() < 19) {
        return strings.TEMPORAL_GREETINGS[1];
    } else {
        return strings.TEMPORAL_GREETINGS[2];
    }
}

export default function Auth({ onAuth }) {
    const greeting = getGreeting();

    const openDb = useCallback(async () => {
        let res = await open({
            filters: [{
                name: "sisyphus",
                extensions: ['db']
            }],
            multiple: false,
        });

        if (res) {
            let success = await invoke("load", { path: res });
            if (success) {
                onAuth(res);
            } else {
                await message(strings.VIEWS__AUTH_MALFORM_SUBHEAD, {
                    title: strings.VIEWS__AUTH_MALFORM_HEAD, type: 'error'
                });
            }
        }
    });

    const createDb = useCallback(async () => {
        let res = await save({
            filters: [{
                name: "sisyphus",
                extensions: ['db']
            }],
        });
        if (res) {
            await invoke("bootstrap", { path: res });
            onAuth(res);
        }
    });

    return (
        <div className="auth">
            <div className="auth-content">
                <div className="auth-head">
                    <span>{greeting}</span>{strings.VIEWS__AUTH_WELCOME}
                </div>
                <br />
                <div className="auth-subhead">{strings.VIEWS__AUTH_HAPPY}</div>
                <div className="auth-subhead">
                    {strings.VIEWS__AUTH_PLEASE}
                    <div onClick={openDb} className="button-inline">{strings.VIEWS__AUTH_SELECT}</div>
                    {" or "}
                    <div onClick={createDb} className="button-inline">{strings.VIEWS__AUTH_CREATE}</div>
                    {strings.VIEWS__AUTH_WORKSPACE}.
                </div>
                <div className="auth-subhead data">{strings.VIEWS__AUTH_DATA}</div>
                <br />
                <div className="copyright">
                    &copy;{(new Date()).getFullYear()} Adams Research. All rights reserved.
                </div>
            </div>
        </div>
    );
}
