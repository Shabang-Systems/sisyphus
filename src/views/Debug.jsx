import { useState, useEffect, useCallback } from "react";
import { useDispatch } from "react-redux";
import { invoke } from "@tauri-apps/api/core";
import { snapshot } from "@api/utils.js";
import strings from "@strings";
import "./Debug.css";

const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function fmtSlots(s) { return `${s.toFixed(1)} slots (${(s * 0.5).toFixed(1)}h)`; }

function chunkLabel(chunk, horizonStart, chunksPerDay) {
    const d = Math.floor(chunk / chunksPerDay);
    const h = chunk % chunksPerDay;
    const date = new Date(horizonStart);
    date.setDate(date.getDate() + d);
    const dow = DOW_LABELS[(date.getDay() + 6) % 7];
    return `${dow} ${date.getMonth()+1}/${date.getDate()} c${chunk}`;
}

function allocLabel(day, hourStart, horizonStart, hoursPerChunk) {
    const date = new Date(horizonStart);
    date.setDate(date.getDate() + day);
    const dow = DOW_LABELS[(date.getDay() + 6) % 7];
    const endHour = hourStart + hoursPerChunk;
    return `${dow} ${date.getMonth()+1}/${date.getDate()} ${String(hourStart).padStart(2,"0")}:00–${String(endHour).padStart(2,"0")}:00`;
}

