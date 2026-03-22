import { useEffect, useCallback, useRef, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { useEditor, EditorContent, ReactRenderer } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Node, mergeAttributes } from "@tiptap/core";
import { Fragment } from "@tiptap/pm/model";
import { RRule } from "rrule";
import moment from "moment";
import { snapshot } from "@api/utils.js";
import { tick } from "@api/ui.js";
import { upsert, remove, setParent } from "@api/tasks.js";
import { v4 as uuid } from "uuid";
import { invoke } from "@tauri-apps/api/core";
import { Tag, extractTags } from "@components/TagExtension.js";
import TagSuggestion from "@components/TagSuggestion.jsx";
import ReplyArrows from "@components/ReplyArrows.jsx";
import DateModal from "@components/DateModal.jsx";
import shortcuts from "../shortcuts.js";
import RRuleModal from "@components/RRuleModal.jsx";
import strings from "@strings";
import "./Editor.css";

// --- Node ---

const TaskParagraph = Node.create({
    name: "paragraph",
    priority: 1000,
    group: "block",
    content: "inline*",
    addAttributes() {
        return { taskId: { default: null, rendered: false } };
    },
    parseHTML() { return [{ tag: "p" }]; },
    renderHTML({ node, HTMLAttributes }) {
        const id = node.attrs.taskId || "";
        return [
            "div", { class: "task-block", "data-task-id": id },
            ["div", { class: "task-divider", contenteditable: "false", draggable: "false" },
                ["div", { class: "task-divider-line" }]],
            ["div", { class: "task-row" },
                ["span", { class: "task-drag-handle", contenteditable: "false" },
                    ["i", { class: "fa-solid fa-grip-vertical" }]],
                ["span", { class: "task-check task-sidebar-btn", contenteditable: "false" },
                    ["i", { class: "fa-solid fa-check" }]],
                ["p", mergeAttributes(HTMLAttributes), 0],
                ["div", { class: "task-toolbar", contenteditable: "false" },
                    ["span", { class: "task-sidebar-btn task-start-btn" },
                        ["i", { class: "fa-solid fa-hourglass-start" }]],
                    ["span", { class: "task-sidebar-btn task-due-btn" },
                        ["i", { class: "fa-solid fa-hourglass-end" }]],
                    ["span", { class: "task-sidebar-btn task-rrule-btn" },
                        ["i", { class: "fa-solid fa-rotate" }]],
                    ["span", { class: "task-sidebar-btn task-collapse-btn" },
                        ["i", { class: "fa-solid fa-compress" }]],
                    ["span", { class: "task-sidebar-btn task-reply-btn" },
                        ["i", { class: "fa-solid fa-angles-left" }]]]],
        ];
    },
});

function serializeContent(node) {
    const json = node.toJSON();
    if (json.attrs) {
        const { taskId, ...rest } = json.attrs;
        json.attrs = Object.keys(rest).length ? rest : undefined;
    }
    return JSON.stringify(json);
}

