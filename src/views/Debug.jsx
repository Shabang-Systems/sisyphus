import { useState, useEffect, useCallback } from "react";
import { useDispatch } from "react-redux";
import { invoke } from "@tauri-apps/api/core";
import { snapshot } from "@api/utils.js";
import strings from "@strings";
import "./Debug.css";

const CHUNK_HOURS = ["00:00", "04:00", "08:00", "12:00", "16:00", "20:00"];
const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function fmtSlots(s) { return `${s.toFixed(1)} slots (${(s * 0.5).toFixed(1)}h)`; }

function chunkLabel(chunk, horizonStart) {
    // Fallback: compute from raw chunk index (used for raw priorities display)
    const d = Math.floor(chunk / 6);
    const h = chunk % 6;
    const date = new Date(horizonStart);
    date.setDate(date.getDate() + d);
    const dow = DOW_LABELS[(date.getDay() + 6) % 7];
    return `${dow} ${date.getMonth()+1}/${date.getDate()} c${chunk}`;
}

function allocLabel(day, hourStart, horizonStart) {
    // Use pre-computed day offset and hour from Rust
    const date = new Date(horizonStart);
    date.setDate(date.getDate() + day);
    const dow = DOW_LABELS[(date.getDay() + 6) % 7];
    const endHour = hourStart + 4;
    return `${dow} ${date.getMonth()+1}/${date.getDate()} ${String(hourStart).padStart(2,"0")}:00–${String(endHour).padStart(2,"0")}:00`;
}

