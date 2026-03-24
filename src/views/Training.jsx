import { useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import strings from "@strings";
import "./Training.css";

const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const CHUNK_LABELS = strings.CHUNK_LABELS;
const TAG_RE = /@(\w+)/g;

function parseTaskInput(raw) {
    const tags = [];
    let match;
    while ((match = TAG_RE.exec(raw)) !== null) tags.push(match[1]);
    TAG_RE.lastIndex = 0;
    const text = raw.replace(TAG_RE, "").trim();
    return { text, tag: tags[0] || null };
}

export default function Training({ onBack }) {
    const [input, setInput] = useState("");
    const [tasks, setTasks] = useState([]); // { id, text, tag }
    const [selected, setSelected] = useState(null); // task id selected for placement
    const [trained, setTrained] = useState([]); // { text, tag, dow, chunk }
    const nextId = useRef(0);

    const handleKeyDown = useCallback((e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        const { text, tag } = parseTaskInput(input);
        if (!text || !tag) return;

        const task = { id: nextId.current++, text, tag };
        setTasks(prev => [...prev, task]);
        setInput("");

        // Train NB tag model immediately
        invoke("train_nb_tag", { text, tag }).catch(console.error);
    }, [input]);

    const removeTask = useCallback((id) => {
        setTasks(prev => prev.filter(t => t.id !== id));
        setSelected(prev => prev === id ? null : prev);
    }, []);

    const selectTask = useCallback((id) => {
        setSelected(prev => prev === id ? null : id);
    }, []);

    const handleCellClick = useCallback((dowIdx, chunkIdx) => {
        if (selected == null) return;
        const task = tasks.find(t => t.id === selected);
        if (!task) return;

        // Train Dirichlet: dow is 1-indexed (Mon=1..Sun=7), chunk is 1-indexed (1..6)
        const dow = dowIdx + 1;
        const chunk = chunkIdx + 1;
        const slots = 2.0; // Default S-size = 2 slots

        invoke("train_dirichlet", {
            observations: [[dow, chunk, task.tag, slots]],
        }).catch(console.error);

        setTrained(prev => [...prev, {
            text: task.text,
            tag: task.tag,
            dow: dowIdx,
            chunk: chunkIdx,
        }]);

        // Remove from task list, clear selection
        setTasks(prev => prev.filter(t => t.id !== selected));
        setSelected(null);
    }, [selected, tasks]);

    // Build grid data from trained observations
    const gridData = {};
    for (const t of trained) {
        const key = `${t.dow}:${t.chunk}`;
        if (!gridData[key]) gridData[key] = [];
        gridData[key].push(t);
    }

    return (
        <div className="training">
            <div className="drag-region" data-tauri-drag-region />
            <div className="training-main">
                <div className="training-header">
                    <span className="training-back" onClick={onBack}>
                        <i className="fa-solid fa-arrow-left" />
                    </span>
                    <span className="training-title">{strings.VIEWS__TRAINING_TITLE}</span>
                </div>

                <div className="training-instructions">
                    {strings.VIEWS__TRAINING_INSTRUCTIONS.map((p, i) => <p key={i}>{p}</p>)}
                </div>

                <div className="training-input-section">
                    <input
                        className="training-input"
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder={strings.VIEWS__TRAINING_INPUT_PLACEHOLDER}
                        spellCheck={false}
                        autoComplete="off"
                    />
                </div>

                {tasks.length > 0 && (
                    <div className="training-tasks">
                        <div className="training-section-label">{strings.VIEWS__TRAINING_TASKS_LABEL}</div>
                        {tasks.map(task => (
                            <div
                                key={task.id}
                                className={`training-task${selected === task.id ? " selected" : ""}`}
                                onClick={() => selectTask(task.id)}
                            >
                                <span className="training-task-text">{task.text}</span>
                                <span className="training-task-tag">@{task.tag}</span>
                                <span className="training-task-remove" onClick={(e) => { e.stopPropagation(); removeTask(task.id); }}>
                                    <i className="fa-solid fa-xmark" />
                                </span>
                            </div>
                        ))}
                    </div>
                )}

                <div className="training-grid-section">
                    <div className="training-section-label">{strings.VIEWS__TRAINING_GRID_LABEL}</div>
                    <div className="training-grid">
                        <div className="training-grid-header">
                            <div className="training-grid-corner" />
                            {CHUNK_LABELS.map((label, i) => (
                                <div key={i} className="training-grid-col-label">{label}</div>
                            ))}
                        </div>
                        {DOW_LABELS.map((dowLabel, dowIdx) => (
                            <div key={dowIdx} className="training-grid-row">
                                <div className="training-grid-row-label">{dowLabel}</div>
                                {CHUNK_LABELS.map((_, chunkIdx) => {
                                    const key = `${dowIdx}:${chunkIdx}`;
                                    const cellTasks = gridData[key] || [];
                                    return (
                                        <div
                                            key={chunkIdx}
                                            className={`training-grid-cell${selected != null ? " clickable" : ""}${cellTasks.length > 0 ? " filled" : ""}`}
                                            onClick={() => handleCellClick(dowIdx, chunkIdx)}
                                        >
                                            {cellTasks.map((ct, ci) => (
                                                <div key={ci} className="training-grid-cell-tag" title={ct.text}>
                                                    @{ct.tag}
                                                </div>
                                            ))}
                                        </div>
                                    );
                                })}
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
}
