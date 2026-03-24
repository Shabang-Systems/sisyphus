import { useEffect, useCallback, useRef, useState, useMemo } from "react";
import { useDispatch, useSelector } from "react-redux";
import { useEditor, EditorContent, ReactRenderer, ReactNodeViewRenderer } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Node, mergeAttributes, Extension } from "@tiptap/core";
import TaskNodeViewComponent, { TaskContext } from "@components/TaskNodeView.jsx";
import { Fragment } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { RRule } from "rrule";
import moment from "moment";
import { snapshot } from "@api/utils.js";
import { tick } from "@api/ui.js";
import { updateTask, addTask, dropTask } from "@api/tasks.js";
import { txSet, txCreate, txDelete } from "@api/sync.js";
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
    // renderHTML is used for serialization (copy/paste, getJSON) — not for display.
    renderHTML({ node, HTMLAttributes }) {
        return ["p", mergeAttributes(HTMLAttributes), 0];
    },
    addNodeView() {
        return ReactNodeViewRenderer(TaskNodeViewComponent);
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
    const [isHydrated, setIsHydrated] = useState(false);
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
    tasksRef.current = allTasks; // synchronous — always fresh for pipeline reads
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
                // Optimistic: add task to Redux immediately, sync to Rust in background
                dispatch(addTask({
                    id, content, position: row.position,
                    tags: rruleData?.tags || row.tags,
                    parent_id: rruleData?.parent_id || parentId || null,
                    start_date: rruleData?.start_date || null,
                    due_date: rruleData?.due_date || null,
                    completed_at: null,
                    rrule: rruleData?.rrule || null,
                    effort: 0,
                    schedule: scheduleDate || null,
                    locked: scheduleDate ? true : false,
                    effective_due: null,
                    is_deferred: false,
                    created_at: ts, updated_at: ts,
                }));
                txCreate({
                    id, content, position: row.position,
                    tags: rruleData?.tags || row.tags,
                    parent_id: rruleData?.parent_id || parentId || null,
                    start_date: rruleData?.start_date || null,
                    due_date: rruleData?.due_date || null,
                    completed_at: null, rrule: rruleData?.rrule || null,
                    effort: 0, schedule: scheduleDate || null,
                    locked: scheduleDate ? true : false,
                    created_at: ts, updated_at: ts,
                });
                visible.current.set(id, { content, position: row.position, created_at: ts });
            }
            tr.setMeta("sync", true);
            guard.current = true;
            editor.view.dispatch(tr);
            guard.current = false;
            if (taskList) localChangeRef.current = true;
        }

        const currentIds = new Set(rows.map(r => r.taskId));
        for (const [id] of visible.current) {
            if (!currentIds.has(id)) {
                dispatch(dropTask(id)); txDelete(id);
                visible.current.delete(id);
                if (taskList) localChangeRef.current = true;
            }
        }

        // In taskList mode: if the doc has a single empty paragraph with a known taskId,
        // the user backspaced the last task. ProseMirror won't delete it (requires ≥1 node),
        // so we detect it here and remove the task from the DB.
        if (taskList && rows.length === 1 && rows[0].taskId) {
            const content = rows[0].content;
            const textRe = /\"text\"\s*:\s*\"[^\"]+\"/;
            if (!textRe.test(content) && visible.current.has(rows[0].taskId)) {
                dispatch(dropTask(rows[0].taskId)); txDelete(rows[0].taskId);
                visible.current.delete(rows[0].taskId);
                localChangeRef.current = true;
            }
        }

        // Diff content/position changes and dispatch immediately to Redux + queue transactions
        const fresh = readDoc(editor.state.doc);
        dedup(fresh);
        const ts2 = now();
        const taskMap = new Map(tasksRef.current.map(t => [t.id, t]));
        for (const row of fresh) {
            if (!row.taskId) continue;
            const prev = visible.current.get(row.taskId);
            if (!prev) continue;
            const posChanged = !taskList && prev.position !== row.position;
            if (prev.content !== row.content || posChanged) {
                const pos = taskList ? (taskMap.get(row.taskId)?.position ?? row.position) : row.position;
                dispatch(updateTask({ id: row.taskId, changes: { content: row.content, tags: row.tags, position: pos, updated_at: ts2 } }));
                txSet(row.taskId, "content", row.content);
                txSet(row.taskId, "tags", row.tags);
                txSet(row.taskId, "position", pos);
                visible.current.set(row.taskId, { content: row.content, position: row.position, created_at: prev.created_at });
            }
        }
    }, [dispatch]);

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
            // All button state, effort labels, content styling, and due date labels
            // are now handled by the React NodeView component (TaskNodeView.jsx).
            // This effect only needs to exist for the collapse style sheet.
            newCache.set(taskId, "");
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
        editorProps: {
            attributes: { autocomplete: "off", autocorrect: "off", autocapitalize: "off", spellcheck: "false" },
        },
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

            // No autoscroll here — initial centering handled by loadTasks.
        },
    });

    // --- Jump to task (cross-view navigation) ---
    const scrollToPos = useCallback((pos) => {
        if (!editor) return;
        const editorDom = editor.view?.dom;
        if (!editorDom) return;
        const container = editorDom.closest(".editor-content");
        if (!container) return;
        try {
            const coords = editor.view.coordsAtPos(pos);
            if (coords) {
                const containerRect = container.getBoundingClientRect();
                const cursorY = coords.top - containerRect.top + container.scrollTop;
                container.scrollTop = cursorY - container.clientHeight / 2;
            }
        } catch {}
    }, [editor]);

    useEffect(() => {
        if (!jumpToTaskId || !editor || !isHydrated) return;

        if (replyToTaskId) {
            // 1. Insert new paragraph at end with parent link
            pendingParentId.current = replyToTaskId;
            const endPos = editor.state.doc.content.size;
            editor.view.dispatch(editor.state.tr.insert(endPos, editor.state.schema.nodes.paragraph.create()));
            // 2. Focus it
            editor.commands.focus("end");
            // 3. Scroll to it
            requestAnimationFrame(() => scrollToPos(editor.state.doc.content.size - 1));
        } else {
            // Jump without reply — just focus + scroll to the target
            let targetPos = null;
            editor.state.doc.descendants((node, pos) => {
                if (node.type.name === "paragraph" && node.attrs.taskId === jumpToTaskId) {
                    targetPos = pos;
                }
                return false;
            });
            if (targetPos != null) {
                editor.commands.setTextSelection(targetPos + 1);
                editor.commands.focus();
                requestAnimationFrame(() => scrollToPos(targetPos + 1));
            }
        }
        if (onJumpHandled) onJumpHandled();
    }, [jumpToTaskId, replyToTaskId, editor, onJumpHandled, isHydrated, scrollToPos]);

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
    const jumpToTaskIdRef = useRef(jumpToTaskId);
    jumpToTaskIdRef.current = jumpToTaskId;

    const loadTasks = useCallback((taskArray, preserveOrder = false) => {
        if (!editor) return;
        const sorted = preserveOrder ? taskArray : [...taskArray].sort((a, b) => a.position - b.position);
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
            // Planning mode: scroll to end. Skip focus if there's a pending jump.
            if (!jumpToTaskIdRef.current) editor.commands.focus("end");
            requestAnimationFrame(() => {
                const editorDom = editor.view?.dom;
                if (!editorDom) return;
                const container = editorDom.closest(".editor-content");
                if (!container) return;
                try {
                    const endPos = editor.state.doc.content.size - 1;
                    const coords = editor.view.coordsAtPos(Math.max(endPos, 0));
                    if (coords) {
                        const containerRect = container.getBoundingClientRect();
                        const cursorY = coords.top - containerRect.top + container.scrollTop;
                        container.scrollTop = cursorY - container.clientHeight / 2;
                    }
                } catch {
                    container.scrollTop = container.scrollHeight;
                }
            });
        }
    }, [editor, isBrowse]);

    // Initial hydration (planning mode — exclude completed tasks)
    useEffect(() => {
        if (loading || !editor || hydrated.current || isBrowse) return;
        hydrated.current = true;
        setIsHydrated(true);
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
        setIsHydrated(true);
        loadTasks(taskList, true);
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

    // Force a specific NodeView to re-render by touching its ProseMirror attrs.
    // This is needed because NodeViews read task state from tasksRef (a ref),
    // --- Modal callbacks (optimistic: update Redux immediately, sync to Rust in background) ---

    const handleDateChange = useCallback((taskId, field, date) => {
        const val = date ? date.toISOString() : null;
        if (field === "schedule") {
            dispatch(updateTask({ id: taskId, changes: { schedule: val, locked: !!date, updated_at: now() } }));
            txSet(taskId, "schedule", val);
            txSet(taskId, "locked", !!date);
        } else {
            const changes = { [field]: val, updated_at: now() };
            if (field === "start_date") {
                changes.is_deferred = val ? val > new Date().toISOString() : false;
            }
            if (field === "due_date") {
                // Optimistic: set effective_due immediately so the UI reflects the change.
                // Rust will recompute the true effective_due (min of descendant tree) on upsert.
                changes.effective_due = val;
            }
            dispatch(updateTask({ id: taskId, changes }));
            txSet(taskId, field, val);
        }
    }, [dispatch]);

    const handleRruleChange = useCallback((taskId, rule) => {
        dispatch(updateTask({ id: taskId, changes: { rrule: rule, updated_at: now() } }));
        txSet(taskId, "rrule", rule);
    }, [dispatch]);

    const cycleEffort = useCallback((taskId) => {
        const task = tasksRef.current.find(t => t.id === taskId);
        console.log("[effort] cycleEffort", taskId, "task=", !!task, "effort=", task?.effort);
        if (!task) return;
        const next = ((task.effort || 0) + 1) % 5; // 0=none, 1=XS, 2=S, 3=M, 4=L
        dispatch(updateTask({ id: taskId, changes: { effort: next, updated_at: now() } }));
        txSet(taskId, "effort", next);
    }, [dispatch]);

    const completeTask = useCallback((taskId) => {
        const task = tasksRef.current.find(t => t.id === taskId);
        if (!task) return;
        const ts = now();

        if (task.completed_at) {
            dispatch(updateTask({ id: taskId, changes: { completed_at: null, updated_at: ts } }));
            txSet(taskId, "completed_at", null);
            return;
        }

        dispatch(updateTask({ id: taskId, changes: { completed_at: ts, updated_at: ts } }));
        txSet(taskId, "completed_at", ts);

        // If rrule, create next occurrence via pipeline
        if (task.rrule && editor) {
            try {
                const rule = RRule.fromString(task.rrule);
                const first = rule.after(new Date(0), true);
                const second = rule.after(first);
                const intervalMs = second - first;

                let newStart = null;
                let newDue = null;

                if (task.start_date && task.due_date) {
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

                    try {
                        const parsed = JSON.parse(task.content);
                        const endPos = editor.state.doc.content.size;
                        const newNode = editor.state.schema.nodeFromJSON({ ...parsed, attrs: {} });
                        editor.view.dispatch(editor.state.tr.insert(endPos, newNode));
                        editor.commands.focus("end");
                    } catch {
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
            // In Action view (taskList mode only): backspace/delete on the last empty
            // paragraph removes the task. ProseMirror won't delete the last node, so
            // the onUpdate pipeline never fires — we must handle it here.
            // NOT in planning view, where the last paragraph is just an empty line.
            if (taskList && !isBrowse && (e.key === "Backspace" || e.key === "Delete") && editor) {
                // Only handle if the keypress is inside THIS editor instance
                const editorDom = editor.view?.dom;
                if (editorDom && editorDom.contains(e.target)) {
                    const doc = editor.state.doc;
                    if (doc.childCount === 1) {
                        const node = doc.firstChild;
                        const tid = node?.attrs?.taskId;
                        if (tid && node.textContent === "") {
                            e.preventDefault(); e.stopPropagation();
                            dispatch(dropTask(tid)); txDelete(tid);
                            visible.current.delete(tid);
                            localChangeRef.current = true;
                            return;
                        }
                    }
                }
            }
            // Block Enter in browse mode — no new task creation
            // Only if the keypress is inside this editor's DOM
            if (isBrowse && e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
                const editorDom = editor?.view?.dom;
                if (editorDom && editorDom.contains(e.target)) {
                    e.preventDefault(); e.stopPropagation();
                    return;
                }
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
    }, [editor, getActiveTaskId, completeTask, taskList, isBrowse, dispatch]);

    // --- Click handlers ---

    // Click handlers — most button clicks are now handled by TaskNodeView directly.
    // Only the editor-content background click remains here.
    const handleClick = useCallback((e) => {
        if (!editor) return;
        if (e.target.classList.contains("editor-content")) editor.commands.focus("end");
    }, [editor]);

    // --- Task context for NodeView ---

    const toggleLock = useCallback((taskId) => {
        const task = tasksRef.current.find(t => t.id === taskId);
        if (!task) return;
        dispatch(updateTask({ id: taskId, changes: { locked: !task.locked, updated_at: now() } }));
        txSet(taskId, "locked", !task.locked);
    }, [dispatch]);

    const openDateModal = useCallback((taskId, field) => {
        setRruleModal(null);
        setDateModal(prev => prev?.taskId === taskId && prev?.field === field ? null : { taskId, field });
    }, []);

    const openRruleModal = useCallback((taskId) => {
        setDateModal(null);
        setRruleModal(prev => prev?.taskId === taskId ? null : { taskId });
    }, []);

    const toggleCollapse = useCallback((taskId) => {
        setDateModal(null); setRruleModal(null);
        setCollapsedRoot(prev => prev === taskId ? null : taskId);
    }, []);

    const handleReply = useCallback((taskId) => {
        setDateModal(null); setRruleModal(null);
        if (onJumpToTask) {
            onJumpToTask(taskId);
        } else if (editor) {
            pendingParentId.current = taskId;
            const endPos = editor.state.doc.content.size;
            editor.view.dispatch(editor.state.tr.insert(endPos, editor.state.schema.nodes.paragraph.create()));
            editor.commands.focus("end");
        }
    }, [editor, onJumpToTask]);

    // Stable context — callbacks are all useCallbacks, tasksRef is a ref.
    // NodeViews read from tasksRef on mount/ProseMirror update, not on every Redux change.
    const taskContextValue = useMemo(() => ({
        tasksRef,
        completeTask,
        cycleEffort,
        toggleLock,
        openDateModal,
        openRruleModal,
        toggleCollapse,
        handleReply,
        onTaskDrag: onTaskDragRef.current,
    }), [completeTask, cycleEffort, toggleLock, openDateModal, openRruleModal, toggleCollapse, handleReply]);

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
                <TaskContext.Provider value={taskContextValue}>
                <EditorContent editor={editor} />
                {!taskList && <ReplyArrows editorRef={editor?.view?.dom} collapsedRoot={collapsedRoot} focusedTaskId={isBrowse ? null : focusedTaskId} />}
                </TaskContext.Provider>
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
                            requestAnimationFrame(() => {
                                const el = document.querySelector(".find-active");
                                const contEl = editor?.view?.dom?.closest(".editor-content");
                                if (el && contEl) {
                                    const elRect = el.getBoundingClientRect();
                                    const contRect = contEl.getBoundingClientRect();
                                    const target = elRect.top - contRect.top + contEl.scrollTop - contEl.clientHeight / 2;
                                    contEl.scrollTo({ top: target, behavior: "smooth" });
                                }
                            });
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
