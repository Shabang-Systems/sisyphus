import { useMemo } from "react";
import { useSelector } from "react-redux";
import Editor from "@views/Editor.jsx";
import "./Completed.css";

export default function Completed() {
    const tasks = useSelector(state => state.tasks.db);

    const completedTasks = useMemo(() => {
        return tasks
            .filter(t => t.completed_at)
            .sort((a, b) => b.completed_at.localeCompare(a.completed_at)); // most recent first
    }, [tasks]);

    return (
        <div className="completed-view">
            <div className="drag-region" data-tauri-drag-region />
            <Editor mode="browse" taskList={completedTasks} />
        </div>
    );
}
