import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useDispatch, useSelector } from "react-redux";
import { invoke } from "@tauri-apps/api/core";
import { search, addTask } from "@api/tasks.js";
import { txCreate } from "@api/sync.js";
import { localISO } from "@api/utils.js";
import { v4 as uuid } from "uuid";
import Editor from "@views/Editor.jsx";
import strings from "@strings";
import "./Browse.css";

export default function Browse() {
    const dispatch = useDispatch();
    const [sheets, setSheets] = useState([]);
    const [currentIndex, setCurrentIndex] = useState(0);
    const [query, setQuery] = useState("");
    const searchResults = useSelector(state => state.tasks.searchResults);
    const tasks = useSelector(state => state.tasks.db);
    const debounceRef = useRef(null);
    const saveRef = useRef(null);

    useEffect(() => {
        invoke("list_sheets").then(s => {
            setSheets(s);
            if (s.length > 0) setQuery(s[0].query);
        });
    }, []);

    const currentSheet = sheets[currentIndex];

    useEffect(() => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
            dispatch(search(query));
        }, 400);
        return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    }, [query, dispatch]);

    useEffect(() => {
        if (!currentSheet) return;
        if (saveRef.current) clearTimeout(saveRef.current);
        saveRef.current = setTimeout(() => {
            if (query !== currentSheet.query) {
                invoke("upsert_sheet", { id: currentSheet.id, query }).then(updated => {
                    setSheets(prev => prev.map(s => s.id === updated.id ? updated : s));
                });
            }
        }, 500);
        return () => { if (saveRef.current) clearTimeout(saveRef.current); };
    }, [query, currentSheet]);

    const goToSheet = useCallback((index) => {
        if (index < 0 || index >= sheets.length) return;
        setCurrentIndex(index);
        const newQuery = sheets[index].query;
        setQuery(newQuery);
        // Immediately search to avoid stale results flash
        dispatch(search(newQuery));
    }, [sheets, dispatch]);

    const goUp = useCallback(() => {
        // If current sheet is blank and it's the last one, pop it and go to previous
        if (!query && currentIndex === sheets.length - 1 && sheets.length > 1) {
            invoke("remove_sheet", { id: currentSheet.id }).then(() => {
                const newSheets = sheets.filter(s => s.id !== currentSheet.id);
                setSheets(newSheets);
                const newIndex = Math.max(0, currentIndex - 1);
                setCurrentIndex(newIndex);
                const newQuery = newSheets[newIndex]?.query || "";
                setQuery(newQuery);
                dispatch(search(newQuery));
            });
        } else if (currentIndex > 0) {
            goToSheet(currentIndex - 1);
        }
    }, [currentIndex, currentSheet, sheets, query, goToSheet]);

    const goDown = useCallback(() => {
        if (currentIndex < sheets.length - 1) {
            goToSheet(currentIndex + 1);
        } else {
            invoke("add_sheet").then(sheet => {
                setSheets(prev => [...prev, sheet]);
                setCurrentIndex(sheets.length);
                setQuery("");
                dispatch(search(""));
            });
        }
    }, [currentIndex, sheets, goToSheet]);

    const isEmpty = !query;
    const noResults = query && searchResults && searchResults.length === 0;
    const tooMany = query && searchResults && searchResults.length > 300;
    const filterIds = useMemo(() => {
        return query && searchResults && !tooMany ? new Set(searchResults.map(t => t.id)) : null;
    }, [query, searchResults, tooMany]);

    const browseTaskList = useMemo(() => {
        if (!query || !searchResults || tooMany) return null;
        return searchResults;
    }, [query, searchResults, tooMany]);

    const createFromSearch = useCallback(() => {
        const normalized = query.replace(/[.*+?^${}()|[\]\\]/g, "");
        if (!normalized) return;
        const ts = localISO();
        const id = uuid();
        const task = {
            id,
            content: JSON.stringify({ type: "paragraph", content: [{ type: "text", text: normalized }] }),
            position: tasks.length,
            tags: "[]",
            parent_id: null, start_date: null, due_date: null,
            completed_at: null, rrule: null, effort: 0,
            schedule: null, locked: false,
            effective_due: null, is_deferred: false,
            created_at: ts, updated_at: ts,
        };
        dispatch(addTask(task));
        txCreate(task);
        dispatch(search(query));
    }, [query, tasks.length, dispatch]);

    return (
        <div className="browse">
            <div className="drag-region" data-tauri-drag-region />
            <div className="browse-search">
                <i className="fa-solid fa-magnifying-glass browse-search-icon" />
                <input
                    className="browse-search-input"
                    placeholder={strings.VIEWS__BROWSE_PLACEHOLDER}
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    autoFocus
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                />
            </div>

            <div className="browse-sheets">
                <div className="browse-sheet-arrows">
                    <div className={"browse-sheet-btn" + (currentIndex === 0 && (query || sheets.length <= 1) ? " disabled" : "")}
                        onClick={goUp}
                        data-tooltip-id="rootp" data-tooltip-content={strings.TOOLTIPS.PREVIOUS_SHEET} data-tooltip-place="left">
                        <i className="fa-solid fa-chevron-up" />
                    </div>
                    <div className="browse-sheet-btn" onClick={goDown}
                        data-tooltip-id="rootp" data-tooltip-content={strings.TOOLTIPS.NEXT_SHEET} data-tooltip-place="left">
                        <i className="fa-solid fa-chevron-down" />
                    </div>
                </div>
                <ul className="browse-sheet-dots">
                    {sheets.map((s, i) => (
                        <li key={s.id}
                            className={"browse-sheet-dot" + (i === currentIndex ? " active" : "")}
                            onClick={() => goToSheet(i)}
                            data-tooltip-id="rootp" data-tooltip-content={s.query || "(empty)"} data-tooltip-place="left"
                        />
                    ))}
                </ul>
            </div>

            <div className="browse-editor-container">
                <Editor mode="browse" filterTaskIds={filterIds} searchQuery={query} taskList={browseTaskList} />
                {isEmpty && (
                    <div className="browse-overlay">
                        <div className="browse-empty-hint">{strings.VIEWS__BROWSE_EMPTY_PROMPT}</div>
                    </div>
                )}
                {tooMany && (
                    <div className="browse-overlay">
                        <div className="browse-empty-hint">
                            {strings.VIEWS__BROWSE_TOO_MANY.replace("{n}", String(searchResults.length))}
                        </div>
                    </div>
                )}
                {noResults && (
                    <div className="browse-overlay">
                        <div className="browse-empty-hint">{strings.VIEWS__BROWSE_NO_RESULTS}</div>
                    </div>
                )}
            </div>
        </div>
    );
}
