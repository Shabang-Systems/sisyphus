import { useEffect, useCallback, useRef, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { useEditor, EditorContent, ReactRenderer } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Node, mergeAttributes, Extension } from "@tiptap/core";
import { Fragment } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { RRule } from "rrule";
import moment from "moment";
import { snapshot } from "@api/utils.js";
import { tick } from "@api/ui.js";
import { upsert, batchUpsert, remove, setParent, search, insertTaskAt } from "@api/tasks.js";
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

// --- Find highlight plugin ---

const findPluginKey = new PluginKey("findHighlight");

function createFindPlugin(queryRef, indexRef, matchesRef) {
    return new Plugin({
        key: findPluginKey,
        state: {
            init() { return DecorationSet.empty; },
            apply(tr, old, oldState, newState) {
                const q = queryRef.current;
                if (!q) { matchesRef.current = []; return DecorationSet.empty; }

                const decorations = [];
                const matches = [];
                try {
                    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
                    newState.doc.descendants((node, pos) => {
                        if (node.isText) {
                            let match;
                            while ((match = re.exec(node.text)) !== null) {
                                const from = pos + match.index;
                                const to = from + match[0].length;
                                matches.push({ from, to });
                            }
                        } else if (node.type.name === "tag" && node.attrs.id) {
                            if (re.test(node.attrs.id)) {
                                matches.push({ from: pos, to: pos + node.nodeSize });
                            }
                            re.lastIndex = 0;
                        }
                    });
                } catch {}
                matches.reverse();
                matchesRef.current = matches;
                // Rebuild decorations with reversed index
                const decs = matches.map((m, i) =>
                    Decoration.inline(m.from, m.to, { class: i === indexRef.current ? "find-active" : "find-match" })
                );
                return DecorationSet.create(newState.doc, decs);
            },
        },
        props: {
            decorations(state) { return this.getState(state); },
        },
    });
}

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
                    ["span", { class: "task-sidebar-btn task-effort-btn" },
                        ["i", { class: "fa-solid fa-circle" }]],
                    ["span", { class: "task-sidebar-btn task-lock-btn" },
                        ["i", { class: "fa-solid fa-lock" }]],
                    ["span", { class: "task-sidebar-btn task-schedule-btn" },
                        ["i", { class: "fa-solid fa-calendar-day" }]],
                    ["span", { class: "task-sidebar-btn task-start-btn" },
                        ["i", { class: "fa-solid fa-circle-play" }]],
                    ["span", { class: "task-sidebar-btn task-due-btn" },
                        ["i", { class: "fa-solid fa-circle-stop" }]],
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

// effective_due and is_deferred are computed by Rust and returned with each upsert

// --- Component ---

