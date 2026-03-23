import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useSelector, useDispatch } from "react-redux";
import { invoke } from "@tauri-apps/api/core";
import { useSpring, animated } from "@react-spring/web";
import { upsert } from "@api/tasks.js";
import { snapshot } from "@api/utils.js";
import moment from "moment";
import strings from "@strings";
import "./Action.css";

const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function getGreeting() {
    const h = new Date().getHours();
    if (h < 12) return strings.TEMPORAL_GREETINGS[0];
    if (h < 19) return strings.TEMPORAL_GREETINGS[1];
    return strings.TEMPORAL_GREETINGS[2];
}

const DOW_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function dayLabel(dayOffset) {
    const d = new Date();
    d.setDate(d.getDate() + dayOffset);
    return `${DOW_FULL[d.getDay()]}, ${d.getMonth() + 1}/${d.getDate()}`;
}

const DUE_COLORS = {
    overdue: [255, 57, 0],    // --red #FF3900
    "due-soon": [242, 114, 0], // --orange #F27200
};
const FG_COLOR = [47, 51, 56]; // --fg #2F3338

function TaskRow({ item, task, onComplete, onAnimationDone }) {
    const [phase, setPhase] = useState(task?.completed_at ? "done" : "idle");
    const baseColor = DUE_COLORS[item.dueStatus] || FG_COLOR;

    const rowSpring = useSpring({
        paddingTop: phase === "expand" ? 12 : phase === "done" ? 0 : 4,
        paddingBottom: phase === "expand" ? 12 : phase === "done" ? 0 : 4,
        maxHeight: phase === "done" ? 0 : 50,
        config: { tension: 500, friction: 28 },
        onRest: () => { if (phase === "expand") setPhase("flash"); },
    });

    const flashSpring = useSpring({
        bgSize: phase === "flash" || phase === "done" ? 100 : 0,
        config: { tension: 500, friction: 30 },
        onChange: ({ value }) => {
            if (phase === "flash" && value.bgSize > 80) setPhase("done");
        },
    });

    const fadeSpring = useSpring({
        opacity: phase === "done" ? 0 : 1,
        config: { tension: 500, friction: 30 },
        onRest: () => {
            if (phase === "done" && onAnimationDone) onAnimationDone(item.id);
        },
    });

    const handleClick = () => {
        if (phase !== "idle") return;
        setPhase("expand");
        onComplete(item.id);
    };

    if (phase === "done") return null;

    return (
        <animated.div
            className={`action-task${item.dueStatus ? ` ${item.dueStatus}` : ""}`}
            style={{
                ...rowSpring,
                opacity: fadeSpring.opacity,
                backgroundImage: "linear-gradient(to right, var(--green), var(--green))",
                backgroundRepeat: "no-repeat",
                backgroundPosition: "left",
                backgroundSize: flashSpring.bgSize.to(v => `${v}% 100%`),
                overflow: "hidden",
            }}
        >
            <div
                className={`action-checkbox${phase !== "idle" ? " checked" : ""}`}
                onClick={handleClick}
            >
                {phase !== "idle" && <i className="fa-solid fa-check" />}
            </div>
            <animated.span
                className="action-task-name"
                style={{
                    color: flashSpring.bgSize.to(v => {
                        const t = Math.min(v / 100, 1);
                        const r = Math.round(baseColor[0] + (255 - baseColor[0]) * t);
                        const g = Math.round(baseColor[1] + (255 - baseColor[1]) * t);
                        const b = Math.round(baseColor[2] + (255 - baseColor[2]) * t);
                        return `rgb(${r},${g},${b})`;
                    }),
                }}
                dangerouslySetInnerHTML={{
                    __html: item.name.replace(/@(\S+)/g, '<span class="action-tag">@$1</span>'),
                }}
            />
            {item.dueLabel && (
                <span className={`action-due-label${item.dueStatus === "overdue" ? " overdue" : item.dueStatus === "due-soon" ? " due-soon" : ""}`}>
                    {item.dueLabel}
                </span>
            )}
        </animated.div>
    );
}

function now() { return new Date().toISOString().replace("T", " ").slice(0, 19); }