export default function Debug() {
    const dispatch = useDispatch();
    const [schedule, setSchedule] = useState(null);
    const [chunkCfg, setChunkCfg] = useState({ chunks_per_day: 6, horizon_days: 14, labels: strings.CHUNK_LABELS });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [horizonStart] = useState(() => new Date());

    useEffect(() => {
        invoke("get_chunk_config").then(setChunkCfg).catch(() => {});
    }, []);

    const chunksPerDay = chunkCfg.chunks_per_day;
    const hoursPerChunk = 24 / chunksPerDay;
    const chunkHours = Array.from({ length: chunksPerDay }, (_, i) => {
        const h = i * hoursPerChunk;
        return `${String(h).padStart(2, "0")}:00`;
    });

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
        const dayOffset = Math.floor(chunkIdx / chunksPerDay);
        const hourStart = (chunkIdx % chunksPerDay) * hoursPerChunk;
        const d = new Date();
        d.setDate(d.getDate() + dayOffset);
        d.setHours(hourStart, 0, 0, 0);
        try {
            await invoke("accept_task_schedule", { id: taskId, schedule: d.toISOString() });
            dispatch(snapshot());
            solve();
        } catch (e) { setError(String(e)); }
    }, [dispatch, solve, chunksPerDay, hoursPerChunk]);

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
                    {/* ── Formula Explanation ── */}
                    <section className="debug-section">
                        <h3>Scheduling Model</h3>
                        <div className="debug-explain">
                            <div className="debug-explain-row">
                                <div className="debug-explain-formula">Λ<sub>ic</sub> = r<sub>i</sub>(c) + ν<sub>i</sub> − μ<sub>c</sub> − η<sub>kc</sub></div>
                                <div className="debug-explain-desc">Priority score for task <em>i</em> at chunk <em>c</em>. Higher = more valuable to schedule here.</div>
                            </div>
                            <div className="debug-explain-row">
                                <div className="debug-explain-formula">r<sub>i</sub>(c) = α<sub>k</sub> × T / max(t<sub>f</sub> − c, 1)</div>
                                <div className="debug-explain-desc">
                                    Delay reward (1/slack). Blows up near deadline: due in 2 chunks → r = 42, due in 80 → r ≈ 1. Capped at <strong>T</strong> = {schedule.horizon_days * schedule.chunks_per_day}.
                                    <strong>α<sub>k</sub></strong> = tag urgency weight.
                                </div>
                            </div>
                            <div className="debug-explain-row">
                                <div className="debug-explain-formula">ν<sub>i</sub></div>
                                <div className="debug-explain-desc">Completion pressure (KKT dual). Positive when task barely fits its window. Huge (&gt;10<sup>10</sup>) = solver didn't converge → task is parked.</div>
                            </div>
                            <div className="debug-explain-row">
                                <div className="debug-explain-formula">μ<sub>c</sub></div>
                                <div className="debug-explain-desc">Time price at chunk <em>c</em>. High when chunk is contested (many tasks want it).</div>
                            </div>
                            <div className="debug-explain-row">
                                <div className="debug-explain-formula">η<sub>kc</sub></div>
                                <div className="debug-explain-desc">Energy price for tag class <em>k</em> at chunk <em>c</em>. High when tag's Dirichlet budget is exhausted.</div>
                            </div>
                            <div className="debug-explain-row">
                                <div className="debug-explain-formula">Greedy packing</div>
                                <div className="debug-explain-desc">Sort all (task, chunk) pairs by Λ descending. <strong>Pass 1</strong>: assign respecting both physical capacity and tag energy budgets. <strong>Pass 2</strong>: re-iterate same Λ order, energy-ignored, for spillover. Tasks with zero allocation are parked.</div>
                            </div>
                        </div>
                        <div className="debug-explain-stats">
                            <span>Horizon: <strong>{schedule.horizon_days}d × {schedule.chunks_per_day} chunks = {schedule.horizon_days * schedule.chunks_per_day} total</strong></span>
                            <span>Tasks: <strong>{schedule.task_info.length}</strong> ({schedule.task_info.filter(t => t.total_allocated > 0).length} scheduled, {schedule.parked.length} parked)</span>
                            <span>Allocations: <strong>{schedule.allocations.length}</strong> chunks used</span>
                        </div>
                    </section>

                    {/* ── Dirichlet Energy Model ── */}
                    {schedule.tag_set?.length > 0 && (() => {
                        const startH = schedule.start_h || 0;
                        const remainToday = chunksPerDay - startH;
                        const toChunk = (dayIdx, hIdx) => {
                            if (dayIdx === 0) return hIdx - startH;
                            return remainToday + (dayIdx - 1) * chunksPerDay + hIdx;
                        };
                        const dayLabel = (dayIdx) => {
                            const d = new Date(horizonStart);
                            d.setDate(d.getDate() + dayIdx);
                            return `${DOW_LABELS[(d.getDay() + 6) % 7]} ${d.getMonth()+1}/${d.getDate()}`;
                        };
                        const renderGrid = (data, fmt, colorFn) => (
                            <div className="debug-energy-grid">
                                <div className="debug-energy-grid-header">
                                    <div className="debug-energy-grid-corner" />
                                    {chunkHours.map((h, i) => <div key={i} className="debug-energy-grid-col">{h}</div>)}
                                </div>
                                {[...Array(schedule.horizon_days)].map((_, dayIdx) => (
                                    <div key={dayIdx} className="debug-energy-grid-row">
                                        <div className="debug-energy-grid-row-label">{dayLabel(dayIdx)}</div>
                                        {chunkHours.map((_, hIdx) => {
                                            const ci = toChunk(dayIdx, hIdx);
                                            if (ci < 0) return <div key={hIdx} className="debug-energy-grid-cell past" />;
                                            const val = ci < data.length ? data[ci] : 0;
                                            const bg = colorFn ? colorFn(val, ci) : undefined;
                                            return (
                                                <div key={hIdx} className="debug-energy-grid-cell" style={bg ? { background: bg } : undefined}>
                                                    {val > 0.001 ? fmt(val) : ""}
                                                </div>
                                            );
                                        })}
                                    </div>
                                ))}
                            </div>
                        );

                        return (
                            <section className="debug-section">
                                <h3>Dirichlet Energy Model</h3>

                                <div className="debug-energy-tag">
                                    <div className="debug-energy-tag-label">C(c) — physical capacity (slots)</div>
                                    {renderGrid(
                                        schedule.chunk_caps || [],
                                        v => v.toFixed(1),
                                        v => v > 0.01 ? `rgba(100, 100, 100, ${0.05 + Math.min(v / 8, 1) * 0.15})` : undefined
                                    )}
                                </div>

                                {schedule.tag_set.map((tag, k) => {
                                    const xi = schedule.dirichlet_xi?.[k] || [];
                                    const mean = schedule.dirichlet_mean?.[k] || [];
                                    const caps = schedule.energy_caps[k] || [];
                                    return (
                                        <div key={tag} className="debug-energy-tag">
                                            <div className="debug-energy-tag-label">@{tag}</div>

                                            <div className="debug-energy-sub-label">ξ (concentration parameter)</div>
                                            {renderGrid(xi, v => v.toFixed(2), (v) =>
                                                v > 0.01 ? `rgba(242, 114, 0, ${0.06 + Math.min(v / 10, 1) * 0.25})` : undefined
                                            )}

                                            <div className="debug-energy-sub-label">E[θ] = ξ / Σξ (posterior mean)</div>
                                            {renderGrid(mean, v => (v * 100).toFixed(0) + "%", (v) =>
                                                v > 0.001 ? `rgba(38, 166, 113, ${0.06 + v * 0.4})` : undefined
                                            )}

                                            <div className="debug-energy-sub-label">C<sub>k</sub>(c) = E[θ] × C(c) (energy cap, slots)</div>
                                            {renderGrid(caps, v => v.toFixed(1), (v, ci) => {
                                                const phys = ci < (schedule.chunk_caps?.length || 0) ? schedule.chunk_caps[ci] : 0;
                                                const frac = phys > 0 ? v / phys : 0;
                                                return v > 0.01 ? `rgba(55, 165, 190, ${0.08 + frac * 0.35})` : undefined;
                                            })}
                                        </div>
                                    );
                                })}
                            </section>
                        );
                    })()}

                    {/* ── Per-Task Formula Values ── */}
                    <section className="debug-section">
                        <h3>Per-Task Formula Values</h3>
                        {[...schedule.task_info]
                            .sort((a, b) => b.total_allocated - a.total_allocated || a.name.localeCompare(b.name))
                            .map(t => {
                                const isParked = schedule.parked.includes(t.id);
                                const garbageDual = t.completion_pressure > 1e10;
                                const maxLambda = t.priority_scores.length > 0
                                    ? Math.max(...t.priority_scores.map(s => s[1]))
                                    : 0;
                                const bestChunk = t.priority_scores.length > 0
                                    ? t.priority_scores.reduce((best, s) => s[1] > best[1] ? s : best)
                                    : null;

                                return (
                                    <div key={t.id} className={`debug-formula-card${isParked ? " parked" : ""}${garbageDual ? " garbage" : ""}`}>
                                        <div className="debug-formula-header">
                                            <span className="debug-formula-name">{t.name}</span>
                                            <span className="debug-formula-tag">{t.tag}</span>
                                            {isParked && <span className="debug-badge parked">PARKED</span>}
                                            {garbageDual && <span className="debug-badge garbage">UNCONVERGED</span>}
                                        </div>
                                        <div className="debug-formula-grid">
                                            <div className="debug-formula-item">
                                                <span className="debug-formula-label">w</span>
                                                <span className="debug-formula-value">{t.w} slots ({(t.w * 0.5).toFixed(1)}h)</span>
                                            </div>
                                            <div className="debug-formula-item">
                                                <span className="debug-formula-label">window</span>
                                                <span className="debug-formula-value">[{t.t_s}, {t.t_f}] ({t.t_f - t.t_s + 1} chunks)</span>
                                            </div>
                                            <div className="debug-formula-item">
                                                <span className="debug-formula-label">α<sub>k</sub></span>
                                                <span className="debug-formula-value">{(t.alpha || 1).toFixed(2)}</span>
                                            </div>
                                            <div className="debug-formula-item">
                                                <span className="debug-formula-label">pressure</span>
                                                <span className="debug-formula-value">{(t.pressure || 0).toFixed(4)}</span>
                                            </div>
                                            <div className="debug-formula-item">
                                                <span className="debug-formula-label">ν<sub>i</sub></span>
                                                <span className={`debug-formula-value${garbageDual ? " red" : ""}`}>{t.completion_pressure.toFixed(3)}</span>
                                            </div>
                                            <div className="debug-formula-item">
                                                <span className="debug-formula-label">allocated</span>
                                                <span className="debug-formula-value">{t.total_allocated.toFixed(1)} / {t.w} slots</span>
                                            </div>
                                            <div className="debug-formula-item">
                                                <span className="debug-formula-label">max Λ</span>
                                                <span className="debug-formula-value">{maxLambda.toFixed(3)}{bestChunk ? ` @ c${bestChunk[0]}` : ""}</span>
                                            </div>
                                        </div>
                                        {bestChunk && (
                                            <div className="debug-formula-best">
                                                Best chunk: Λ = {bestChunk[2].toFixed(1)} (r) + {bestChunk[3].toFixed(1)} (ν) − {bestChunk[4].toFixed(1)} (μ) − {bestChunk[5].toFixed(1)} (η) = <strong>{bestChunk[1].toFixed(3)}</strong>
                                            </div>
                                        )}
                                    </div>
                                );
                            })
                        }
                    </section>

                    {/* ── Allocations (flat list) ── */}
                    <section className="debug-section">
                        <h3>{strings.VIEWS__DEBUG_SCHEDULE}</h3>
                        {schedule.allocations.length === 0 && <p className="debug-hint">No allocations produced.</p>}
                        {schedule.allocations.map(a => (
                            <div key={a.chunk} className="debug-alloc-block">
                                <div className="debug-alloc-header">
                                    {allocLabel(a.day, a.hour_start, horizonStart, hoursPerChunk)}
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
                                    <span key={c} className="debug-dual-item">{chunkLabel(c, horizonStart, chunksPerDay)}: {mu.toFixed(3)}</span>
                                ))}
                            </div>
                        )}
                        {schedule.duals.energy_prices.length > 0 && (
                            <div className="debug-dual-group">
                                <h4>η (energy prices)</h4>
                                {schedule.duals.energy_prices.map(([c, tag, eta], i) => (
                                    <span key={i} className="debug-dual-item">{chunkLabel(c, horizonStart, chunksPerDay)} [{tag}]: {eta.toFixed(3)}</span>
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
                                        {name} @ {chunkLabel(c, horizonStart, chunksPerDay)}: {v.toFixed(3)}
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
                                            <td>{chunkLabel(c, horizonStart, chunksPerDay)}</td>
                                            <td>{fmtSlots(slots)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </section>
                    )}

                    {/* ── Full Dump ── */}
                    <section className="debug-section">
                        <h3>Full Dump</h3>
                        <pre className="debug-dump">{(() => {
                            const s = schedule;
                            const lines = [];
                            const pad = (str, w) => str.slice(0, w).padEnd(w);
                            const rpad = (str, w) => str.slice(0, w).padStart(w);

                            // Errors
                            if (s.errors.length > 0) {
                                lines.push("══════════════════════════════════════════════════════════════");
                                lines.push("  ERRORS / WARNINGS");
                                lines.push("══════════════════════════════════════════════════════════════");
                                s.errors.forEach(e => lines.push(`  ⚠ ${e}`));
                                lines.push("");
                            }

                            // Schedule grid
                            lines.push("══════════════════════════════════════════════════════════════");
                            lines.push("  SCHEDULE GRID");
                            lines.push("══════════════════════════════════════════════════════════════");
                            if (s.allocations.length === 0) {
                                lines.push("  (no allocations)");
                            } else {
                                for (const a of s.allocations) {
                                    lines.push("");
                                    lines.push(`  ┌─ ${allocLabel(a.day, a.hour_start, horizonStart, hoursPerChunk)} ─────────────`);
                                    for (const [tid, slots] of a.tasks) {
                                        const info = s.task_info.find(t => t.id === tid);
                                        const name = pad(info?.name || tid.slice(0, 8), 40);
                                        const tag = pad(info?.tag || "", 15);
                                        lines.push(`  │  ${name} ${tag} ${fmtSlots(slots)}`);
                                    }
                                    lines.push("  └────────────────────────────────────────────────────────");
                                }
                            }
                            lines.push("");

                            // Dirichlet energy model
                            if (s.tag_set?.length > 0) {
                                lines.push("══════════════════════════════════════════════════════════════════════════════════");
                                lines.push("  DIRICHLET ENERGY MODEL");
                                lines.push("══════════════════════════════════════════════════════════════════════════════════");
                                const startH = s.start_h || 0;
                                const remToday = chunksPerDay - startH;
                                const colHead = chunkHours.map(h => rpad(h, 8)).join("");
                                const toCI = (d, hIdx) => {
                                    if (d === 0) return hIdx - startH;
                                    return remToday + (d - 1) * chunksPerDay + hIdx;
                                };
                                const dayLbl = (d) => {
                                    const dd = new Date(horizonStart);
                                    dd.setDate(dd.getDate() + d);
                                    const dow = DOW_LABELS[(dd.getDay() + 6) % 7];
                                    return `${dow} ${dd.getMonth()+1}/${dd.getDate()}`;
                                };
                                const dumpGrid = (arr, fmt) => {
                                    lines.push(`  ${pad("", 14)} ${colHead}`);
                                    lines.push(`  ${pad("", 14)} ${"─".repeat(48)}`);
                                    for (let d = 0; d < s.horizon_days; d++) {
                                        const vals = chunkHours.map((_, hIdx) => {
                                            const ci = toCI(d, hIdx);
                                            if (ci < 0) return "   —   ";
                                            const v = ci >= 0 && ci < arr.length ? arr[ci] : 0;
                                            return rpad(v > 0.001 ? fmt(v) : "—", 8);
                                        }).join("");
                                        lines.push(`  ${pad(dayLbl(d), 14)} ${vals}`);
                                    }
                                };

                                // Physical capacity
                                lines.push("");
                                lines.push("  C(c) — physical capacity (slots):");
                                dumpGrid(s.chunk_caps || [], v => v.toFixed(1));

                                for (let k = 0; k < s.tag_set.length; k++) {
                                    const tag = s.tag_set[k];
                                    lines.push("");
                                    lines.push(`  ┌─ @${tag} ──────────────────────────────────────`);

                                    lines.push("  │  ξ (concentration parameter):");
                                    dumpGrid(s.dirichlet_xi?.[k] || [], v => v.toFixed(2));

                                    lines.push("  │");
                                    lines.push("  │  E[θ] = ξ/Σξ (posterior mean):");
                                    dumpGrid(s.dirichlet_mean?.[k] || [], v => (v * 100).toFixed(0) + "%");

                                    lines.push("  │");
                                    lines.push("  │  C_k(c) = E[θ] × C(c) (energy cap, slots):");
                                    dumpGrid(s.energy_caps[k] || [], v => v.toFixed(2));

                                    lines.push(`  └────────────────────────────────────────────────────────────`);
                                }
                                lines.push("");
                            }

                            // Task diagnostics — full formula breakdown
                            lines.push("══════════════════════════════════════════════════════════════════════════════════");
                            lines.push("  TASK DIAGNOSTICS");
                            lines.push("  Formula: Λ_{ic} = r_i(c) + ν_i − μ_c − η_{kc}");
                            lines.push("  where   r_i(c) = α_k × T / max(t_f − c, 1)");
                            lines.push("══════════════════════════════════════════════════════════════════════════════════");

                            // Sort: allocated desc, then by name
                            const sortedTasks = [...s.task_info].sort((a, b) =>
                                b.total_allocated - a.total_allocated || a.name.localeCompare(b.name));

                            for (const t of sortedTasks) {
                                const isParked = s.parked.includes(t.id);
                                const garbageDual = t.completion_pressure > 1e10;
                                const flags = [
                                    isParked ? "PARKED" : null,
                                    garbageDual ? "GARBAGE DUAL" : null,
                                    t.total_allocated > 0 ? `${t.total_allocated.toFixed(1)} slots allocated` : "0 allocated",
                                ].filter(Boolean).join(" | ");

                                lines.push("");
                                lines.push(`  ┌─ ${t.name} ──────────────────────────────────────────`);
                                lines.push(`  │  tag: ${t.tag}    [${flags}]`);
                                lines.push(`  │`);
                                lines.push(`  │  w = ${t.w} slots (${(t.w * 0.5).toFixed(1)}h)    window = [${t.t_s}, ${t.t_f}]    α = ${(t.alpha || 1).toFixed(2)}`);
                                lines.push(`  │  pressure = w/window = ${(t.pressure || 0).toFixed(4)}`);
                                lines.push(`  │  ν_i (completion pressure) = ${t.completion_pressure.toFixed(3)}${garbageDual ? "  ← UNCONVERGED" : ""}`);
                                lines.push(`  │`);

                                if (t.priority_scores.length > 0) {
                                    lines.push(`  │  Λ breakdown per chunk:`);
                                    lines.push(`  │  ${pad("chunk", 22)} ${rpad("r_i(c)", 10)} ${rpad("ν_i", 12)} ${rpad("μ_c", 10)} ${rpad("η_kc", 10)} ${rpad("Λ", 10)}`);
                                    lines.push(`  │  ${"─".repeat(76)}`);
                                    for (const score of t.priority_scores) {
                                        const [c, lambda, r, nu, mu, eta] = score;
                                        lines.push(`  │  ${pad(chunkLabel(c, horizonStart, chunksPerDay), 22)} ${rpad(r.toFixed(3), 10)} ${rpad(nu.toFixed(3), 12)} ${rpad(mu.toFixed(3), 10)} ${rpad(eta.toFixed(3), 10)} ${rpad(lambda.toFixed(3), 10)}`);
                                    }
                                } else {
                                    lines.push(`  │  No positive Λ in any chunk.`);
                                }
                                lines.push(`  └────────────────────────────────────────────────────────────`);
                            }
                            lines.push("");

                            // Dual variables
                            lines.push("══════════════════════════════════════════════════════════════");
                            lines.push("  DUAL VARIABLES");
                            lines.push("══════════════════════════════════════════════════════════════");
                            if (s.duals.time_prices.length > 0) {
                                lines.push("  μ (time prices):");
                                for (const [c, mu] of s.duals.time_prices) {
                                    lines.push(`    ${pad(chunkLabel(c, horizonStart, chunksPerDay), 25)} μ = ${mu.toFixed(3)}`);
                                }
                            }
                            if (s.duals.energy_prices.length > 0) {
                                lines.push("  η (energy prices):");
                                for (const [c, tag, eta] of s.duals.energy_prices) {
                                    lines.push(`    ${pad(chunkLabel(c, horizonStart, chunksPerDay), 25)} [${pad(tag, 12)}] η = ${eta.toFixed(3)}`);
                                }
                            }
                            if (s.duals.time_prices.length === 0 && s.duals.energy_prices.length === 0) {
                                lines.push("  No binding constraints.");
                            }
                            lines.push("");

                            // Parked
                            if (s.parked.length > 0) {
                                lines.push("══════════════════════════════════════════════════════════════");
                                lines.push("  PARKED TASKS");
                                lines.push("══════════════════════════════════════════════════════════════");
                                lines.push("  These tasks are optimally deferred or had unconverged duals.");
                                for (const id of s.parked) {
                                    const info = s.task_info.find(t => t.id === id);
                                    lines.push(`  • ${info?.name || id.slice(0, 8)}`);
                                }
                                lines.push("");
                            }

                            // QP priorities
                            if (s.raw_priorities?.length > 0) {
                                lines.push("══════════════════════════════════════════════════════════════");
                                lines.push("  STAGE 1: QP CONTINUOUS PRIORITIES (x_ic density)");
                                lines.push("══════════════════════════════════════════════════════════════");
                                for (const [name, c, v] of s.raw_priorities) {
                                    lines.push(`  ${pad(name, 45)} @ ${pad(chunkLabel(c, horizonStart, chunksPerDay), 20)}: ${v.toFixed(3)}`);
                                }
                                lines.push("");
                            }

                            // Packing trace
                            if (s.packing_trace?.length > 0) {
                                // Build a lookup from raw_priorities for Λ values
                                const lambdaMap = new Map();
                                if (s.raw_priorities) {
                                    for (const [name, c, v] of s.raw_priorities) {
                                        lambdaMap.set(`${name}:${c}`, v);
                                    }
                                }
                                lines.push("══════════════════════════════════════════════════════════════════════════");
                                lines.push("  STAGE 2: GREEDY PACKING ORDER");
                                lines.push("══════════════════════════════════════════════════════════════════════════");
                                lines.push(`  ${rpad("#", 4)}  ${pad("Task", 35)}  ${pad("Chunk", 20)}  ${rpad("Λ", 10)}  Slots`);
                                lines.push("  " + "─".repeat(85));
                                for (const [step, name, c, slots] of s.packing_trace) {
                                    const lv = lambdaMap.get(`${name}:${c}`);
                                    const lvStr = lv != null ? lv.toFixed(3) : "—";
                                    lines.push(`  ${rpad(String(step), 4)}  ${pad(name, 35)}  ${pad(chunkLabel(c, horizonStart, chunksPerDay), 20)}  ${rpad(lvStr, 10)}  ${fmtSlots(slots)}`);
                                }
                                lines.push("");
                            }

                            // Raw JSON
                            lines.push("══════════════════════════════════════════════════════════════");
                            lines.push("  RAW OUTPUT");
                            lines.push("══════════════════════════════════════════════════════════════");
                            lines.push(JSON.stringify(s, null, 2));

                            return lines.join("\n");
                        })()}</pre>
                    </section>
                </>}
            </div>
        </div>
    );
}
