import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useSelector, useDispatch } from "react-redux";
import { invoke } from "@tauri-apps/api/core";
import { upsert } from "@api/tasks.js";
import { snapshot } from "@api/utils.js";
import moment from "moment";
import strings from "@strings";
import Editor from "@views/Editor.jsx";
import "./Action.css";

const DOW_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const CHUNK_LABELS = strings.CHUNK_LABELS;

function getGreeting() {
    const h = new Date().getHours();
    if (h < 12) return strings.TEMPORAL_GREETINGS[0];
    if (h < 19) return strings.TEMPORAL_GREETINGS[1];
    return strings.TEMPORAL_GREETINGS[2];
}

function dayLabel(dayOffset) {
    const d = new Date();
    d.setDate(d.getDate() + dayOffset);
    return `${DOW_FULL[d.getDay()]}, ${d.getMonth() + 1}/${d.getDate()}`;
}

function now() { return new Date().toISOString().replace("T", " ").slice(0, 19); }

export default function Action({ onJumpToTask, triggerRebalance }) {
    const dispatch = useDispatch();
    const allTasks = useSelector(state => state.tasks.db);
    const taskMapMemo = useMemo(() => new Map(allTasks.map(t => [t.id, t])), [allTasks]);
    const taskMap = useRef(taskMapMemo);
    taskMap.current = taskMapMemo;
    const [dragState, setDragState] = useState(null);
    const [dropTarget, setDropTarget] = useState(null);
    const dropTargetRef = useRef(null);

    // Snapshot is already dispatched by the main Editor on mount and after schedule computation.
    // Only dispatch here if Redux is still in loading state (i.e., Action is the first view).
    const loading = useSelector(state => state.tasks.loading);
    useEffect(() => { if (loading) dispatch(snapshot()); }, [loading, dispatch]);

    // Drag to reschedule
    const handleTaskDrag = useCallback((taskId, e) => {
        const task = taskMap.current.get(taskId);
        const textRe = /"text"\s*:\s*"([^"]+)"/;
        const match = task ? textRe.exec(task.content) : null;
        const name = match ? match[1] : taskId.slice(0, 8);
        setDragState({ taskId, name, x: e.clientX, y: e.clientY });
    }, []);

    const handleDropEnter = useCallback((day, chunkIdx) => {
        dropTargetRef.current = { day, chunkIdx };
        setDropTarget({ day, chunkIdx });
    }, []);

    const handleDropClear = useCallback(() => {
        dropTargetRef.current = null;
        setDropTarget(null);
    }, []);

    const [dragPos, setDragPos] = useState(null);

    useEffect(() => {
        if (!dragState) return;
        const onMove = (e) => setDragPos({ x: e.clientX, y: e.clientY });
        const onUp = () => {
            const dt = dropTargetRef.current;
            const tid = dragState.taskId;
            setDragState(null);
            setDragPos(null);
            setDropTarget(null);
            dropTargetRef.current = null;
            if (dt) {
                const d = new Date();
                d.setDate(d.getDate() + dt.day);
                d.setHours(dt.chunkIdx * 4, 0, 0, 0);
                const task = taskMap.current.get(tid);
                if (task) {
                    dispatch(upsert({
                        ...task,
                        schedule: d.toISOString(),
                        locked: true,
                        updated_at: now(),
                    })).then(() => dispatch(snapshot()));
                    if (triggerRebalance) triggerRebalance();
                }
            }
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
        return () => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
        };
    }, [dragState, dispatch]);

    // Group scheduled tasks by (dayDiff, chunkIdx).
    // Stabilize task list references: only produce new arrays when membership or order changes,
    // not on every Redux content update. This prevents Editor re-hydration churn.
    const prevChunkTasksRef = useRef(new Map()); // key → task id string for equality check
    const prevChunkArraysRef = useRef(new Map()); // key → task array (stable reference)

    const groups = useMemo(() => {
        const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
        const result = new Map(); // key: "day:chunk"
        const daySet = new Set();

        for (const task of allTasks) {
            if (!task.schedule) continue;
            if (task.is_deferred) continue;
            if (task.completed_at) continue;

            const schedDate = new Date(task.schedule);
            const dayDiff = Math.floor((schedDate - todayStart) / 86400000);
            if (dayDiff < 0) continue;
            const chunkIdx = Math.floor(schedDate.getHours() / 4);
            const key = `${dayDiff}:${chunkIdx}`;

            if (!result.has(key)) result.set(key, { dayDiff, chunkIdx, tasks: [] });
            result.get(key).tasks.push(task);
            daySet.add(dayDiff);
        }

        // Sort tasks within each chunk by position
        for (const g of result.values()) {
            g.tasks.sort((a, b) => a.position - b.position);
        }

        // Stabilize: reuse previous task array reference if membership hasn't changed
        const newIdMap = new Map();
        const newArrayMap = new Map();
        for (const [key, g] of result) {
            const idStr = g.tasks.map(t => t.id).join(",");
            newIdMap.set(key, idStr);
            if (prevChunkTasksRef.current.get(key) === idStr) {
                // Membership unchanged — reuse old array to keep referential equality
                newArrayMap.set(key, prevChunkArraysRef.current.get(key));
            } else {
                newArrayMap.set(key, g.tasks);
            }
        }
        prevChunkTasksRef.current = newIdMap;
        prevChunkArraysRef.current = newArrayMap;

        // Build ordered list
        const days = [...daySet].sort((a, b) => a - b);
        const ordered = [];
        for (const day of days) {
            ordered.push({ type: "day", dayDiff: day, label: dayLabel(day) });
            const dayChunks = [...result.values()]
                .filter(g => g.dayDiff === day)
                .sort((a, b) => a.chunkIdx - b.chunkIdx);
            for (const dc of dayChunks) {
                const key = `${dc.dayDiff}:${dc.chunkIdx}`;
                ordered.push({
                    type: "chunk",
                    dayDiff: day,
                    chunkIdx: dc.chunkIdx,
                    label: CHUNK_LABELS[dc.chunkIdx] || "",
                    tasks: newArrayMap.get(key) || dc.tasks,
                });
            }
        }
        return ordered;
    }, [allTasks]);

    // Parked tasks: no schedule, not completed, not deferred, has content.
    // Stabilize reference — only produce new array when membership changes.
    const prevParkedIdsRef = useRef("");
    const prevParkedRef = useRef([]);
    const parkedTasks = useMemo(() => {
        const textRe = /"text"\s*:\s*"[^"]+"/;
        const result = allTasks.filter(t =>
            !t.schedule && !t.completed_at && !t.is_deferred && textRe.test(t.content)
        );
        const idStr = result.map(t => t.id).join(",");
        if (idStr === prevParkedIdsRef.current) return prevParkedRef.current;
        prevParkedIdsRef.current = idStr;
        prevParkedRef.current = result;
        return result;
    }, [allTasks]);

    // Foveated rendering: render groups until we hit TASK_BUDGET tasks, load more on scroll.
    // Budget is a high-water mark — never shrinks, only grows. Prevents unmount/remount churn.
    const TASK_BUDGET = 50;
    const taskBudgetRef = useRef(TASK_BUDGET);
    const [taskBudget, setTaskBudget] = useState(TASK_BUDGET);

    const renderedGroups = useMemo(() => {
        let count = 0;
        const result = [];
        for (const item of groups) {
            result.push(item);
            if (item.type === "chunk") {
                count += item.tasks.length;
                if (count >= taskBudget) break;
            }
        }
        return result;
    }, [groups, taskBudget]);

    const totalTasks = useMemo(() =>
        groups.reduce((s, g) => s + (g.type === "chunk" ? g.tasks.length : 0), 0),
    [groups]);

    const onScroll = useCallback((e) => {
        const el = e.target;
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 300) {
            const newBudget = Math.min(taskBudgetRef.current + TASK_BUDGET, totalTasks);
            if (newBudget > taskBudgetRef.current) {
                taskBudgetRef.current = newBudget;
                setTaskBudget(newBudget);
            }
        }
    }, [totalTasks]);

    return (
        <div className="action" onScroll={onScroll}>
            <div className="action-main">
                <div className="action-greeting">
                    <div className="action-greeting-head">{getGreeting()},</div>
                    <div className="action-greeting-sub">it's {moment().format("dddd, MMMM D")}.</div>
                </div>


                {parkedTasks.length > 0 && (
                    <div className="action-parked">
                        <div className="action-parked-header">
                            <span className="action-parked-label">unable to schedule</span>
                        </div>
                        <div className="action-parked-editor">
                            <Editor
                                mode="browse"
                                taskList={parkedTasks}
                                onTaskDrag={handleTaskDrag}
                                onJumpToTask={onJumpToTask}
                                triggerRebalance={triggerRebalance}
                            />
                        </div>
                    </div>
                )}

                <div className="action-timeline">
                    {renderedGroups.map((item, i) =>
                        item.type === "day" ? (
                            <div key={`day-${item.dayDiff}`} className="action-day-header">
                                <span className="action-day-label">{item.label}</span>
                            </div>
                        ) : (
                            <div key={`chunk-${item.dayDiff}-${item.chunkIdx}`} className="action-chunk">
                                <div className="action-section-row">
                                    <span className="action-section-label">{item.label}</span>
                                </div>
                                <div className="action-editor-wrap">
                                    <Editor
                                        mode="editor"
                                        taskList={item.tasks}
                                        jumpToTaskId={null}
                                        onTaskDrag={handleTaskDrag}
                                        onJumpToTask={onJumpToTask}
                                        triggerRebalance={triggerRebalance}
                                        scheduleDate={(() => {
                                            const d = new Date();
                                            d.setDate(d.getDate() + item.dayDiff);
                                            d.setHours(item.chunkIdx * 4, 0, 0, 0);
                                            return d.toISOString();
                                        })()}
                                    />
                                </div>
                            </div>
                        )
                    )}
                    <div className="action-spacer" />
                </div>
            </div>

            {dragState && dragPos && (
                <div className="action-drag-ghost" style={{ left: dragPos.x + 12, top: dragPos.y - 10 }}>
                    {dragState.name}
                </div>
            )}

            {dragState && (() => {
                // Compute load per cell and find current task's schedule
                const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
                const loadMap = new Map();
                let maxLoad = 1;
                let currentDay = -1, currentChunk = -1;

                for (const t of allTasks) {
                    if (!t.schedule || t.completed_at) continue;
                    const sd = new Date(t.schedule);
                    const dd = Math.floor((sd - todayStart) / 86400000);
                    if (dd < 0 || dd >= 14) continue;
                    const ci = Math.floor(sd.getHours() / 4);
                    const key = `${dd}:${ci}`;
                    const effort = t.effort || 2;
                    loadMap.set(key, (loadMap.get(key) || 0) + effort);
                    if (t.id === dragState.taskId) { currentDay = dd; currentChunk = ci; }
                }
                for (const v of loadMap.values()) { if (v > maxLoad) maxLoad = v; }

                return (
                    <div className="action-drop-overlay" onMouseMove={(e) => {
                        if (!e.target.classList.contains("action-drop-cell")) {
                            dropTargetRef.current = null;
                            setDropTarget(null);
                        }
                    }}>
                        <div className="action-drop-header">
                            <div />
                            {CHUNK_LABELS.map((label, i) => (
                                <div key={i} className="action-drop-col-label">{label}</div>
                            ))}
                        </div>
                        {[...Array(14)].map((_, dayIdx) => (
                            <div key={dayIdx} className="action-drop-row">
                                <div className={`action-drop-row-label${dayIdx === 0 ? " today" : ""}`}>{dayLabel(dayIdx)}</div>
                                {CHUNK_LABELS.map((_, chunkIdx) => {
                                    const isCurrent = dayIdx === currentDay && chunkIdx === currentChunk;
                                    const isActive = dropTarget?.day === dayIdx && dropTarget?.chunkIdx === chunkIdx;
                                    const load = loadMap.get(`${dayIdx}:${chunkIdx}`) || 0;
                                    const intensity = Math.min(load / maxLoad, 1);
                                    const bg = isActive ? undefined
                                        : isCurrent ? "rgba(55, 165, 190, 0.15)"
                                        : load > 0 ? `rgba(242, 114, 0, ${0.06 + intensity * 0.18})`
                                        : undefined;
                                    return (
                                        <div
                                            key={chunkIdx}
                                            className={`action-drop-cell${isActive ? " active" : ""}${isCurrent ? " current" : ""}`}
                                            style={bg ? { background: bg } : undefined}
                                            onMouseEnter={() => handleDropEnter(dayIdx, chunkIdx)}
                                            onMouseLeave={handleDropClear}
                                        />
                                    );
                                })}
                            </div>
                        ))}
                    </div>
                );
            })()}
        </div>
    );
}
