import { useEffect, useCallback, useRef } from "react";
import { useDispatch, useSelector } from "react-redux";
import { useEditor, EditorContent, ReactRenderer } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Node, mergeAttributes } from "@tiptap/core";
import { snapshot } from "@api/utils.js";
import { upsert, remove, setParent } from "@api/tasks.js";
import { v4 as uuid } from "uuid";
import { invoke } from "@tauri-apps/api/core";
import { Tag, extractTags } from "@components/TagExtension.js";
import TagSuggestion from "@components/TagSuggestion.jsx";
import ReplyArrows from "@components/ReplyArrows.jsx";
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
                ["span", { class: "task-check", contenteditable: "false" },
                    ["i", { class: "fa-solid fa-check" }]],
                ["p", mergeAttributes(HTMLAttributes), 0],
                ["div", { class: "task-toolbar", contenteditable: "false" },
                    ["span", { class: "task-reply-btn", "data-tooltip": "Reply" },
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
        rows.push({
            taskId: node.attrs.taskId,
            content,
            tags: JSON.stringify(extractTags(content)),
            position: idx,
            pmPos,
        });
        idx++;
        return false;
    });
    return rows;
}

// Deduplicate taskIds (Enter splits copy the taskId to the new paragraph)
function dedup(rows) {
    const seen = new Set();
    for (const row of rows) {
        if (row.taskId) {
            if (seen.has(row.taskId)) {
                row.taskId = null;
            } else {
                seen.add(row.taskId);
            }
        }
    }
}

// --- Component ---