export default function Action() {
    const dispatch = useDispatch();
    const allTasks = useSelector(state => state.tasks.db);
    const taskMapMemo = useMemo(() => new Map(allTasks.map(t => [t.id, t])), [allTasks]);
    const taskMap = useRef(taskMapMemo);
    taskMap.current = taskMapMemo;

    const handleComplete = useCallback((taskId) => {
        const task = taskMap.current.get(taskId);
        if (!task) return;
        const ts = now();
        if (task.completed_at) {
            dispatch(upsert({ ...task, completed_at: null, updated_at: ts }));
        } else {
            dispatch(upsert({ ...task, completed_at: ts, updated_at: ts }));
        }
    }, [dispatch]);

    useEffect(() => { dispatch(snapshot()); }, [dispatch]);

    const [schedule, setSchedule] = useState(null);
    const [loading, setLoading] = useState(false);
    const PAGE_SIZE = 30;
    const loadedRef = useRef(0);
    const containerRef = useRef(null);

    const solve = useCallback(async () => {
        setLoading(true);
        try {
            const result = await invoke("compute_schedule");
            setSchedule(result);
        } catch { /* ignore */ }
        setLoading(false);
    }, []);

    useEffect(() => { solve(); }, [solve]);

    // Track tasks currently animating — don't filter them out during animation
    const animatingIds = useRef(new Set());
    const [completedIds, setCompletedIds] = useState(new Set());
    const wrappedComplete = useCallback((taskId) => {
        animatingIds.current.add(taskId);
        handleComplete(taskId);
    }, [handleComplete]);
    const onAnimationDone = useCallback((taskId) => {
        animatingIds.current.delete(taskId);
        setCompletedIds(prev => new Set([...prev, taskId]));
    }, []);

    // Build flat timeline from schedule allocations, grouped by (day, chunk)
    const timelineItems = [];
    if (schedule && allTasks.length > 0) {
        const nowMs = Date.now();
        const chunkLabels = strings.CHUNK_LABELS;
        // Group by day → chunk → tasks
        const byDayChunk = new Map(); // key: "day:chunk"
        const daySet = new Set();

        for (const alloc of schedule.allocations) {
            const chunkIdx = alloc.hour_start / 4; // 0-5
            const key = `${alloc.day}:${chunkIdx}`;
            if (!byDayChunk.has(key)) byDayChunk.set(key, { day: alloc.day, chunkIdx, tasks: [] });
            for (const [tid, slots] of alloc.tasks) {
                const task = taskMap.current.get(tid);
                if (task?.is_deferred) continue;
                if (completedIds.has(tid)) continue;
                if (task?.completed_at && !animatingIds.current.has(tid)) continue;
                const info = schedule.task_info.find(t => t.id === tid);
                let dueStatus = null;
                const effectiveDue = task?.effective_due ? new Date(task.effective_due) : null;
                if (effectiveDue) {
                    const hoursLeft = (effectiveDue - nowMs) / 3600000;
                    if (hoursLeft < 0) dueStatus = "overdue";
                    else if (hoursLeft < 24) dueStatus = "due-soon";
                }
                // Compute due label like planning mode
                let dueLabel = null;
                if (effectiveDue && !task?.completed_at) {
                    const due = moment(effectiveDue);
                    const daysAway = due.diff(moment(), "days", true);
                    if (daysAway < 0) dueLabel = "overdue";
                    else if (daysAway < 1) dueLabel = due.fromNow();
                    else if (daysAway < 7) dueLabel = due.format("dddd, h:mm a");
                    else dueLabel = due.format("dddd, MMMM D, h:mm a");
                }

                byDayChunk.get(key).tasks.push({
                    id: tid,
                    name: info?.name || tid.slice(0, 8),
                    slots,
                    hourStart: alloc.hour_start,
                    dueStatus,
                    dueLabel,
                    chunkLabel: chunkLabels[chunkIdx] || "",
                });
            }
            daySet.add(alloc.day);
        }

        const days = [...daySet].sort((a, b) => a - b);
        for (const day of days) {
            // Collect all chunks for this day that have tasks
            const dayChunks = [...byDayChunk.values()]
                .filter(dc => dc.day === day && dc.tasks.length > 0)
                .sort((a, b) => a.chunkIdx - b.chunkIdx);
            if (dayChunks.length === 0) continue;

            timelineItems.push({ type: "day", label: dayLabel(day), day });
            for (const dc of dayChunks) {
                const label = chunkLabels[dc.chunkIdx] || "";
                if (label) {
                    timelineItems.push({ type: "section", label, day, chunkIdx: dc.chunkIdx });
                }
                for (const t of dc.tasks) {
                    timelineItems.push({ type: "task", ...t });
                }
            }
        }
    }
    const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

    useEffect(() => { setVisibleCount(PAGE_SIZE); }, [schedule]);

    const onScroll = useCallback((e) => {
        const el = e.target;
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 100) {
            setVisibleCount(prev => Math.min(prev + PAGE_SIZE, timelineItems.length));
        }
    }, [timelineItems.length]);

    const rendered = timelineItems.slice(0, visibleCount);

    return (
        <div className="action">
            <div className="drag-region" data-tauri-drag-region />
            <div className="action-main" ref={containerRef} onScroll={onScroll}>
                <div className="action-greeting">
                    <div className="action-greeting-head">{getGreeting()},</div>
                    <div className="action-greeting-sub">it's {moment().format("dddd, MMMM D")}.</div>
                </div>

                {loading && !schedule && (
                    <div className="action-loading">computing schedule...</div>
                )}

                <div className="action-timeline">
                    {rendered.map((item, i) =>
                        item.type === "day" ? (
                            <div key={`day-${item.day}`} className="action-day-header">
                                <span className="action-day-label">{item.label}</span>
                            </div>
                        ) : item.type === "section" ? (
                            <div key={`section-${item.day}-${item.chunkIdx}`} className="action-section-row">
                                <span className="action-section-label">{item.label}</span>
                            </div>
                        ) : (
                            <TaskRow
                                key={`${item.id}-${i}`}
                                item={item}
                                task={taskMap.current.get(item.id)}
                                onComplete={wrappedComplete}
                                onAnimationDone={onAnimationDone}
                            />
                        )
                    )}
                    <div className="action-spacer" />
                </div>
            </div>
        </div>
    );
}
