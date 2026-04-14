import { createContext, useContext, useCallback, useState, useEffect, useSyncExternalStore } from "react";
import { NodeViewWrapper, NodeViewContent } from "@tiptap/react";
import moment from "moment";
import strings from "@strings";
import store from "@api/store.js";

// Context for task actions — provided by Editor, consumed by each NodeView instance.
export const TaskContext = createContext(null);

const EFFORT_LABELS = ["", "XS", "S", "M", "L", "XL"];

// --- Shared derived state from a task object ---

function useTaskState(task) {
    const completed = !!task?.completed_at;
    const deferred = !!task?.is_deferred;
    const locked = !!task?.locked;
    const hasSchedule = !!task?.schedule;
    const hasStart = !!task?.start_date;
    const hasDue = !!task?.due_date;
    const hasRrule = !!task?.rrule;
    const effort = task?.effort || 0;
    // Use effective_due if available (Rust-computed), fall back to due_date for instant feedback
    const dueDateRaw = task?.effective_due || task?.due_date;
    const effectiveDue = dueDateRaw ? new Date(dueDateRaw) : null;

    let contentStyle = {};
    if (completed) {
        contentStyle = { textDecoration: "line-through", opacity: 0.4 };
    } else if (deferred) {
        contentStyle = { opacity: 0.3 };
    } else if (effectiveDue) {
        const hoursLeft = (effectiveDue - new Date()) / 3600000;
        if (hoursLeft < 0) contentStyle.color = "var(--red)";
        else if (hoursLeft < 24) contentStyle.color = "var(--orange)";
    }

    if (!completed && !deferred && effort >= 3) {
        const bgs = { 3: "rgba(47,51,56,0.03)", 4: "rgba(47,51,56,0.06)", 5: "rgba(47,51,56,0.08)" };
        contentStyle.background = bgs[effort] || undefined;
        if (effort === 5) contentStyle.fontWeight = 500;
    }

    let dueLabel = null;
    if (effectiveDue && !completed) {
        const due = moment(effectiveDue);
        const daysAway = due.diff(moment(), "days", true);
        if (daysAway < -1) dueLabel = due.fromNow();
        else if (daysAway < 0) dueLabel = "overdue";
        else if (daysAway < 1) dueLabel = due.fromNow();
        else if (daysAway < 7) dueLabel = due.format("dddd, h:mm a");
        else dueLabel = due.format("dddd, MMMM D, h:mm a");
    }

    return { completed, deferred, locked, hasSchedule, hasStart, hasDue, hasRrule, effort, contentStyle, dueLabel };
}

// --- Toolbar: shared between NodeView and StaticTaskView ---

