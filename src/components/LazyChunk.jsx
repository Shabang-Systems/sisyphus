import { useState } from "react";
import { useInView } from "react-intersection-observer";
import { StaticTaskView } from "@components/TaskNodeView.jsx";
import Editor from "@views/Editor.jsx";

/**
 * Viewport-gated chunk wrapper for Action view.
 *
 * Renders tasks as lightweight static HTML until the chunk enters the viewport
 * (with a 1-screen buffer). Once visible, swaps in the full ProseMirror Editor.
 * The Editor stays mounted after activation — no unmount churn.
 */
export default function LazyChunk({ tasks, scheduleDate, onTaskDrag, onJumpToTask, triggerRebalance }) {
    const [active, setActive] = useState(false);
    const { ref } = useInView({
        rootMargin: "100% 0px",
        triggerOnce: true,
        onChange: (inView) => { if (inView) setActive(true); },
    });

    if (active) {
        return (
            <div ref={ref} className="action-editor-wrap">
                <Editor
                    mode="editor"
                    taskList={tasks}
                    jumpToTaskId={null}
                    onTaskDrag={onTaskDrag}
                    onJumpToTask={onJumpToTask}
                    triggerRebalance={triggerRebalance}
                    scheduleDate={scheduleDate}
                />
            </div>
        );
    }

    return (
        <div ref={ref} className="action-editor-wrap action-static-wrap">
            {tasks.map(task => (
                <StaticTaskView
                    key={task.id}
                    task={task}
                    onTaskDrag={onTaskDrag}
                    onJumpToTask={onJumpToTask}
                />
            ))}
        </div>
    );
}
