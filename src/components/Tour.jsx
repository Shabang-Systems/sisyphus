import { useMemo } from "react";
import Shepherd from "shepherd.js";
import "shepherd.js/dist/css/shepherd.css";
import "./Tour.css";
import strings from "@strings";

const btn = (text, action, secondary) => ({
    text,
    action,
    classes: secondary ? "sisyphus-tour-btn-secondary" : "sisyphus-tour-btn",
});

export function useTour({ onViewChange }) {
    const tour = useMemo(() => {
        const t = new Shepherd.Tour({
            useModalOverlay: true,
            defaultStepOptions: {
                classes: "sisyphus-tour-step",
                scrollTo: false,
                cancelIcon: { enabled: true },
                modalOverlayOpeningPadding: 4,
                modalOverlayOpeningRadius: 4,
            },
        });

        const next = (view) => () => { if (view) onViewChange(view); t.next(); };
        const back = () => t.back();

        t.addSteps([
            // Welcome
            {
                id: "welcome",
                text: strings.TOUR__WELCOME,
                buttons: [btn(strings.TOUR__NEXT, next("editor"))],
            },

            // Planning — nav button
            {
                id: "planning-nav",
                text: strings.TOUR__PLANNING_NAV,
                attachTo: { element: ".bottom-nav-button:nth-child(2)", on: "right" },
                buttons: [btn(strings.TOUR__BACK, back, true), btn(strings.TOUR__NEXT, next())],
            },

            // Planning — editor area
            {
                id: "planning-editor",
                text: strings.TOUR__PLANNING_EDITOR,
                attachTo: { element: ".tiptap", on: "bottom" },
                buttons: [btn(strings.TOUR__BACK, back, true), btn(strings.TOUR__NEXT, next())],
            },

            // Task checkbox
            {
                id: "task-check",
                text: strings.TOUR__TASK_CHECK,
                attachTo: { element: ".task-check", on: "right" },
                buttons: [btn(strings.TOUR__BACK, back, true), btn(strings.TOUR__NEXT, next())],
            },

            // Task toolbar
            {
                id: "task-toolbar",
                text: strings.TOUR__TASK_TOOLBAR,
                attachTo: { element: ".task-toolbar", on: "bottom" },
                buttons: [btn(strings.TOUR__BACK, back, true), btn(strings.TOUR__NEXT, next())],
            },

            // Due date button
            {
                id: "task-due",
                text: strings.TOUR__TASK_DUE,
                attachTo: { element: ".task-due-btn", on: "bottom" },
                buttons: [btn(strings.TOUR__BACK, back, true), btn(strings.TOUR__NEXT, next())],
            },

            // Effort button
            {
                id: "task-effort",
                text: strings.TOUR__TASK_EFFORT,
                attachTo: { element: ".task-effort-btn", on: "bottom" },
                buttons: [btn(strings.TOUR__BACK, back, true), btn(strings.TOUR__NEXT, next())],
            },

            // Repeat button
            {
                id: "task-repeat",
                text: strings.TOUR__TASK_REPEAT,
                attachTo: { element: ".task-rrule-btn", on: "bottom" },
                buttons: [btn(strings.TOUR__BACK, back, true), btn(strings.TOUR__NEXT, next())],
            },

            // Reply button
            {
                id: "task-reply",
                text: strings.TOUR__TASK_REPLY,
                attachTo: { element: ".task-reply-btn", on: "bottom" },
                buttons: [btn(strings.TOUR__BACK, back, true), btn(strings.TOUR__NEXT, next())],
            },

            // Focus button
            {
                id: "task-focus",
                text: strings.TOUR__TASK_FOCUS,
                attachTo: { element: ".task-collapse-btn", on: "bottom" },
                buttons: [btn(strings.TOUR__BACK, back, true), btn(strings.TOUR__NEXT, next("action"))],
            },

            // Action — nav button
            {
                id: "action-nav",
                text: strings.TOUR__ACTION_NAV,
                attachTo: { element: ".bottom-nav-button:nth-child(1)", on: "right" },
                buttons: [btn(strings.TOUR__BACK, back, true), btn(strings.TOUR__NEXT, next())],
            },

            // Action — main view
            {
                id: "action-view",
                text: strings.TOUR__ACTION_VIEW,
                attachTo: { element: ".action-main", on: "left" },
                buttons: [btn(strings.TOUR__BACK, back, true), btn(strings.TOUR__NEXT, next("browse"))],
            },

            // Browse
            {
                id: "browse-nav",
                text: strings.TOUR__BROWSE_NAV,
                attachTo: { element: ".bottom-nav-button:nth-child(3)", on: "right" },
                buttons: [btn(strings.TOUR__BACK, back, true), btn(strings.TOUR__NEXT, next("completed"))],
            },

            // Completed
            {
                id: "completed-nav",
                text: strings.TOUR__COMPLETED_NAV,
                attachTo: { element: ".bottom-nav-button:nth-child(4)", on: "right" },
                buttons: [btn(strings.TOUR__BACK, back, true), btn(strings.TOUR__NEXT, next("settings"))],
            },

            // Settings
            {
                id: "settings-nav",
                text: strings.TOUR__SETTINGS_NAV,
                attachTo: { element: ".bottom-nav-button:nth-child(5)", on: "right" },
                buttons: [btn(strings.TOUR__BACK, back, true), btn(strings.TOUR__NEXT, next())],
            },

            // Sync dot
            {
                id: "sync",
                text: strings.TOUR__SYNC,
                attachTo: { element: ".sync-dot-wrap", on: "bottom" },
                buttons: [btn(strings.TOUR__BACK, back, true), btn(strings.TOUR__NEXT, next())],
            },

            // Done
            {
                id: "done",
                text: strings.TOUR__DONE_MSG,
                buttons: [btn(strings.TOUR__DONE, () => t.complete())],
            },
        ]);

        return t;
    }, []);

    return tour;
}