function TaskToolbar({ task, effort, locked, hasSchedule, hasStart, hasDue, hasRrule, onEffort, onLock, onSchedule, onStart, onDue, onRrule, onCollapse, onReply, onReparent, shiftHeld }) {
    return (
        <div className="task-toolbar" contentEditable={false}>
            <span className="task-sidebar-btn task-effort-btn" onClick={onEffort} data-tooltip-id="rootp" data-tooltip-content={strings.TOOLTIPS.EFFORT}>
                {effort > 0
                    ? <span className="task-effort-label">{EFFORT_LABELS[effort]}</span>
                    : <i className="fa-solid fa-circle" />}
            </span>
            <span className="task-sidebar-btn task-lock-btn" onClick={onLock}
                style={!locked ? { color: "var(--blue)" } : undefined}
                data-tooltip-id="rootp" data-tooltip-content={locked ? strings.TOOLTIPS.ACTION_LOCK : strings.TOOLTIPS.ACTION_UNLOCK}>
                <i className="fa-solid fa-oil-can" />
            </span>
            <span className="task-sidebar-btn task-schedule-btn" onClick={onSchedule}
                style={hasSchedule ? { color: "var(--blue)" } : undefined}
                data-tooltip-id="rootp" data-tooltip-content={strings.TOOLTIPS.ACTION_SCHEDULE}>
                <i className="fa-solid fa-calendar-day" />
            </span>
            <span className="task-sidebar-btn task-start-btn" onClick={onStart}
                style={hasStart ? { color: "var(--blue)" } : undefined}
                data-tooltip-id="rootp" data-tooltip-content={strings.TOOLTIPS.START}>
                <i className="fa-solid fa-circle-play" />
            </span>
            <span className="task-sidebar-btn task-due-btn" onClick={onDue}
                style={hasDue ? { color: "var(--orange)" } : undefined}
                data-tooltip-id="rootp" data-tooltip-content={strings.TOOLTIPS.DUE}>
                <i className="fa-solid fa-circle-stop" />
            </span>
            <span className="task-sidebar-btn task-rrule-btn" onClick={onRrule}
                style={hasRrule ? { color: "var(--blue)" } : undefined}
                data-tooltip-id="rootp" data-tooltip-content={strings.TOOLTIPS.REPEAT}>
                <i className="fa-solid fa-rotate" />
            </span>
            <span className="task-sidebar-btn task-collapse-btn" onClick={onCollapse}
                data-tooltip-id="rootp" data-tooltip-content={strings.TOOLTIPS.COLLAPSE}>
                <i className="fa-solid fa-compress" />
            </span>
            <span className="task-sidebar-btn task-reply-btn" onClick={shiftHeld ? onReparent : onReply}
                data-tooltip-id="rootp" data-tooltip-content={shiftHeld ? strings.TOOLTIPS.ACTION_REPARENT : strings.TOOLTIPS.ACTION_REPLY}>
                <i className={shiftHeld ? "fa-solid fa-angles-right" : "fa-solid fa-angles-left"} />
            </span>
        </div>
    );
}

// --- Render ProseMirror content JSON as static React elements ---

function renderContentJSON(contentJson) {
    try {
        const parsed = typeof contentJson === "string" ? JSON.parse(contentJson) : contentJson;
        const children = parsed.content || [];
        return children.map((node, i) => {
            if (node.type === "text") {
                let el = node.text;
                if (node.marks) {
                    for (const mark of node.marks) {
                        if (mark.type === "bold") el = <strong key={i}>{el}</strong>;
                        else if (mark.type === "italic") el = <em key={i}>{el}</em>;
                        else if (mark.type === "code") el = <code key={i}>{el}</code>;
                    }
                }
                return <span key={i}>{el}</span>;
            }
            if (node.type === "tag") {
                return <span key={i} className="tag-node">@{node.attrs?.label || ""}</span>;
            }
            return null;
        });
    } catch {
        return null;
    }
}

// --- Static task view (no ProseMirror, used for off-screen chunks) ---

export function StaticTaskView({ task, onTaskDrag, onJumpToTask }) {
    const taskId = task.id;
    const state = useTaskState(task);

    return (
        <div className="task-block" data-task-id={taskId}>
            <div className="task-divider"><div className="task-divider-line" /></div>
            <div className="task-row">
                <span className="task-drag-handle">
                    <i className="fa-solid fa-grip-vertical" />
                </span>
                <span className="task-check task-sidebar-btn"
                    style={state.completed ? { color: "var(--green)" } : undefined}>
                    <i className="fa-solid fa-check" />
                </span>
                <p style={state.contentStyle}>
                    {renderContentJSON(task.content)}
                </p>
                {state.dueLabel && (
                    <span className="task-due-label">{state.dueLabel}</span>
                )}
                <TaskToolbar {...state} task={task} />
            </div>
        </div>
    );
}

// --- ProseMirror NodeView (used inside Editor) ---

