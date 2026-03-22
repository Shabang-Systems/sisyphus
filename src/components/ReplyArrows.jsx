import { useEffect, useState, useRef, useCallback } from "react";
import { useSelector } from "react-redux";
import "./ReplyArrows.css";

export default function ReplyArrows({ editorRef, collapsedRoot }) {
    const tasks = useSelector(state => state.tasks.db);
    const [arrows, setArrows] = useState([]);
    const [hoveredTaskId, setHoveredTaskId] = useState(null);
    const [svgHeight, setSvgHeight] = useState(0);
    // Shadow state: taskId → { y, visible }
    const positionMap = useRef(new Map());

    const updatePositions = useCallback(() => {
        if (!editorRef) return;
        const container = document.querySelector(".editor-content");
        if (!container) return;
        const tiptap = container.querySelector(".tiptap");
        if (!tiptap) return;

        const originRect = tiptap.getBoundingClientRect();
        const map = new Map();

        const blocks = editorRef.querySelectorAll(".task-block");
        blocks.forEach(block => {
            const id = block.getAttribute("data-task-id");
            if (!id) return;
            const hidden = block.offsetParent === null;
            if (hidden) return;
            const rect = block.getBoundingClientRect();
            map.set(id, rect.top - originRect.top + rect.height / 2);
        });

        positionMap.current = map;
        setSvgHeight(tiptap.scrollHeight);
    }, [editorRef]);

    const buildArrows = useCallback(() => {
        const map = positionMap.current;
        if (!map.size) { setArrows([]); return; }

        const container = document.querySelector(".editor-content");
        const rightEdge = container ? container.clientWidth - 20 : 300;

        const result = [];
        for (const child of tasks) {
            if (!child.parent_id) continue;
            const parentY = map.get(child.parent_id);
            const childY = map.get(child.id);
            if (parentY == null || childY == null) continue;

            result.push({
                key: `${child.parent_id}-${child.id}`,
                parentId: child.parent_id,
                childId: child.id,
                parentY,
                childY,
                rightEdge,
            });
        }

        setArrows(result);
    }, [tasks]);

    // Update shadow positions + rebuild arrows
    const refresh = useCallback(() => {
        updatePositions();
        buildArrows();
    }, [updatePositions, buildArrows]);

    // On tasks/collapse change: update positions after a frame (layout settled)
    useEffect(() => {
        const raf = requestAnimationFrame(refresh);
        return () => cancelAnimationFrame(raf);
    }, [tasks, collapsedRoot, refresh]);

    // On scroll: just rebuild arrows from shadow state (positions are relative, no DOM read needed)
    useEffect(() => {
        const container = document.querySelector(".editor-content");
        if (!container) return;
        // Only need to rebuild on scroll if we ever use viewport-relative positions
        // With content-relative positions, arrows scroll with the SVG. No-op.
    }, []);

    // Observe DOM for tiptap re-renders (taskId stamps, etc.)
    useEffect(() => {
        if (!editorRef) return;
        const observer = new MutationObserver(() => {
            requestAnimationFrame(refresh);
        });
        observer.observe(editorRef, {
            childList: true, subtree: true,
            attributes: true, attributeFilter: ["data-task-id"],
        });
        return () => observer.disconnect();
    }, [editorRef, refresh]);

    // Hover tracking
    useEffect(() => {
        if (!editorRef) return;
        const onOver = (e) => {
            const block = e.target.closest?.(".task-block");
            setHoveredTaskId(block?.getAttribute("data-task-id") || null);
        };
        const onOut = () => setHoveredTaskId(null);
        editorRef.addEventListener("mouseover", onOver);
        editorRef.addEventListener("mouseleave", onOut);
        return () => {
            editorRef.removeEventListener("mouseover", onOver);
            editorRef.removeEventListener("mouseleave", onOut);
        };
    }, [editorRef]);

    if (!arrows.length) return null;

    return (
        <svg className="reply-arrows-overlay" style={{ height: svgHeight || "100%" }}>
            {arrows.map(({ key, parentId, childId, parentY, childY, rightEdge }) => {
                const x1 = rightEdge - 16;
                const x2 = rightEdge;
                const active = hoveredTaskId === parentId;
                const a = 5;

                return (
                    <g key={key} className={"reply-arrow" + (active ? " active" : "")}>
                        <path d={`M ${x1} ${parentY} L ${x2} ${parentY} L ${x2} ${childY} L ${x1} ${childY}`} />
                        <path d={`M ${x1 + a} ${childY - a} L ${x1} ${childY} L ${x1 + a} ${childY + a}`} />
                    </g>
                );
            })}
        </svg>
    );
}