export default function Debug() {
    const dispatch = useDispatch();
    const [schedule, setSchedule] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [horizonStart] = useState(() => new Date());

    const solve = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const result = await invoke("compute_schedule");
            setSchedule(result);
        } catch (e) {
            setError(String(e));
        }
        setLoading(false);
    }, []);

    useEffect(() => { solve(); }, [solve]);

    const acceptTask = useCallback(async (taskId, chunkIdx) => {
        const dayOffset = Math.floor(chunkIdx / 6);
        const hourStart = (chunkIdx % 6) * 4;
        const d = new Date();
        d.setDate(d.getDate() + dayOffset);
        d.setHours(hourStart, 0, 0, 0);
        try {
            await invoke("accept_task_schedule", { id: taskId, schedule: d.toISOString() });
            dispatch(snapshot());
            solve();
        } catch (e) { setError(String(e)); }
    }, [dispatch, solve]);

    return (
        <div className="debug">
            <div className="drag-region" data-tauri-drag-region />
            <div className="debug-header">
                <span className="debug-title">{strings.VIEWS__DEBUG_TITLE}</span>
                <button className="debug-btn" onClick={solve} disabled={loading}>
                    <i className="fa-solid fa-rotate" /> {strings.VIEWS__DEBUG_RESOLVE}
                </button>
            </div>

            {error && <div className="debug-error">{error}</div>}
            {schedule?.errors?.map((e, i) => <div key={i} className="debug-error">{e}</div>)}

            <div className="debug-content">
                {loading && !schedule && <div className="debug-loading">{strings.VIEWS__DEBUG_LOADING}</div>}

                {schedule && <>
                    {/* ── Allocations (flat list) ── */}
                    <section className="debug-section">
                        <h3>{strings.VIEWS__DEBUG_SCHEDULE}</h3>
                        {schedule.allocations.length === 0 && <p className="debug-hint">No allocations produced.</p>}
                        {schedule.allocations.map(a => (
                            <div key={a.chunk} className="debug-alloc-block">
                                <div className="debug-alloc-header">
                                    {allocLabel(a.day, a.hour_start, horizonStart)}
                                </div>
                                {a.tasks.map(([tid, slots]) => {
                                    const info = schedule.task_info.find(t => t.id === tid);
                                    return (
                                        <div key={tid} className="debug-alloc-row">
                                            <span className="debug-alloc-name" title={tid}>{info?.name || tid.slice(0, 8)}</span>
                                            <span className="debug-alloc-tag">{info?.tag}</span>
                                            <span className="debug-alloc-slots">{fmtSlots(slots)}</span>
                                            <button className="debug-lock-btn" onClick={() => acceptTask(tid, a.chunk)} title="Lock">
                                                <i className="fa-solid fa-lock" />
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        ))}
                    </section>

                    {/* ── Task Diagnostics ── */}
                    <section className="debug-section">
                        <h3>{strings.VIEWS__DEBUG_TASKS}</h3>
                        {schedule.task_info.map(t => (
                            <div key={t.id} className={"debug-task" + (schedule.parked.includes(t.id) ? " parked" : "")}>
                                <div className="debug-task-header">
                                    <span className="debug-task-name" title={t.id}>{t.name}</span>
                                    <span className="debug-alloc-tag">{t.tag}</span>
                                    {schedule.parked.includes(t.id) && <span className="debug-badge parked">PARKED</span>}
                                </div>
                                <div className="debug-task-stats">
                                    <span>w = {t.w} slots ({t.w * 0.5}h)</span>
                                    <span>allocated = {t.total_allocated.toFixed(1)} slots</span>
                                    <span>ν = {t.completion_pressure.toFixed(3)}</span>
                                    <span>tag = {t.tag}</span>
                                </div>
                                {t.priority_scores.length > 0 && (
                                    <div className="debug-task-scores">
                                        Λ: {t.priority_scores.filter(([,s]) => s > 0.01).map(([c, s]) => (
                                            <span key={c} className="debug-score">c{c}={s.toFixed(2)}</span>
                                        ))}
                                        {t.priority_scores.every(([,s]) => s <= 0.01) && <span className="debug-hint">all ≤ 0</span>}
                                    </div>
                                )}
                            </div>
                        ))}
                    </section>

                    {/* ── Duals ── */}
                    <section className="debug-section">
                        <h3>{strings.VIEWS__DEBUG_DUALS}</h3>
                        {schedule.duals.time_prices.length > 0 && (
                            <div className="debug-dual-group">
                                <h4>μ (time prices)</h4>
                                {schedule.duals.time_prices.map(([c, mu]) => (
                                    <span key={c} className="debug-dual-item">{chunkLabel(c, horizonStart)}: {mu.toFixed(3)}</span>
                                ))}
                            </div>
                        )}
                        {schedule.duals.energy_prices.length > 0 && (
                            <div className="debug-dual-group">
                                <h4>η (energy prices)</h4>
                                {schedule.duals.energy_prices.map(([c, tag, eta], i) => (
                                    <span key={i} className="debug-dual-item">{chunkLabel(c, horizonStart)} [{tag}]: {eta.toFixed(3)}</span>
                                ))}
                            </div>
                        )}
                        {schedule.duals.time_prices.length === 0 && schedule.duals.energy_prices.length === 0 && (
                            <p className="debug-hint">No binding constraints.</p>
                        )}
                    </section>

                    {/* ── Parked ── */}
                    {schedule.parked.length > 0 && (
                        <section className="debug-section">
                            <h3>{strings.VIEWS__DEBUG_PARKED}</h3>
                            <p className="debug-hint">{strings.VIEWS__DEBUG_PARKED_HINT}</p>
                            {schedule.parked.map(id => {
                                const info = schedule.task_info.find(t => t.id === id);
                                return <div key={id} className="debug-parked-item">{info?.name || id.slice(0, 8)}</div>;
                            })}
                        </section>
                    )}

                    {/* ── Raw QP Priorities ── */}
                    {schedule.raw_priorities?.length > 0 && (
                        <section className="debug-section">
                            <h3>Stage 1: QP Continuous Priorities (x_ic density)</h3>
                            <div className="debug-raw" style={{maxHeight: 200}}>
                                {schedule.raw_priorities.map(([name, c, v], i) => (
                                    <div key={i} className="debug-dual-item">
                                        {name} @ {chunkLabel(c, horizonStart)}: {v.toFixed(3)}
                                    </div>
                                ))}
                            </div>
                        </section>
                    )}

                    {/* ── Packing Trace ── */}
                    {schedule.packing_trace?.length > 0 && (
                        <section className="debug-section">
                            <h3>Stage 2: Greedy Packing Order</h3>
                            <table className="debug-table">
                                <thead>
                                    <tr><th>#</th><th>Task</th><th>Chunk</th><th>Slots</th></tr>
                                </thead>
                                <tbody>
                                    {schedule.packing_trace.map(([step, name, c, slots], i) => (
                                        <tr key={i}>
                                            <td>{step}</td>
                                            <td>{name}</td>
                                            <td>{chunkLabel(c, horizonStart)}</td>
                                            <td>{fmtSlots(slots)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </section>
                    )}

                    {/* ── Raw JSON ── */}
                    <section className="debug-section">
                        <h3>Raw Output</h3>
                        <pre className="debug-raw">{JSON.stringify(schedule, null, 2)}</pre>
                    </section>
                </>}
            </div>
        </div>
    );
}