export default function TaskNodeView({ node, editor, getPos }) {
    const taskId = node.attrs.taskId;
    // Subscribe to Redux store directly — bypasses any Provider tree issues
    // with Tiptap's portal rendering.
    const task = useSyncExternalStore(
        store.subscribe,
        () => store.getState().tasks.db.find(t => t.id === taskId),
    );
    const ctx = useContext(TaskContext);
    const state = useTaskState(task);

    const [shiftHeld, setShiftHeld] = useState(false);
    useEffect(() => {
        const down = (e) => { if (e.key === "Shift") setShiftHeld(true); };
        const up = (e) => { if (e.key === "Shift") setShiftHeld(false); };
        window.addEventListener("keydown", down);
        window.addEventListener("keyup", up);
        return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
    }, []);

    const stop = useCallback((e) => { e.stopPropagation(); e.preventDefault(); }, []);

    const onDividerClick = useCallback((e) => {
        stop(e);
        if (!editor) return;
        const pos = getPos();
        if (pos != null) {
            const n = editor.state.schema.nodes.paragraph.create();
            editor.view.dispatch(editor.state.tr.insert(pos, n));
            editor.commands.focus(pos + 1);
        }
    }, [editor, getPos, stop]);

    const onCheck = useCallback((e) => { stop(e); if (taskId) ctx?.completeTask(taskId); }, [taskId, ctx, stop]);
    const onEffort = useCallback((e) => { stop(e); if (taskId) ctx?.cycleEffort(taskId); }, [taskId, ctx, stop]);
    const onLock = useCallback((e) => { stop(e); if (taskId) ctx?.toggleLock(taskId); }, [taskId, ctx, stop]);
    const onSchedule = useCallback((e) => {
        stop(e);
        if (!taskId) return;
        if (e.shiftKey) {
            ctx?.clearSchedule?.(taskId);
        } else {
            ctx?.openDateModal(taskId, "schedule");
        }
    }, [taskId, ctx, stop]);
    const onStart = useCallback((e) => { stop(e); if (taskId) ctx?.openDateModal(taskId, "start_date"); }, [taskId, ctx, stop]);
    const onDue = useCallback((e) => { stop(e); if (taskId) ctx?.openDateModal(taskId, "due_date"); }, [taskId, ctx, stop]);
    const onRrule = useCallback((e) => { stop(e); if (taskId) ctx?.openRruleModal(taskId); }, [taskId, ctx, stop]);
    const onCollapse = useCallback((e) => { stop(e); if (taskId) ctx?.toggleCollapse(taskId); }, [taskId, ctx, stop]);
    const onReply = useCallback((e) => { stop(e); if (taskId) ctx?.handleReply(taskId); }, [taskId, ctx, stop]);
    const onReparent = useCallback((e) => { stop(e); if (taskId) ctx?.handleReparent(taskId); }, [taskId, ctx, stop]);
    const onDragHandle = useCallback((e) => {
        if (taskId && ctx?.onTaskDrag) ctx.onTaskDrag(taskId, e);
    }, [taskId, ctx]);

    return (
        <NodeViewWrapper className="task-block" data-task-id={taskId || ""}>
            <div className="task-divider" contentEditable={false} draggable={false} onClick={onDividerClick}>
                <div className="task-divider-line" />
            </div>
            <div className="task-row">
                <span className="task-drag-handle" contentEditable={false} onMouseDown={onDragHandle}>
                    <i className="fa-solid fa-grip-vertical" />
                </span>
                <span className="task-check task-sidebar-btn" contentEditable={false} onClick={onCheck}
                    style={state.completed ? { color: "var(--green)" } : undefined}
                    data-tooltip-id="rootp" data-tooltip-content={strings.TOOLTIPS.COMPLETE}>
                    <i className="fa-solid fa-check" />
                </span>
                <NodeViewContent as="p" style={state.contentStyle} />
                {state.dueLabel && (
                    <span className="task-due-label" contentEditable={false}>{state.dueLabel}</span>
                )}
                <TaskToolbar {...state} task={task}
                    onEffort={onEffort} onLock={onLock} onSchedule={onSchedule}
                    onStart={onStart} onDue={onDue} onRrule={onRrule}
                    onCollapse={onCollapse} onReply={onReply} onReparent={onReparent}
                    shiftHeld={shiftHeld} />
            </div>
        </NodeViewWrapper>
    );
}
