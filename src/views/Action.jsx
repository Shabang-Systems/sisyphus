import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useSelector, useDispatch } from "react-redux";
import { invoke } from "@tauri-apps/api/core";
import { updateTask } from "@api/tasks.js";
import { snapshot, localISO } from "@api/utils.js";
import { txSet, flushNow } from "@api/sync.js";
import { getCachedChunkConfig, fetchChunkConfig } from "@api/chunkConfig.js";
import moment from "moment";
import strings from "@strings";
import Editor from "@views/Editor.jsx";
import "./Action.css";

const DOW_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function getGreeting() {
    const h = new Date().getHours();
    if (h < 12) return strings.TEMPORAL_GREETINGS[0];
    if (h < 19) return strings.TEMPORAL_GREETINGS[1];
    return strings.TEMPORAL_GREETINGS[2];
}

function dayLabel(dayOffset) {
    if (dayOffset === 0) return "Today";
    if (dayOffset === 1) return "Tomorrow";
    const d = new Date();
    d.setDate(d.getDate() + dayOffset);
    return `${DOW_FULL[d.getDay()]}, ${d.getMonth() + 1}/${d.getDate()}`;
}

function now() { return localISO(); }

export default function Action({ onJumpToTask, triggerRebalance, onViewChange }) {
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

    // Load chunk config — cached synchronously after first fetch
    const [chunkCfg, setChunkCfg] = useState(getCachedChunkConfig);
    useEffect(() => { fetchChunkConfig().then(setChunkCfg); }, []);
    const hoursPerChunk = 24 / chunkCfg.chunks_per_day;
    const slotsPerChunk = hoursPerChunk * 2;
    const chunkLabels = chunkCfg.labels;

    // Fetch calendar freebusy once on mount (returned from Rust cache, fast)
    const [calBusy, setCalBusy] = useState(null);
    useEffect(() => {
        invoke("get_calendar_freebusy").then(setCalBusy).catch(() => setCalBusy(null));
    }, []);

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
                d.setHours(dt.chunkIdx * hoursPerChunk, 0, 0, 0);
                const task = taskMap.current.get(tid);
                if (task) {
                    const sched = localISO(d);
                    dispatch(updateTask({ id: tid, changes: { schedule: sched, locked: true, updated_at: now() } }));
                    txSet(tid, "schedule", sched);
                    txSet(tid, "locked", true);
                    flushNow();
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
        const overdue = [];

        for (const task of allTasks) {
            if (!task.schedule) continue;
            if (task.is_deferred) continue;
            if (task.completed_at) continue;

            const schedDate = new Date(task.schedule);
            const dayDiff = Math.floor((schedDate - todayStart) / 86400000);
            if (dayDiff < 0) { overdue.push(task); continue; }
            const chunkIdx = Math.floor(schedDate.getHours() / hoursPerChunk);
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

        // Overdue tasks: scheduled before today
        if (overdue.length > 0) {
            overdue.sort((a, b) => a.position - b.position);
            ordered.push({ type: "day", dayDiff: -1, label: strings.VIEWS__ACTION_OVERDUE });
            ordered.push({ type: "chunk", dayDiff: -1, chunkIdx: 0, label: "", tasks: overdue });
        }

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
                    label: chunkLabels[dc.chunkIdx] || "",
                    tasks: newArrayMap.get(key) || dc.tasks,
                });
            }
        }
        return ordered;
    }, [allTasks, hoursPerChunk, chunkLabels]);

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

    const onScroll = useCallback(() => {}, []);

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
                            <span className="action-parked-label" data-tooltip-id="rootp" data-tooltip-content="Waiting for the scheduler, or no valid time slot found.">pending scheduling</span>
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

                {groups.length === 0 && parkedTasks.length === 0 && (
                    <div className="action-empty">
                        {strings.VIEWS__ACTION_EMPTY[Math.floor(Math.random() * strings.VIEWS__ACTION_EMPTY.length)]}{" "}
                        <span className="action-empty-cta" onClick={() => onViewChange?.("editor")}>
                            {strings.VIEWS__ACTION_EMPTY_CTA}
                        </span>.
                    </div>
                )}

                <div className="action-timeline">
                    {groups.map((item, i) =>
                        item.type === "day" ? (
                            <div key={`day-${item.dayDiff}`} className={`action-day-header${item.dayDiff === 0 ? " today" : ""}${item.dayDiff < 0 ? " overdue" : ""}`}>
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
                                            d.setHours(item.chunkIdx * hoursPerChunk, 0, 0, 0);
                                            return localISO(d);
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
                // Effort → slots mapping (mirrors Rust effort_to_slots)
                const effortSlots = [2, 1, 2, 4, 8, 16]; // index = effort value, 0 defaults to S=2

                // Compute task load (in slots) per cell and find current task's schedule
                const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
                const loadMap = new Map();
                let currentDay = -1, currentChunk = -1;

                for (const t of allTasks) {
                    if (!t.schedule || t.completed_at) continue;
                    const sd = new Date(t.schedule);
                    const dd = Math.floor((sd - todayStart) / 86400000);
                    if (dd < 0 || dd >= chunkCfg.horizon_days) continue;
                    const ci = Math.floor(sd.getHours() / hoursPerChunk);
                    const key = `${dd}:${ci}`;
                    const slots = effortSlots[t.effort || 0];
                    loadMap.set(key, (loadMap.get(key) || 0) + slots);
                    if (t.id === dragState.taskId) { currentDay = dd; currentChunk = ci; }
                }

                // Compute weeks: 7-day blocks starting from Monday
                const today = new Date();
                const todayDow = today.getDay(); // 0=Sun
                // Days until next Monday (or 0 if today is Monday)
                const daysToMon = todayDow === 0 ? 1 : todayDow === 1 ? 0 : 8 - todayDow;
                // First week: today .. Sunday. Subsequent weeks: Mon .. Sun.
                const totalDays = chunkCfg.horizon_days;
                const firstWeekLen = Math.min(daysToMon > 0 ? daysToMon : 7, totalDays);
                const weeks = [];
                // First partial/full week
                const w0 = [];
                // Pad leading empty cells so the first week aligns to weekday columns
                const startCol = todayDow === 0 ? 6 : todayDow - 1; // 0=Mon
                for (let p = 0; p < startCol; p++) w0.push(null);
                for (let d = 0; d < firstWeekLen; d++) w0.push(d);
                while (w0.length < 7) w0.push(null); // pad trailing
                weeks.push(w0);
                // Remaining full weeks
                let dayOff = firstWeekLen;
                while (dayOff < totalDays) {
                    const wk = [];
                    for (let d = 0; d < 7; d++) {
                        wk.push(dayOff < totalDays ? dayOff : null);
                        dayOff++;
                    }
                    weeks.push(wk);
                }

                const shortDay = (dayIdx) => {
                    const d = new Date();
                    d.setDate(d.getDate() + dayIdx);
                    return `${d.getMonth()+1}/${d.getDate()}`;
                };
                const DOW_HEAD = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];

                const cellFor = (dayIdx, chunkIdx) => {
                    if (dayIdx === null) return (
                        <div key={`empty-${chunkIdx}-${Math.random()}`} className="action-drop-cell empty" />
                    );
                    const isCurrent = dayIdx === currentDay && chunkIdx === currentChunk;
                    const isActive = dropTarget?.day === dayIdx && dropTarget?.chunkIdx === chunkIdx;

                    const calIdx = dayIdx * chunkCfg.chunks_per_day + chunkIdx;
                    const busy = calBusy ? (calBusy[calIdx] || 0) : 0;
                    const available = slotsPerChunk - busy;
                    const taskLoad = loadMap.get(`${dayIdx}:${chunkIdx}`) || 0;

                    const fill = available <= 0
                        ? 1
                        : Math.min((busy + taskLoad) / slotsPerChunk, 1);

                    const r = Math.round(160 + fill * (240 - 160));
                    const g = Math.round(160 + fill * (200 - 160));
                    const b = Math.round(160 + fill * (50 - 160));

                    let bg;
                    if (isActive) {
                        bg = undefined;
                    } else if (isCurrent) {
                        bg = "rgba(55, 165, 190, 0.15)";
                    } else if (fill > 0) {
                        bg = `rgba(${r}, ${g}, ${b}, ${0.08 + fill * 0.22})`;
                    } else {
                        bg = undefined;
                    }

                    return (
                        <div
                            key={dayIdx}
                            className={`action-drop-cell${isActive ? " active" : ""}${isCurrent ? " current" : ""}`}
                            style={bg ? { background: bg } : undefined}
                            onMouseEnter={() => handleDropEnter(dayIdx, chunkIdx)}
                            onMouseLeave={handleDropClear}
                        />
                    );
                };

                return (
                    <div className="action-drop-overlay" onMouseMove={(e) => {
                        if (!e.target.classList.contains("action-drop-cell")) {
                            dropTargetRef.current = null;
                            setDropTarget(null);
                        }
                    }}>
                        <div className="action-drop-weeks">
                            {weeks.map((week, wi) => (
                                <div key={wi} className="action-drop-grid">
                                    {/* Corner */}
                                    <div />
                                    {/* Day column headers */}
                                    {week.map((dayIdx, di) => (
                                        <div key={di} className={`action-drop-col-label${dayIdx === 0 ? " today" : ""}`}>
                                            {wi === 0 ? DOW_HEAD[di] : ""}{dayIdx !== null ? <><br/>{shortDay(dayIdx)}</> : ""}
                                        </div>
                                    ))}
                                    {/* Time rows */}
                                    {chunkLabels.map((label, chunkIdx) => (<>
                                        <div key={`l-${chunkIdx}`} className="action-drop-row-label">{label}</div>
                                        {week.map((dayIdx, di) => cellFor(dayIdx, chunkIdx))}
                                    </>))}
                                </div>
                            ))}
                        </div>
                    </div>
                );
            })()}
        </div>
    );
}