export default function Editor() {
    const dispatch = useDispatch();
    const tasks = useSelector(state => state.tasks.db);
    const loading = useSelector(state => state.tasks.loading);

    const suppress = useRef(false);
    const guard = useRef(false);
    const hydrated = useRef(false);
    const visible = useRef(new Map());
    const updateTimer = useRef(null);
    const pendingParentId = useRef(null);

    useEffect(() => { dispatch(snapshot()); }, [dispatch]);

    const runPipeline = useCallback((editor) => {
        if (suppress.current || guard.current) return;

        const rows = readDoc(editor.state.doc);
        const ts = now();
        dedup(rows);

        // ---- INSERTS ----
        const needsId = rows.filter(r => !r.taskId);
        if (needsId.length > 0) {
            let tr = editor.state.tr;
            for (const row of needsId) {
                const id = uuid();
                row.taskId = id;
                tr.setNodeMarkup(row.pmPos, undefined, { taskId: id });
                const parentId = pendingParentId.current;
                pendingParentId.current = null;
                dispatch(upsert({
                    id, content: row.content, position: row.position,
                    tags: row.tags, parent_id: parentId, created_at: ts, updated_at: ts,
                }));
                visible.current.set(id, {
                    content: row.content, position: row.position, created_at: ts,
                });
            }
            tr.setMeta("sync", true);
            guard.current = true;
            editor.view.dispatch(tr);
            guard.current = false;
        }

        // ---- DELETES ----
        const currentIds = new Set(rows.map(r => r.taskId));
        for (const [id] of visible.current) {
            if (!currentIds.has(id)) {
                dispatch(remove(id));
                visible.current.delete(id);
            }
        }

        // ---- UPDATES (debounced) ----
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
                    dispatch(upsert({
                        id: row.taskId, content: row.content, position: row.position,
                        tags: row.tags, created_at: prev.created_at, updated_at: ts2,
                    }));
                    visible.current.set(row.taskId, {
                        content: row.content, position: row.position,
                        created_at: prev.created_at,
                    });
                }
            }
        }, 300);
    }, [dispatch]);

    useEffect(() => () => {
        if (updateTimer.current) clearTimeout(updateTimer.current);
    }, []);

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
                    char: "@",
                    allowSpaces: false,
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
                            return all
                                .filter(t => t.toLowerCase().includes(query.toLowerCase()))
                                .slice(0, 8);
                        } catch {
                            return [];
                        }
                    },
                    render: () => {
                        let component;
                        let popup;
                        return {
                            onStart: (props) => {
                                component = new ReactRenderer(TagSuggestion, {
                                    props, editor: props.editor,
                                });
                                popup = document.createElement("div");
                                popup.style.position = "absolute";
                                popup.style.zIndex = "30000";
                                popup.appendChild(component.element);
                                document.body.appendChild(popup);
                                const rect = props.clientRect?.();
                                if (rect) {
                                    popup.style.left = rect.left + "px";
                                    popup.style.top = rect.bottom + 4 + "px";
                                }
                            },
                            onUpdate: (props) => {
                                component?.updateProps(props);
                                const rect = props.clientRect?.();
                                if (rect && popup) {
                                    popup.style.left = rect.left + "px";
                                    popup.style.top = rect.bottom + 4 + "px";
                                }
                            },
                            onKeyDown: (props) => component?.ref?.onKeyDown(props),
                            onExit: () => {
                                component?.destroy();
                                popup?.remove();
                            },
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
            // Detect full-document selection (Cmd+A) and apply visual highlight
            const { from, to } = editor.state.selection;
            const docSize = editor.state.doc.content.size;
            const isAll = from === 0 && to === docSize;
            const el = editor.view.dom;
            const blocks = el.querySelectorAll(".task-block");
            blocks.forEach(b => b.classList.toggle("all-selected", isAll));

            // Auto-scroll only when cursor is in the last paragraph
            try {
                const resolved = editor.state.doc.resolve(from);
                const nodeIndex = resolved.index(0);
                const lastIndex = editor.state.doc.childCount - 1;
                if (nodeIndex === lastIndex) {
                    const coords = editor.view.coordsAtPos(from);
                    const container = document.querySelector(".editor-content");
                    if (coords && container) {
                        const containerRect = container.getBoundingClientRect();
                        const cursorY = coords.top - containerRect.top + container.scrollTop;
                        const target = cursorY - container.clientHeight * 0.4;
                        // Slow smooth scroll via animation frame
                        const start = container.scrollTop;
                        const diff = target - start;
                        if (Math.abs(diff) < 5) return;
                        const duration = 250;
                        const startTime = performance.now();
                        function step(now) {
                            const t = Math.min((now - startTime) / duration, 1);
                            const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
                            container.scrollTop = start + diff * ease;
                            if (t < 1) requestAnimationFrame(step);
                        }
                        requestAnimationFrame(step);
                    }
                }
            } catch {}
        },
    });

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
                return { type: "paragraph", attrs: { taskId: t.id },
                    content: [{ type: "text", text: t.content }] };
            }
        });

        visible.current = map;
        suppress.current = true;
        editor.commands.setContent({ type: "doc", content });
        setTimeout(() => {
            suppress.current = false;
            // Focus end and let onSelectionUpdate handle scrolling
            editor.commands.focus("end");
        }, 0);
    }, [loading, editor]);

    const handleClick = useCallback((e) => {
        if (!editor) return;
        // Divider click: insert a new empty paragraph above the clicked task
        const divider = e.target.closest(".task-divider");
        if (divider) {
            e.stopPropagation();
            e.preventDefault();
            const block = divider.closest(".task-block");
            if (block) {
                // Find which paragraph node this block corresponds to
                const pos = editor.view.posAtDOM(block, 0);
                if (pos != null) {
                    // Resolve to find the start of this paragraph node
                    const resolved = editor.state.doc.resolve(pos);
                    const before = resolved.before(resolved.depth);
                    const node = editor.state.schema.nodes.paragraph.create();
                    const tr = editor.state.tr.insert(before, node);
                    editor.view.dispatch(tr);
                    editor.commands.focus(before + 1);
                }
            }
            return;
        }

        // Reply button click: insert new task at the bottom as a reply
        const replyBtn = e.target.closest(".task-reply-btn");
        if (replyBtn) {
            e.stopPropagation();
            e.preventDefault();
            const block = replyBtn.closest(".task-block");
            const parentTaskId = block?.getAttribute("data-task-id");
            if (block && parentTaskId) {
                pendingParentId.current = parentTaskId;
                const endPos = editor.state.doc.content.size;
                const node = editor.state.schema.nodes.paragraph.create();
                const tr = editor.state.tr.insert(endPos, node);
                editor.view.dispatch(tr);
                editor.commands.focus("end");
            }
            return;
        }

        // Click on empty area: focus end
        if (e.target.classList.contains("editor-content"))
            editor.commands.focus("end");
    }, [editor, dispatch]);

    if (loading) return <div className="editor"><div className="drag-region" data-tauri-drag-region /></div>;

    return (
        <div className="editor">
            <div className="drag-region" data-tauri-drag-region />
            <div className="editor-content" onClick={handleClick} style={{ position: "relative" }}>
                <EditorContent editor={editor} />
                <ReplyArrows editorRef={editor?.view?.dom} />
            </div>
        </div>
    );
}
