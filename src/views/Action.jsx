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

export default function Action({ onJumpToTask }) {
    const dispatch = useDispatch();
    const allTasks = useSelector(state => state.tasks.db);
    const taskMapMemo = useMemo(() => new Map(allTasks.map(t => [t.id, t])), [allTasks]);
    const taskMap = useRef(taskMapMemo);
    taskMap.current = taskMapMemo;
    const [loading, setLoading] = useState(false);
    const [dragState, setDragState] = useState(null);
    const [dropTarget, setDropTarget] = useState(null);
    const dropTargetRef = useRef(null);

    useEffect(() => { dispatch(snapshot()); }, [dispatch]);

    const solve = useCallback(async () => {
        setLoading(true);
        try {
            await invoke("compute_schedule");
            await dispatch(snapshot());
        } catch { /* ignore */ }
        setLoading(false);
    }, [dispatch]);

    useEffect(() => { solve(); }, [solve]);

    // Drag to reschedule
    const handleTaskDrag = useCallback((taskId, e) => {
        const task = taskMap.current.get(taskId);
        const textRe = /"text"\s*:\s*"([^"]+)"/;
        const match = task ? textRe.exec(task.content) : null;
        const name = match ? match[1] : taskId.slice(0, 8);
        setDragState({ taskId, name, x: e.clientX, y: e.clientY });
    }, []);

    const handleDropEnter = useCallback((day, chunkIdx) => {
        const dt = { day, chunkIdx };
        dropTargetRef.current = dt;
        setDropTarget(dt);
    }, []);

    const handleDropLeave = useCallback(() => {
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

    // Group scheduled tasks by (dayDiff, chunkIdx)
    const groups = useMemo(() => {
        const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
        const textRe = /"text"\s*:\s*"([^"]+)"/;
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

        // Sort tasks within each chunk by position (list order from planning view)
        for (const g of result.values()) {
            g.tasks.sort((a, b) => a.position - b.position);
        }

        // Build ordered list of (day header, section label, chunk group)
        const days = [...daySet].sort((a, b) => a - b);
        const ordered = [];
        for (const day of days) {
            ordered.push({ type: "day", dayDiff: day, label: dayLabel(day) });
            const dayChunks = [...result.values()]
                .filter(g => g.dayDiff === day)
                .sort((a, b) => a.chunkIdx - b.chunkIdx);
            for (const dc of dayChunks) {
                ordered.push({
                    type: "chunk",
                    dayDiff: day,
                    chunkIdx: dc.chunkIdx,
                    label: CHUNK_LABELS[dc.chunkIdx] || "",
                    tasks: dc.tasks,
                });
            }
        }
        return ordered;
    }, [allTasks]);

    return (
        <div className="action">
            <div className="action-main">
                <div className="action-greeting">
                    <div className="action-greeting-head">{getGreeting()},</div>
                    <div className="action-greeting-sub">it's {moment().format("dddd, MMMM D")}.</div>
                </div>

                {loading && groups.length === 0 && (
                    <div className="action-loading">computing schedule...</div>
                )}

                <div className="action-timeline">
                    {groups.map((item, i) =>
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

            {dragState && (
                <div className="action-drop-overlay">
                    {[...Array(14)].map((_, dayIdx) => (
                        <div key={dayIdx} className="action-drop-day">
                            <div className="action-drop-day-label">{dayLabel(dayIdx)}</div>
                            <div className="action-drop-grid">
                                {CHUNK_LABELS.map((label, chunkIdx) => (
                                    <div
                                        key={chunkIdx}
                                        className={`action-drop-cell${dropTarget?.day === dayIdx && dropTarget?.chunkIdx === chunkIdx ? " active" : ""}`}
                                        onMouseEnter={() => handleDropEnter(dayIdx, chunkIdx)}
                                        onMouseLeave={handleDropLeave}
                                    >
                                        {label}
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