export default function Editor({ mode = "editor", filterTaskIds = null, searchQuery = "", jumpToTaskId = null, replyToTaskId = null, onJumpHandled = null, taskList = null, scheduleDate = null, onTaskDrag = null, onJumpToTask = null, triggerRebalance = null }) {
    const isBrowse = mode === "browse";
    const searchQueryRef = useRef(searchQuery);
    const dispatch = useDispatch();
    const allTasks = useSelector(state => state.tasks.db);
    const tasks = taskList || allTasks; // what's in the doc
    const loading = useSelector(state => state.tasks.loading);
    const clock = useSelector(state => state.ui.clock);
    // Only generate CSS rules for tasks with DOM nodes (visible ref) — O(visible) instead of O(all)
    const styleCacheRef = useRef(new Map()); // taskId → CSS rules string
    const [visibleVersion, setVisibleVersion] = useState(0); // bumped when visible ref changes, triggers style regen

    // Tick every 5 seconds — only updates ui.clock, doesn't touch editor/modals
    useEffect(() => {
        const interval = setInterval(() => dispatch(tick()), 5000);
        return () => clearInterval(interval);
    }, [dispatch]);
    const [collapsedRoot, setCollapsedRoot] = useState(null);
    const [dateModal, setDateModal] = useState(null);   // { taskId, field }
    const [rruleModal, setRruleModal] = useState(null);  // { taskId }
    const [focusedTaskId, setFocusedTaskId] = useState(null);
    const [findBar, setFindBar] = useState(false);
    const [findQuery, setFindQuery] = useState("");
    const [findIndex, setFindIndex] = useState(0);
    const findInputRef = useRef(null);
    const findBarRef = useRef(false);
    const findMatchesRef = useRef([]);
    const findQueryRef = useRef("");
    const findIndexRef = useRef(0);

    const suppress = useRef(false);
    const guard = useRef(false);
    const hydrated = useRef(false);
    const localChangeRef = useRef(false); // set when pipeline modifies tasks, skip next taskList reload
    const visible = useRef(new Map());
    const updateTimer = useRef(null);
    const pendingParentId = useRef(null);
    const pendingRruleData = useRef(null);  // { rrule, tags, parent_id, start_date, due_date }
    const collapsedRootRef = useRef(null);
    const tasksRef = useRef(tasks);
    const dragState = useRef({ dragging: null, over: null });
    const onTaskDragRef = useRef(onTaskDrag);
    useEffect(() => { onTaskDragRef.current = onTaskDrag; }, [onTaskDrag]);
    useEffect(() => { collapsedRootRef.current = collapsedRoot; }, [collapsedRoot]);
    useEffect(() => { findBarRef.current = findBar; if (findBar && findInputRef.current) findInputRef.current.focus(); }, [findBar]);
    // Find decoration refresh — moved after useEditor (see below)
    useEffect(() => { searchQueryRef.current = searchQuery; }, [searchQuery]);
    useEffect(() => { tasksRef.current = allTasks; }, [allTasks]);
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
                let content = row.content;

                tr.setNodeMarkup(row.pmPos, undefined, { taskId: id });

                let parentId = pendingParentId.current;
                pendingParentId.current = null;

                if (collapsedRootRef.current && !parentId) {
                    const prevRow = rows[row.position - 1];
                    parentId = prevRow?.taskId || collapsedRootRef.current;
                }
                const rruleData = pendingRruleData.current;
                pendingRruleData.current = null;
                if (taskList) {
                    // In taskList mode, use atomic insert_task_at with position shifting
                    const prevRow = row.position > 0 ? rows[row.position - 1] : null;
                    dispatch(insertTaskAt({
                        task: {
                            id, content, position: 0, // position computed by Rust
                            tags: rruleData?.tags || row.tags,
                            parent_id: rruleData?.parent_id || parentId,
                            start_date: rruleData?.start_date,
                            due_date: rruleData?.due_date,
                            rrule: rruleData?.rrule,
                            schedule: scheduleDate || null,
                            locked: scheduleDate ? true : false,
                            created_at: ts, updated_at: ts,
                        },
                        afterId: prevRow?.taskId || null,
                    }));
                } else {
                    dispatch(upsert({
                        id, content, position: row.position,
                        tags: rruleData?.tags || row.tags,
                        parent_id: rruleData?.parent_id || parentId,
                        start_date: rruleData?.start_date,
                        due_date: rruleData?.due_date,
                        rrule: rruleData?.rrule,
                        schedule: scheduleDate || undefined,
                        locked: scheduleDate ? true : undefined,
                        created_at: ts, updated_at: ts,
                    }));
                }
                visible.current.set(id, { content, position: row.position, created_at: ts });
            }
            tr.setMeta("sync", true);
            guard.current = true;
            editor.view.dispatch(tr);
            guard.current = false;
            if (taskList) localChangeRef.current = true;
            if (triggerRebalance) triggerRebalance();
        }

        const currentIds = new Set(rows.map(r => r.taskId));
        for (const [id] of visible.current) {
            if (!currentIds.has(id)) {
                dispatch(remove(id)); visible.current.delete(id);
                if (taskList) localChangeRef.current = true;
            }
        }

        if (updateTimer.current) clearTimeout(updateTimer.current);
        updateTimer.current = setTimeout(() => {
            const fresh = readDoc(editor.state.doc);
            dedup(fresh);
            const ts2 = now();
            const taskMap = new Map(tasksRef.current.map(t => [t.id, t]));
            const batch = [];
            for (const row of fresh) {
                if (!row.taskId) continue;
                const prev = visible.current.get(row.taskId);
                if (!prev) continue;
                // When taskList is provided, don't update position (local index != global position)
                const posChanged = !taskList && prev.position !== row.position;
                if (prev.content !== row.content || posChanged) {
                    // Preserve scheduling fields from Redux
                    const existing = taskMap.get(row.taskId);
                    batch.push({
                        id: row.taskId, content: row.content,
                        position: taskList ? (existing?.position ?? row.position) : row.position,
                        tags: row.tags, created_at: prev.created_at, updated_at: ts2,
                        parent_id: existing?.parent_id,
                        start_date: existing?.start_date, due_date: existing?.due_date,
                        completed_at: existing?.completed_at, rrule: existing?.rrule,
                        effort: existing?.effort,
                        schedule: existing?.schedule,
                        locked: existing?.locked,
                    });
                    visible.current.set(row.taskId, { content: row.content, position: row.position, created_at: prev.created_at });
                }
            }
            if (batch.length === 1) {
                dispatch(upsert(batch[0]));
            } else if (batch.length > 1) {
                dispatch(batchUpsert(batch));
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

        // Only generate rules for tasks currently in the DOM (visible ref)
        const visibleIds = visible.current;
        const taskMap = new Map(allTasks.map(t => [t.id, t]));
        const nowDate = new Date();
        const cache = styleCacheRef.current;

        // Build a key to detect if we need to regenerate: visible IDs + clock
        // For incremental updates, we regenerate per-task rules only for changed tasks
        const newCache = new Map();

        for (const [taskId] of visibleIds) {
            const task = taskMap.get(taskId);
            if (!task) continue;

            const sel = `.task-block[data-task-id="${task.id}"]`;
            const effectiveDue = task.effective_due ? new Date(task.effective_due) : null;
            const taskRules = [];

            if (task.completed_at) {
                taskRules.push(`${sel} .task-row p { text-decoration: line-through; opacity: 0.4; }`);
                taskRules.push(`${sel} .task-check { color: var(--green) !important; }`);
            } else if (task.is_deferred) {
                taskRules.push(`${sel} .task-row p { opacity: 0.3; }`);
            } else if (effectiveDue) {
                const hoursLeft = (effectiveDue - nowDate) / 3600000;
                if (hoursLeft < 0) {
                    taskRules.push(`${sel} .task-row p { color: var(--red); }`);
                } else if (hoursLeft < 24) {
                    taskRules.push(`${sel} .task-row p { color: var(--orange); }`);
                }
            }

            if (task.start_date) taskRules.push(`${sel} .task-start-btn { color: var(--blue) !important; }`);
            if (task.due_date) taskRules.push(`${sel} .task-due-btn { color: var(--orange) !important; }`);
            if (task.rrule) taskRules.push(`${sel} .task-rrule-btn { color: var(--blue) !important; }`);
            if (task.schedule) taskRules.push(`${sel} .task-schedule-btn { color: var(--blue) !important; }`);
            if (task.locked) {
                taskRules.push(`${sel} .task-lock-btn { color: var(--blue) !important; }`);
                taskRules.push(`${sel} .task-lock-btn i { --fa-primary: ""; }`);
            }

            const effortLabels = ["", "XS", "S", "M", "L", "XL"];
            const effort = task.effort || 0;
            if (effort > 0) {
                taskRules.push(`${sel} .task-effort-btn i { display: none; }`);
                taskRules.push(`${sel} .task-effort-btn::after { content: "${effortLabels[effort]}"; font-size: 9px; font-weight: 600; }`);
            }
            if (effort === 3) {
                taskRules.push(`${sel} .task-row p { background: rgba(47, 51, 56, 0.03); }`);
            } else if (effort === 4) {
                taskRules.push(`${sel} .task-row p { background: rgba(47, 51, 56, 0.06); }`);
            } else if (effort === 5) {
                taskRules.push(`${sel} .task-row p { font-weight: 500; background: rgba(47, 51, 56, 0.08); }`);
            }

            if (effectiveDue && !task.completed_at) {
                const due = moment(effectiveDue);
                const daysAway = due.diff(moment(), "days", true);
                let dueLabel;
                if (daysAway < -1) dueLabel = due.fromNow();
                else if (daysAway < 0) dueLabel = "overdue";
                else if (daysAway < 1) dueLabel = due.fromNow();
                else if (daysAway < 7) dueLabel = due.format("dddd, h:mm a");
                else dueLabel = due.format("dddd, MMMM D, h:mm a");
                const escaped = dueLabel.replace(/"/g, '\\"');
                taskRules.push(`${sel} .task-row p::after { content: "${escaped}"; position: absolute; right: 8px; top: 50%; transform: translateY(-50%); font-size: 11px; color: var(--gray-3); pointer-events: none; white-space: nowrap; }`);
                taskRules.push(`${sel}:hover .task-row p::after { display: none; }`);
            }

            newCache.set(taskId, taskRules.join("\n"));
        }

        styleCacheRef.current = newCache;
        const allRules = [...newCache.values()].join("\n");
        style.textContent = allRules;
        // No cleanup: don't clear style.textContent between re-renders — that causes a flash
        // where ::after labels disappear and task heights shift, breaking scroll position.
        // The next render will overwrite the content anyway.
    }, [allTasks, clock, visibleVersion]);

    // Search filter styles removed — browse mode passes filtered taskList directly.

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
            ...(!isBrowse ? [Placeholder.configure({ placeholder: strings.VIEWS__EDITOR_PLACEHOLDER })] : []),
            Extension.create({
                name: "findHighlight",
                addProseMirrorPlugins: () => [createFindPlugin(findQueryRef, findIndexRef, findMatchesRef)],
            }),
        ],
        content: "",
        editable: !isBrowse,
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

            // Track focused task for arrow highlighting
            try {
                const resolved = editor.state.doc.resolve(from);
                const node = resolved.node(resolved.depth) || resolved.parent;
                setFocusedTaskId(node?.attrs?.taskId || null);
            } catch { setFocusedTaskId(null); }

            try {
                const resolved = editor.state.doc.resolve(from);
                if (!isBrowse && !taskList && !isLoadingMore.current && resolved.index(0) === editor.state.doc.childCount - 1) {
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

    // --- Jump to task (cross-view navigation) ---
    useEffect(() => {
        if (!jumpToTaskId || !editor) return;
        // Find the paragraph with this taskId and scroll to it
        let targetPos = null;
        editor.state.doc.descendants((node, pos) => {
            if (node.type.name === "paragraph" && node.attrs.taskId === jumpToTaskId) {
                targetPos = pos;
            }
            return false;
        });
        if (targetPos != null) {
            // If replyToTaskId is set, create a reply (insert new paragraph after the target)
            if (replyToTaskId) {
                pendingParentId.current = replyToTaskId;
                const endPos = editor.state.doc.content.size;
                editor.view.dispatch(editor.state.tr.insert(endPos, editor.state.schema.nodes.paragraph.create()));
                editor.commands.focus("end");
                // Scroll to the new paragraph at end
                setTimeout(() => {
                    const container = document.querySelector(".editor-content");
                    try {
                        const newEndPos = editor.state.doc.content.size - 1;
                        const coords = editor.view.coordsAtPos(newEndPos);
                        if (coords && container) {
                            const containerRect = container.getBoundingClientRect();
                            const target = coords.top - containerRect.top + container.scrollTop - container.clientHeight * 0.4;
                            container.scrollTo({ top: target, behavior: "smooth" });
                        }
                    } catch {}
                }, 50);
            } else {
                editor.commands.setTextSelection(targetPos + 1);
                editor.commands.focus();
                setTimeout(() => {
                    const container = document.querySelector(".editor-content");
                    try {
                        const coords = editor.view.coordsAtPos(targetPos + 1);
                        if (coords && container) {
                            const containerRect = container.getBoundingClientRect();
                            const target = coords.top - containerRect.top + container.scrollTop - container.clientHeight * 0.4;
                            container.scrollTo({ top: target, behavior: "smooth" });
                        }
                    } catch {}
                }, 50);
            }
        }
        if (onJumpHandled) onJumpHandled();
    }, [jumpToTaskId, replyToTaskId, editor, onJumpHandled]);

    // --- Find decoration refresh ---
    useEffect(() => {
        findQueryRef.current = findBar ? findQuery : "";
        findIndexRef.current = findIndex;
        if (editor) {
            const tr = editor.state.tr.setMeta("findUpdate", true);
            editor.view.dispatch(tr);
        }
    }, [findQuery, findIndex, findBar, editor]);

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

            const taskId = block.getAttribute("data-task-id");
            // If external drag handler provided, use that instead of reorder
            if (onTaskDragRef.current) {
                onTaskDragRef.current(taskId, e);
                return;
            }

            dragState.current.dragging = taskId;
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

    // --- Hydrate (foveated: load most recent PAGE_SIZE tasks, load older on scroll-to-top) ---

    const PAGE_SIZE = 50;
    const allTasksRef = useRef([]); // sorted by created_at ascending (oldest first)
    const loadedCountRef = useRef(0);
    const isLoadingMore = useRef(false); // prevent autoscroll during load-more

    const loadTasks = useCallback((taskArray) => {
        if (!editor) return;
        const sorted = [...taskArray].sort((a, b) => a.position - b.position);
        allTasksRef.current = sorted;

        // Browse/completed: first PAGE_SIZE (most relevant at top). Planning: last PAGE_SIZE (newest at bottom).
        const startIdx = isBrowse ? 0 : Math.max(0, sorted.length - PAGE_SIZE);
        const endIdx = isBrowse ? Math.min(PAGE_SIZE, sorted.length) : sorted.length;
        const initialSlice = sorted.slice(startIdx, endIdx);
        loadedCountRef.current = initialSlice.length;

        const map = new Map();
        const content = initialSlice.map((t, i) => {
            map.set(t.id, { content: t.content, position: startIdx + i, created_at: t.created_at });
            try {
                const p = JSON.parse(t.content);
                return { ...p, attrs: { ...(p.attrs || {}), taskId: t.id } };
            } catch {
                return { type: "paragraph", attrs: { taskId: t.id }, content: [{ type: "text", text: t.content }] };
            }
        });

        visible.current = map;
        setVisibleVersion(v => v + 1); // trigger style regeneration
        suppress.current = true;
        editor.commands.setContent({ type: "doc", content: content.length ? content : [{ type: "paragraph" }] });
        suppress.current = false;
        if (!isBrowse && !taskList) {
            // Planning mode: cursor at end, last task centered in viewport.
            editor.commands.focus("end");
            const container = document.querySelector(".editor-content");
            if (container) {
                // scrollHeight includes 70vh bottom padding, so scrolling to max
                // puts the last task roughly centered.
                container.scrollTop = container.scrollHeight;
            }
        }
    }, [editor, isBrowse]);

    // Initial hydration (planning mode — exclude completed tasks)
    useEffect(() => {
        if (loading || !editor || hydrated.current || isBrowse) return;
        hydrated.current = true;
        const active = tasks.filter(t => !t.completed_at);
        if (active.length === 0) return;
        loadTasks(active);
    }, [loading, editor]);

    // Reload when taskList membership changes externally (scheduler, drag between chunks)
    // Skip reload if the change originated from this editor (local insert/delete)
    const prevTaskIdsRef = useRef(null);
    useEffect(() => {
        if (!taskList || !editor || loading) return;
        const newIds = taskList.map(t => t.id).join(",");
        if (prevTaskIdsRef.current === newIds) return;
        prevTaskIdsRef.current = newIds;

        // If change was local, ProseMirror already has the right doc — don't rebuild
        if (localChangeRef.current) {
            localChangeRef.current = false;
            return;
        }

        hydrated.current = true;
        loadTasks(taskList);
    }, [taskList, editor]);

    // Load more tasks on scroll — planning: scroll-to-top prepends older tasks;
    // browse/completed: scroll-to-bottom appends older tasks.
    useEffect(() => {
        if (!editor) return;
        const container = document.querySelector(".editor-content");
        if (!container) return;

        const onScroll = () => {
            const allItems = allTasksRef.current;
            const loaded = loadedCountRef.current;
            if (loaded >= allItems.length) return;

            if (isBrowse) {
                // Scroll-to-bottom: append next batch
                const distFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
                if (distFromBottom > 50) return;

                const startIdx = loaded;
                const endIdx = Math.min(allItems.length, startIdx + PAGE_SIZE);
                const batch = allItems.slice(startIdx, endIdx);
                if (batch.length === 0) return;

                loadedCountRef.current += batch.length;
                isLoadingMore.current = true;

                const newContent = batch.map(t => {
                    visible.current.set(t.id, { content: t.content, position: 0, created_at: t.created_at });
                    try {
                        const p = JSON.parse(t.content);
                        return { ...p, attrs: { ...(p.attrs || {}), taskId: t.id } };
                    } catch {
                        return { type: "paragraph", attrs: { taskId: t.id }, content: [{ type: "text", text: t.content }] };
                    }
                });

                suppress.current = true;
                const nodes = newContent.map(c => editor.state.schema.nodeFromJSON(c));
                const fragment = Fragment.from(nodes);
                const endPos = editor.state.doc.content.size;
                const tr = editor.state.tr.insert(endPos, fragment);
                tr.setMeta("sync", true);
                guard.current = true;
                editor.view.dispatch(tr);
                guard.current = false;

                setVisibleVersion(v => v + 1);
                requestAnimationFrame(() => {
                    suppress.current = false;
                    isLoadingMore.current = false;
                });
            } else {
                // Scroll-to-top: prepend older batch (planning mode)
                if (container.scrollTop > 50) return;

                const endIdx = allItems.length - loaded;
                const startIdx = Math.max(0, endIdx - PAGE_SIZE);
                const batch = allItems.slice(startIdx, endIdx);
                if (batch.length === 0) return;

                loadedCountRef.current += batch.length;
                isLoadingMore.current = true;

                // Find anchor element: first visible task-block for scroll restoration
                const anchorEl = container.querySelector(".task-block[data-task-id]");
                const anchorTop = anchorEl ? anchorEl.getBoundingClientRect().top : null;

                const newContent = batch.map(t => {
                    visible.current.set(t.id, { content: t.content, position: 0, created_at: t.created_at });
                    try {
                        const p = JSON.parse(t.content);
                        return { ...p, attrs: { ...(p.attrs || {}), taskId: t.id } };
                    } catch {
                        return { type: "paragraph", attrs: { taskId: t.id }, content: [{ type: "text", text: t.content }] };
                    }
                });

                suppress.current = true;
                const nodes = newContent.map(c => editor.state.schema.nodeFromJSON(c));
                const fragment = Fragment.from(nodes);
                const tr = editor.state.tr.insert(0, fragment);
                tr.setMeta("sync", true);
                guard.current = true;
                editor.view.dispatch(tr);
                guard.current = false;

                // Restore scroll position synchronously using anchor element
                if (anchorEl && anchorTop !== null) {
                    const newAnchorTop = anchorEl.getBoundingClientRect().top;
                    container.scrollTop += (newAnchorTop - anchorTop);
                }

                setVisibleVersion(v => v + 1);
                requestAnimationFrame(() => {
                    suppress.current = false;
                    isLoadingMore.current = false;
                });
            }
        };

        container.addEventListener("scroll", onScroll, { passive: true });
        return () => container.removeEventListener("scroll", onScroll);
    }, [editor]);

    // --- Modal callbacks ---

    const handleDateChange = useCallback((taskId, field, date) => {
        const task = tasksRef.current.find(t => t.id === taskId);
        if (!task) return;
        if (field === "schedule") {
            dispatch(upsert({
                ...task,
                schedule: date ? date.toISOString() : null,
                locked: date ? true : false,
                updated_at: now(),
            }));
        } else {
            dispatch(upsert({
                ...task,
                [field]: date ? date.toISOString() : null,
                updated_at: now(),
            }));
        }
        if (triggerRebalance) triggerRebalance();
    }, [dispatch]);

    const handleRruleChange = useCallback((taskId, rule) => {
        const task = tasksRef.current.find(t => t.id === taskId);
        if (!task) return;
        dispatch(upsert({ ...task, rrule: rule, updated_at: now() }));
    }, [dispatch]);

    const cycleEffort = useCallback((taskId) => {
        const task = tasksRef.current.find(t => t.id === taskId);
        if (!task) return;
        const next = ((task.effort || 0) + 1) % 6; // 0=none, 1=XS, 2=S, 3=M, 4=L, 5=XL
        dispatch(upsert({ ...task, effort: next, updated_at: now() }));
    }, [dispatch]);

    const completeTask = useCallback((taskId) => {
        const task = tasksRef.current.find(t => t.id === taskId);
        if (!task) return;
        const ts = now();

        // Optimistic: apply visual state immediately via inline style injection
        const sel = `.task-block[data-task-id="${taskId}"]`;
        const optStyle = document.getElementById("sisyphus-optimistic-style") || (() => {
            const s = document.createElement("style"); s.id = "sisyphus-optimistic-style";
            document.head.appendChild(s); return s;
        })();

        if (task.completed_at) {
            // Uncomplete — remove strikethrough immediately
            optStyle.textContent = `${sel} .task-row p { text-decoration: none !important; opacity: 1 !important; } ${sel} .task-check { color: inherit !important; }`;
            dispatch(upsert({ ...task, completed_at: null, updated_at: ts }))
                .then(() => { optStyle.textContent = ""; });
            return;
        }

        // Complete — apply strikethrough immediately
        optStyle.textContent = `${sel} .task-row p { text-decoration: line-through !important; opacity: 0.4 !important; } ${sel} .task-check { color: var(--green) !important; }`;
        dispatch(upsert({ ...task, completed_at: ts, updated_at: ts }))
            .then(() => { optStyle.textContent = ""; });

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
        if (triggerRebalance) triggerRebalance();
    }, [dispatch, editor, triggerRebalance]);

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
            // Block Enter in browse mode — no new task creation
            if (isBrowse && e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
                e.preventDefault(); e.stopPropagation();
                return;
            }
            if (matchShortcut(e, shortcuts.FIND)) {
                e.preventDefault(); e.stopPropagation();
                setFindBar(prev => !prev);
                return;
            }
            if (e.key === "Escape" && findBarRef.current) {
                e.preventDefault(); e.stopPropagation();
                const matches = findMatchesRef.current;
                const idx = findIndexRef.current;
                if (editor && matches[idx]) editor.commands.setTextSelection(matches[idx].from);
                setFindBar(false);
                setFindQuery("");
                setFindIndex(0);
                editor?.commands.focus();
                return;
            }
            // While find bar is open, block all keystrokes from reaching the editor
            // (except Cmd+F and Escape handled above)
            if (findBarRef.current) {
                return;
            }

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
            } else if (matchShortcut(e, shortcuts.EFFORT)) {
                e.preventDefault(); e.stopPropagation();
                cycleEffort(taskId);
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

        const effortBtn = e.target.closest(".task-effort-btn");
        if (effortBtn) {
            e.stopPropagation(); e.preventDefault();
            const taskId = effortBtn.closest(".task-block")?.getAttribute("data-task-id");
            if (taskId) cycleEffort(taskId);
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

        const scheduleBtn = e.target.closest(".task-schedule-btn");
        if (scheduleBtn) {
            e.stopPropagation(); e.preventDefault();
            const taskId = scheduleBtn.closest(".task-block")?.getAttribute("data-task-id");
            if (taskId) {
                setRruleModal(null);
                setDateModal(prev => prev?.taskId === taskId && prev?.field === "schedule" ? null : { taskId, field: "schedule" });
            }
            return;
        }

        const lockBtn = e.target.closest(".task-lock-btn");
        if (lockBtn) {
            e.stopPropagation(); e.preventDefault();
            const taskId = lockBtn.closest(".task-block")?.getAttribute("data-task-id");
            if (taskId) {
                const task = tasksRef.current.find(t => t.id === taskId);
                if (task) {
                    if (task.locked) {
                        dispatch(upsert({ ...task, locked: false, updated_at: now() }));
                        if (triggerRebalance) triggerRebalance();
                    } else if (task.schedule) {
                        dispatch(upsert({ ...task, locked: true, updated_at: now() }));
                        if (triggerRebalance) triggerRebalance();
                    } else {
                        // No schedule yet — open date picker
                        setRruleModal(null);
                        setDateModal({ taskId, field: "schedule" });
                    }
                }
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
                if (onJumpToTask) {
                    // In action mode, jump to planning view
                    onJumpToTask(parentTaskId);
                } else {
                    pendingParentId.current = parentTaskId;
                    const endPos = editor.state.doc.content.size;
                    editor.view.dispatch(editor.state.tr.insert(endPos, editor.state.schema.nodes.paragraph.create()));
                    editor.commands.focus("end");
                }
            }
            return;
        }

        if (e.target.classList.contains("editor-content")) editor.commands.focus("end");
    }, [editor, dispatch, completeTask]);

    // --- Render ---

    if (loading) return <div className="editor">{!isBrowse && <div className="drag-region" data-tauri-drag-region />}</div>;

    const dateModalTask = dateModal ? tasksRef.current.find(t => t.id === dateModal.taskId) : null;
    const rruleModalTask = rruleModal ? tasksRef.current.find(t => t.id === rruleModal.taskId) : null;

    return (
        <div className={isBrowse ? "editor editor-browse" : "editor"}>
            {!isBrowse && <div className="drag-region" data-tauri-drag-region />}
            {collapsedRoot && (
                <button className="focus-exit-btn" onClick={() => setCollapsedRoot(null)}>
                    <i className="fa-solid fa-xmark" /> {strings.VIEWS__EDITOR_EXIT_FOCUS}
                </button>
            )}
            <div className="editor-content" onClick={handleClick} style={{ position: "relative" }}>
                <EditorContent editor={editor} />
                <ReplyArrows editorRef={editor?.view?.dom} collapsedRoot={collapsedRoot} focusedTaskId={isBrowse ? null : focusedTaskId} />
            </div>

            {dateModal && dateModalTask && (
                <DateModal
                    key={`${dateModal.taskId}-${dateModal.field}`}
                    label={dateModal.field === "start_date" ? strings.COMPONENTS__DATEMODAL_START : dateModal.field === "schedule" ? strings.TOOLTIPS.ACTION_SCHEDULE : strings.COMPONENTS__DATEMODAL_DUE}
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

            {findBar && (
                <div className="find-bar">
                    <i className="fa-solid fa-magnifying-glass find-bar-icon" />
                    <input
                        ref={findInputRef}
                        className="find-bar-input"
                        placeholder={strings.VIEWS__EDITOR_FIND}
                        value={findQuery}
                        onChange={e => {
                            setFindQuery(e.target.value);
                            setFindIndex(0);
                            setTimeout(() => {
                                const el = document.querySelector(".find-active");
                                const container = document.querySelector(".editor-content");
                                if (el && container) {
                                    const elRect = el.getBoundingClientRect();
                                    const contRect = container.getBoundingClientRect();
                                    const target = elRect.top - contRect.top + container.scrollTop - container.clientHeight / 2;
                                    container.scrollTo({ top: target, behavior: "smooth" });
                                }
                            }, 50);
                        }}
                        onKeyDown={e => {
                            if (e.key === "Enter") {
                                e.preventDefault();
                                const total = findMatchesRef.current.length;
                                if (total > 0) {
                                    setFindIndex(prev => {
                                        const next = e.shiftKey ? (prev - 1 + total) % total : (prev + 1) % total;
                                        setTimeout(() => {
                                            const el = document.querySelector(".find-active");
                                            const container = document.querySelector(".editor-content");
                                            if (el && container) {
                                                const elRect = el.getBoundingClientRect();
                                                const contRect = container.getBoundingClientRect();
                                                const target = elRect.top - contRect.top + container.scrollTop - container.clientHeight / 2;
                                                container.scrollTo({ top: target, behavior: "smooth" });
                                            }
                                        }, 0);
                                        return next;
                                    });
                                }
                            } else if (e.key === "Escape") {
                                // Place cursor at current match position before closing
                                const matches = findMatchesRef.current;
                                const idx = findIndexRef.current;
                                if (editor && matches[idx]) {
                                    editor.commands.setTextSelection(matches[idx].from);
                                }
                                setFindBar(false);
                                setFindQuery("");
                                setFindIndex(0);
                                editor?.commands.focus();
                            }
                        }}
                    />
                    {findMatchesRef.current.length > 0 && (
                        <span className="find-bar-count">{findIndex + 1}/{findMatchesRef.current.length}</span>
                    )}
                    <i className="fa-solid fa-xmark find-bar-close" onClick={() => {
                        const matches = findMatchesRef.current;
                        const idx = findIndexRef.current;
                        if (editor && matches[idx]) editor.commands.setTextSelection(matches[idx].from);
                        setFindBar(false); setFindQuery(""); setFindIndex(0); editor?.commands.focus();
                    }} />
                </div>
            )}
        </div>
    );
}