function now() {
    return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function readDoc(doc) {
    const rows = [];
    let idx = 0;
    doc.descendants((node, pmPos) => {
        if (node.type.name !== "paragraph") return false;
        const content = serializeContent(node);
        rows.push({ taskId: node.attrs.taskId, content, tags: JSON.stringify(extractTags(content)), position: idx, pmPos });
        idx++;
        return false;
    });
    return rows;
}

function dedup(rows) {
    const seen = new Set();
    for (const row of rows) {
        if (row.taskId) {
            if (seen.has(row.taskId)) row.taskId = null;
            else seen.add(row.taskId);
        }
    }
}

function getSubtree(tasks, focusId) {
    const byId = new Map(tasks.map(t => [t.id, t]));
    const ids = new Set([focusId]);
    let cur = byId.get(focusId);
    while (cur?.parent_id) { ids.add(cur.parent_id); cur = byId.get(cur.parent_id); }
    let changed = true;
    while (changed) {
        changed = false;
        for (const t of tasks) {
            if (t.parent_id && ids.has(t.parent_id) && !ids.has(t.id)) { ids.add(t.id); changed = true; }
        }
    }
    return ids;
}

// Cascading deferral: a task is deferred if it or any ancestor has start_date > now
function isDeferred(task, byId, nowDate, visited = new Set()) {
    if (visited.has(task.id)) return false;
    visited.add(task.id);
    if (task.start_date && new Date(task.start_date) > nowDate) return true;
    if (task.parent_id) {
        const parent = byId.get(task.parent_id);
        if (parent) return isDeferred(parent, byId, nowDate, visited);
    }
    return false;
}

// --- Component ---

export default function Editor() {
    const dispatch = useDispatch();
    const tasks = useSelector(state => state.tasks.db);
    const loading = useSelector(state => state.tasks.loading);
    const clock = useSelector(state => state.ui.clock);

    // Tick every 5 seconds — only updates ui.clock, doesn't touch editor/modals
    useEffect(() => {
        const interval = setInterval(() => dispatch(tick()), 5000);
        return () => clearInterval(interval);
    }, [dispatch]);
    const [collapsedRoot, setCollapsedRoot] = useState(null);
    const [dateModal, setDateModal] = useState(null);   // { taskId, field }
    const [rruleModal, setRruleModal] = useState(null);  // { taskId }

    const suppress = useRef(false);
    const guard = useRef(false);
    const hydrated = useRef(false);
    const visible = useRef(new Map());
    const updateTimer = useRef(null);
    const pendingParentId = useRef(null);
    const pendingRruleData = useRef(null);  // { rrule, tags, parent_id, start_date, due_date }
    const collapsedRootRef = useRef(null);
    const tasksRef = useRef(tasks);
    const dragState = useRef({ dragging: null, over: null });

    useEffect(() => { collapsedRootRef.current = collapsedRoot; }, [collapsedRoot]);
    useEffect(() => { tasksRef.current = tasks; }, [tasks]);
    useEffect(() => { dispatch(snapshot()); }, [dispatch]);

    // --- Pipeline ---

    const runPipeline = useCallback((editor) => {
        if (suppress.current || guard.current) return;

        const rows = readDoc(editor.state.doc);
        const ts = now();
        dedup(rows);

        const needsId = rows.filter(r => !r.taskId);
        if (needsId.length > 0) {
            let tr = editor.state.tr;
            for (const row of needsId) {
                const id = uuid();
                row.taskId = id;
                tr.setNodeMarkup(row.pmPos, undefined, { taskId: id });

                let parentId = pendingParentId.current;
                pendingParentId.current = null;

                // In focus mode, auto-set parent to the task above this new one
                if (collapsedRootRef.current && !parentId) {
                    const prevRow = rows[row.position - 1];
                    parentId = prevRow?.taskId || collapsedRootRef.current;
                }
                const rruleData = pendingRruleData.current;
                pendingRruleData.current = null;
                dispatch(upsert({
                    id, content: row.content, position: row.position,
                    tags: rruleData?.tags || row.tags,
                    parent_id: rruleData?.parent_id || parentId,
                    start_date: rruleData?.start_date,
                    due_date: rruleData?.due_date,
                    rrule: rruleData?.rrule,
                    created_at: ts, updated_at: ts,
                }));
                visible.current.set(id, { content: row.content, position: row.position, created_at: ts });
            }
            tr.setMeta("sync", true);
            guard.current = true;
            editor.view.dispatch(tr);
            guard.current = false;
        }

        const currentIds = new Set(rows.map(r => r.taskId));
        for (const [id] of visible.current) {
            if (!currentIds.has(id)) { dispatch(remove(id)); visible.current.delete(id); }
        }

        if (updateTimer.current) clearTimeout(updateTimer.current);
        updateTimer.current = setTimeout(() => {
            const fresh = readDoc(editor.state.doc);
            dedup(fresh);
            const ts2 = now();
            for (const row of fresh) {
                if (!row.taskId) continue;
                const prev = visible.current.get(row.taskId);
                if (!prev) continue;
                if (prev.content !== row.content || prev.position !== row.position) {
                    // Preserve scheduling fields from Redux
                    const existing = tasksRef.current.find(t => t.id === row.taskId);
                    dispatch(upsert({
                        id: row.taskId, content: row.content, position: row.position,
                        tags: row.tags, created_at: prev.created_at, updated_at: ts2,
                        parent_id: existing?.parent_id,
                        start_date: existing?.start_date, due_date: existing?.due_date,
                        completed_at: existing?.completed_at, rrule: existing?.rrule,
                    }));
                    visible.current.set(row.taskId, { content: row.content, position: row.position, created_at: prev.created_at });
                }
            }
        }, 300);
    }, [dispatch]);

    useEffect(() => () => { if (updateTimer.current) clearTimeout(updateTimer.current); }, []);

    // --- Scheduling styles (injected stylesheet) ---

    useEffect(() => {
        let style = document.getElementById("sisyphus-schedule-style");
        if (!style) {
            style = document.createElement("style");
            style.id = "sisyphus-schedule-style";
            document.head.appendChild(style);
        }

        const nowDate = new Date();
        const byId = new Map(tasks.map(t => [t.id, t]));
        const rules = [];

        for (const task of tasks) {
            const sel = `.task-block[data-task-id="${task.id}"]`;

            if (task.completed_at) {
                rules.push(`${sel} .task-row p { text-decoration: line-through; opacity: 0.4; }`);
                rules.push(`${sel} .task-check { color: var(--green) !important; }`);
            } else if (isDeferred(task, byId, nowDate)) {
                rules.push(`${sel} .task-row p { opacity: 0.3; }`);
            } else if (task.due_date) {
                const hoursLeft = (new Date(task.due_date) - nowDate) / 3600000;
                if (hoursLeft < 0) {
                    rules.push(`${sel} .task-row p { color: var(--red); }`);
                } else if (hoursLeft < 24) {
                    rules.push(`${sel} .task-row p { color: var(--orange); }`);
                }
            }

            // Tint active toolbar buttons
            if (task.start_date) rules.push(`${sel} .task-start-btn { color: var(--blue) !important; }`);
            if (task.due_date) rules.push(`${sel} .task-due-btn { color: var(--orange) !important; }`);
            if (task.rrule) rules.push(`${sel} .task-rrule-btn { color: var(--blue) !important; }`);

            // Due date label (right-aligned, hidden on hover when toolbar shows)
            if (task.due_date && !task.completed_at) {
                const due = moment(task.due_date);
                const daysAway = due.diff(moment(), "days", true);
                let dueLabel;
                if (daysAway < -1) dueLabel = due.fromNow();                  // "2 days ago"
                else if (daysAway < 0) dueLabel = "overdue";
                else if (daysAway < 1) dueLabel = due.fromNow();              // "in 3 hours"
                else if (daysAway < 7) dueLabel = due.format("dddd, h:mm a");       // "Saturday, 3:00 pm"
                else dueLabel = due.format("dddd, MMMM D, h:mm a");                 // "Friday, May 22, 3:00 pm"
                const escaped = dueLabel.replace(/"/g, '\\"');
                rules.push(`${sel} .task-row p::after { content: "${escaped}"; position: absolute; right: 8px; top: 50%; transform: translateY(-50%); font-size: 11px; color: var(--gray-3); pointer-events: none; white-space: nowrap; }`);
                rules.push(`${sel}:hover .task-row p::after { display: none; }`);
            }
        }

        style.textContent = rules.join("\n");
        return () => { style.textContent = ""; };
    }, [tasks, clock]);

    // --- Collapse styles ---

    useEffect(() => {
        let style = document.getElementById("sisyphus-collapse-style");
        if (!style) {
            style = document.createElement("style");
            style.id = "sisyphus-collapse-style";
            document.head.appendChild(style);
        }
        if (!collapsedRoot) { style.textContent = ""; return; }

        const visibleIds = getSubtree(tasks, collapsedRoot);
        const hiddenIds = tasks.map(t => t.id).filter(id => !visibleIds.has(id));
        if (!hiddenIds.length) { style.textContent = ""; return; }

        const selectors = hiddenIds.map(id => `.task-block[data-task-id="${id}"]`).join(",\n");
        style.textContent = `${selectors} { display: none !important; }\n.task-collapse-btn { display: none !important; }`;
        return () => { style.textContent = ""; };
    }, [collapsedRoot, tasks]);

    // --- Editor ---

    const editor = useEditor({
        extensions: [
            StarterKit.configure({
                paragraph: false, heading: false, codeBlock: false,
                blockquote: false, horizontalRule: false,
                bulletList: false, orderedList: false, listItem: false,
            }),
            TaskParagraph,
            Tag.configure({
                suggestion: {
                    char: "@", allowSpaces: false,
                    command: ({ editor, range, props }) => {
                        editor.chain().focus().insertContentAt(range, [
                            { type: "tag", attrs: { id: props.id } },
                            { type: "text", text: " " },
                        ]).run();
                    },
                    items: async ({ query }) => {
                        if (!query) return [];
                        try {
                            const all = await invoke("list_tags");
                            return all.filter(t => t.toLowerCase().includes(query.toLowerCase())).slice(0, 8);
                        } catch { return []; }
                    },
                    render: () => {
                        let component, popup;
                        return {
                            onStart: (props) => {
                                component = new ReactRenderer(TagSuggestion, { props, editor: props.editor });
                                popup = document.createElement("div");
                                popup.style.position = "absolute";
                                popup.style.zIndex = "30000";
                                popup.appendChild(component.element);
                                document.body.appendChild(popup);
                                const rect = props.clientRect?.();
                                if (rect) { popup.style.left = rect.left + "px"; popup.style.top = rect.bottom + 4 + "px"; }
                            },
                            onUpdate: (props) => {
                                component?.updateProps(props);
                                const rect = props.clientRect?.();
                                if (rect && popup) { popup.style.left = rect.left + "px"; popup.style.top = rect.bottom + 4 + "px"; }
                            },
                            onKeyDown: (props) => component?.ref?.onKeyDown(props),
                            onExit: () => { component?.destroy(); popup?.remove(); },
                        };
                    },
                },
            }),
            Placeholder.configure({ placeholder: strings.VIEWS__EDITOR_PLACEHOLDER }),
        ],
        content: "",
        onUpdate: ({ editor, transaction }) => {
            if (transaction.getMeta("sync")) return;
            runPipeline(editor);
        },
        onSelectionUpdate: ({ editor }) => {
            const { from, to } = editor.state.selection;
            const docSize = editor.state.doc.content.size;
            const isAll = from === 0 && to === docSize;
            const el = editor.view.dom;
            el.querySelectorAll(".task-block").forEach(b => b.classList.toggle("all-selected", isAll));

            try {
                const resolved = editor.state.doc.resolve(from);
                if (resolved.index(0) === editor.state.doc.childCount - 1) {
                    const coords = editor.view.coordsAtPos(from);
                    const container = document.querySelector(".editor-content");
                    if (coords && container) {
                        const containerRect = container.getBoundingClientRect();
                        const cursorY = coords.top - containerRect.top + container.scrollTop;
                        const target = cursorY - container.clientHeight * 0.4;
                        const start = container.scrollTop;
                        const diff = target - start;
                        if (Math.abs(diff) < 5) return;
                        const duration = 250;
                        const startTime = performance.now();
                        function step(t) {
                            const p = Math.min((t - startTime) / duration, 1);
                            const ease = p < 0.5 ? 2 * p * p : -1 + (4 - 2 * p) * p;
                            container.scrollTop = start + diff * ease;
                            if (p < 1) requestAnimationFrame(step);
                        }
                        requestAnimationFrame(step);
                    }
                }
            } catch {}
        },
    });

    // --- Manual drag-to-reorder ---

    useEffect(() => {
        if (!editor) return;
        const el = editor.view.dom;

        let dragStyle = document.getElementById("sisyphus-drag-style");
        if (!dragStyle) {
            dragStyle = document.createElement("style");
            dragStyle.id = "sisyphus-drag-style";
            document.head.appendChild(dragStyle);
        }

        function updateDragStyle() {
            const { dragging, over } = dragState.current;
            if (!dragging) { dragStyle.textContent = ""; return; }
            const rules = [];
            rules.push(`.task-block[data-task-id="${dragging}"] { opacity: 0.3; }`);
            if (over) {
                rules.push(`.task-block[data-task-id="${over.id}"] .task-divider-line { border-top-color: var(--blue) !important; border-top-style: solid !important; opacity: 1 !important; }`);
            }
            dragStyle.textContent = rules.join("\n");
        }

        function onMouseDown(e) {
            const handle = e.target.closest(".task-drag-handle");
            if (!handle) return;
            const block = handle.closest(".task-block");
            if (!block) return;
            e.preventDefault();

            dragState.current.dragging = block.getAttribute("data-task-id");
            document.body.style.cursor = "grabbing";
            updateDragStyle();
        }

        function onMouseMove(e) {
            if (!dragState.current.dragging) return;
            const blocks = el.querySelectorAll(".task-block");
            let overBlock = null;
            for (const b of blocks) {
                const rect = b.getBoundingClientRect();
                if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
                    overBlock = b;
                    break;
                }
            }

            dragState.current.over = null;
            if (overBlock) {
                const overId = overBlock.getAttribute("data-task-id");
                if (overId !== dragState.current.dragging) {
                    // Always drop above — the divider between tasks is the drop zone
                    dragState.current.over = { id: overId, above: true };
                }
            }
            updateDragStyle();
        }

        function onMouseUp() {
            if (!dragState.current.dragging) return;
            const { dragging, over } = dragState.current;

            document.body.style.cursor = "";
            dragState.current = { dragging: null, over: null };
            updateDragStyle();

            if (!over || dragging === over.id) return;

            const doc = editor.state.doc;
            let sourceIndex = -1, targetIndex = -1;
            let i = 0;
            doc.descendants((node) => {
                if (node.type.name !== "paragraph") return false;
                if (node.attrs.taskId === dragging) sourceIndex = i;
                if (node.attrs.taskId === over.id) targetIndex = i;
                i++;
                return false;
            });

            if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return;

            const nodes = [];
            doc.descendants((node) => {
                if (node.type.name !== "paragraph") return false;
                nodes.push(node);
                return false;
            });

            const [moved] = nodes.splice(sourceIndex, 1);
            let insertAt = targetIndex;
            if (sourceIndex < targetIndex) insertAt--;
            if (!over.above) insertAt++;
            nodes.splice(insertAt, 0, moved);

            const newContent = Fragment.from(nodes);
            const tr = editor.state.tr.replaceWith(0, doc.content.size, newContent);
            tr.setMeta("sync", true);
            guard.current = true;
            editor.view.dispatch(tr);
            guard.current = false;

            runPipeline(editor);
        }

        el.addEventListener("mousedown", onMouseDown);
        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);

        return () => {
            el.removeEventListener("mousedown", onMouseDown);
            document.removeEventListener("mousemove", onMouseMove);
            document.removeEventListener("mouseup", onMouseUp);
        };
    }, [editor, runPipeline]);

    // --- Hydrate ---

    useEffect(() => {
        if (loading || !editor || hydrated.current) return;
        hydrated.current = true;
        if (tasks.length === 0) return;

        const sorted = [...tasks].sort((a, b) => a.position - b.position);
        const map = new Map();
        const content = sorted.map((t, i) => {
            map.set(t.id, { content: t.content, position: i, created_at: t.created_at });
            try {
                const p = JSON.parse(t.content);
                return { ...p, attrs: { ...(p.attrs || {}), taskId: t.id } };
            } catch {
                return { type: "paragraph", attrs: { taskId: t.id }, content: [{ type: "text", text: t.content }] };
            }
        });

        visible.current = map;
        suppress.current = true;
        editor.commands.setContent({ type: "doc", content });
        setTimeout(() => { suppress.current = false; editor.commands.focus("end"); }, 0);
    }, [loading, editor]);

    // --- Modal callbacks ---

    const handleDateChange = useCallback((taskId, field, date) => {
        const task = tasksRef.current.find(t => t.id === taskId);
        if (!task) return;
        dispatch(upsert({
            ...task,
            [field]: date ? date.toISOString() : null,
            updated_at: now(),
        }));
    }, [dispatch]);

    const handleRruleChange = useCallback((taskId, rule) => {
        const task = tasksRef.current.find(t => t.id === taskId);
        if (!task) return;
        dispatch(upsert({ ...task, rrule: rule, updated_at: now() }));
    }, [dispatch]);

    const completeTask = useCallback((taskId) => {
        const task = tasksRef.current.find(t => t.id === taskId);
        if (!task) return;
        const ts = now();

        if (task.completed_at) {
            // Uncomplete
            dispatch(upsert({ ...task, completed_at: null, updated_at: ts }));
            return;
        }

        // Complete
        dispatch(upsert({ ...task, completed_at: ts, updated_at: ts }));

        // If rrule, create next occurrence via pipeline
        if (task.rrule && editor) {
            try {
                // Compute the rrule interval by getting two consecutive occurrences from epoch
                const rule = RRule.fromString(task.rrule);
                const first = rule.after(new Date(0), true);
                const second = rule.after(first);
                const intervalMs = second - first;

                let newStart = null;
                let newDue = null;

                if (task.start_date && task.due_date) {
                    // Both: shift due forward by interval, compute start by preserving duration
                    const durationMs = new Date(task.due_date) - new Date(task.start_date);
                    newDue = new Date(new Date(task.due_date).getTime() + intervalMs).toISOString();
                    newStart = new Date(new Date(newDue).getTime() - durationMs).toISOString();
                } else if (task.due_date) {
                    newDue = new Date(new Date(task.due_date).getTime() + intervalMs).toISOString();
                } else if (task.start_date) {
                    newStart = new Date(new Date(task.start_date).getTime() + intervalMs).toISOString();
                } else {
                    newDue = new Date(Date.now() + intervalMs).toISOString();
                }

                if (newStart || newDue) {
                    pendingRruleData.current = {
                        rrule: task.rrule,
                        tags: task.tags,
                        parent_id: task.parent_id,
                        start_date: newStart,
                        due_date: newDue,
                    };

                    // Insert paragraph with the same content as the completed task
                    try {
                        const parsed = JSON.parse(task.content);
                        const endPos = editor.state.doc.content.size;
                        const newNode = editor.state.schema.nodeFromJSON({ ...parsed, attrs: {} });
                        editor.view.dispatch(editor.state.tr.insert(endPos, newNode));
                        editor.commands.focus("end");
                    } catch {
                        // Fallback: empty paragraph
                        const endPos = editor.state.doc.content.size;
                        editor.view.dispatch(editor.state.tr.insert(endPos, editor.state.schema.nodes.paragraph.create()));
                        editor.commands.focus("end");
                    }
                }
            } catch (e) { console.error("rrule error:", e); }
        }
    }, [dispatch, editor]);

    // --- Keyboard shortcuts ---

    const getActiveTaskId = useCallback(() => {
        if (!editor) return null;
        const { from } = editor.state.selection;
        const resolved = editor.state.doc.resolve(from);
        const node = resolved.node(resolved.depth) || resolved.parent;
        return node?.attrs?.taskId || null;
    }, [editor]);

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
            const taskId = getActiveTaskId();
            if (!taskId) return;

            if (matchShortcut(e, shortcuts.REPLY)) {
                e.preventDefault(); e.stopPropagation();
                pendingParentId.current = taskId;
                const endPos = editor.state.doc.content.size;
                editor.view.dispatch(editor.state.tr.insert(endPos, editor.state.schema.nodes.paragraph.create()));
                editor.commands.focus("end");
            } else if (matchShortcut(e, shortcuts.FOCUS)) {
                e.preventDefault(); e.stopPropagation();
                setCollapsedRoot(prev => prev === taskId ? null : taskId);
            } else if (matchShortcut(e, shortcuts.START)) {
                e.preventDefault(); e.stopPropagation();
                setRruleModal(null);
                setDateModal(prev => prev?.taskId === taskId && prev?.field === "start_date" ? null : { taskId, field: "start_date" });
            } else if (matchShortcut(e, shortcuts.DUE)) {
                e.preventDefault(); e.stopPropagation();
                setRruleModal(null);
                setDateModal(prev => prev?.taskId === taskId && prev?.field === "due_date" ? null : { taskId, field: "due_date" });
            } else if (matchShortcut(e, shortcuts.REPEAT)) {
                e.preventDefault(); e.stopPropagation();
                setDateModal(null);
                setRruleModal(prev => prev?.taskId === taskId ? null : { taskId });
            } else if (matchShortcut(e, shortcuts.COMPLETE)) {
                e.preventDefault(); e.stopPropagation();
                completeTask(taskId);
            } else if (e.key === "Escape" && collapsedRootRef.current) {
                e.preventDefault(); e.stopPropagation();
                setCollapsedRoot(null);
            }
        }

        document.addEventListener("keydown", onKeyDown, true);
        return () => document.removeEventListener("keydown", onKeyDown, true);
    }, [editor, getActiveTaskId, completeTask]);

    // --- Click handlers ---

    const handleClick = useCallback((e) => {
        if (!editor) return;

        const divider = e.target.closest(".task-divider");
        if (divider) {
            e.stopPropagation(); e.preventDefault();
            const block = divider.closest(".task-block");
            if (block) {
                const pos = editor.view.posAtDOM(block, 0);
                if (pos != null) {
                    const resolved = editor.state.doc.resolve(pos);
                    const before = resolved.before(resolved.depth);
                    const node = editor.state.schema.nodes.paragraph.create();
                    editor.view.dispatch(editor.state.tr.insert(before, node));
                    editor.commands.focus(before + 1);
                }
            }
            return;
        }

        const checkBtn = e.target.closest(".task-check");
        if (checkBtn) {
            e.stopPropagation(); e.preventDefault();
            const block = checkBtn.closest(".task-block");
            const taskId = block?.getAttribute("data-task-id");
            if (taskId) completeTask(taskId);
            return;
        }

        const startBtn = e.target.closest(".task-start-btn");
        if (startBtn) {
            e.stopPropagation(); e.preventDefault();
            const taskId = startBtn.closest(".task-block")?.getAttribute("data-task-id");
            if (taskId) {
                setRruleModal(null);
                setDateModal(prev => prev?.taskId === taskId && prev?.field === "start_date" ? null : { taskId, field: "start_date" });
            }
            return;
        }

        const dueBtn = e.target.closest(".task-due-btn");
        if (dueBtn) {
            e.stopPropagation(); e.preventDefault();
            const taskId = dueBtn.closest(".task-block")?.getAttribute("data-task-id");
            if (taskId) {
                setRruleModal(null);
                setDateModal(prev => prev?.taskId === taskId && prev?.field === "due_date" ? null : { taskId, field: "due_date" });
            }
            return;
        }

        const rruleBtn = e.target.closest(".task-rrule-btn");
        if (rruleBtn) {
            e.stopPropagation(); e.preventDefault();
            const taskId = rruleBtn.closest(".task-block")?.getAttribute("data-task-id");
            if (taskId) {
                setDateModal(null);
                setRruleModal(prev => prev?.taskId === taskId ? null : { taskId });
            }
            return;
        }

        const collapseBtn = e.target.closest(".task-collapse-btn");
        if (collapseBtn) {
            e.stopPropagation(); e.preventDefault();
            setDateModal(null); setRruleModal(null);
            const taskId = collapseBtn.closest(".task-block")?.getAttribute("data-task-id");
            if (taskId) setCollapsedRoot(prev => prev === taskId ? null : taskId);
            return;
        }

        const replyBtn = e.target.closest(".task-reply-btn");
        if (replyBtn) {
            e.stopPropagation(); e.preventDefault();
            setDateModal(null); setRruleModal(null);
            const parentTaskId = replyBtn.closest(".task-block")?.getAttribute("data-task-id");
            if (parentTaskId) {
                pendingParentId.current = parentTaskId;
                const endPos = editor.state.doc.content.size;
                editor.view.dispatch(editor.state.tr.insert(endPos, editor.state.schema.nodes.paragraph.create()));
                editor.commands.focus("end");
            }
            return;
        }

        if (e.target.classList.contains("editor-content")) editor.commands.focus("end");
    }, [editor, dispatch, completeTask]);

    // --- Render ---

    if (loading) return <div className="editor"><div className="drag-region" data-tauri-drag-region /></div>;

    const dateModalTask = dateModal ? tasksRef.current.find(t => t.id === dateModal.taskId) : null;
    const rruleModalTask = rruleModal ? tasksRef.current.find(t => t.id === rruleModal.taskId) : null;

    return (
        <div className="editor">
            <div className="drag-region" data-tauri-drag-region />
            {collapsedRoot && (
                <button className="focus-exit-btn" onClick={() => setCollapsedRoot(null)}>
                    <i className="fa-solid fa-xmark" /> {strings.VIEWS__EDITOR_EXIT_FOCUS}
                </button>
            )}
            <div className="editor-content" onClick={handleClick} style={{ position: "relative" }}>
                <EditorContent editor={editor} />
                <ReplyArrows editorRef={editor?.view?.dom} collapsedRoot={collapsedRoot} />
            </div>

            {dateModal && dateModalTask && (
                <DateModal
                    key={`${dateModal.taskId}-${dateModal.field}`}
                    label={dateModal.field === "start_date" ? strings.COMPONENTS__DATEMODAL_START : strings.COMPONENTS__DATEMODAL_DUE}
                    initialDate={dateModalTask[dateModal.field] ? new Date(dateModalTask[dateModal.field]) : null}
                    onDate={(d) => handleDateChange(dateModal.taskId, dateModal.field, d)}
                    onClose={() => { setDateModal(null); editor?.commands.focus(); }}
                />
            )}
            {rruleModal && rruleModalTask && (
                <RRuleModal
                    initialRrule={rruleModalTask.rrule}
                    onChange={(rule) => handleRruleChange(rruleModal.taskId, rule)}
                    onClose={() => { setRruleModal(null); editor?.commands.focus(); }}
                />
            )}
        </div>
    );
}
