import { useEffect, useState, useCallback, useRef } from "react";
import { useSelector } from "react-redux";
import "./ReplyArrows.css";

export default function ReplyArrows({ editorRef }) {
    const tasks = useSelector(state => state.tasks.db);
    const [arrows, setArrows] = useState([]);
    const [hoveredTaskId, setHoveredTaskId] = useState(null);
    const retryRef = useRef(null);

    const computeArrows = useCallback(() => {
        if (!editorRef) return;

        const container = document.querySelector(".editor-content");
        if (!container) return;

        const containerRect = container.getBoundingClientRect();
        const scrollTop = container.scrollTop;

        const relations = tasks.filter(t => t.parent_id);
        if (!relations.length) { setArrows([]); return; }

        const newArrows = [];
        let missing = false;
        for (const child of relations) {
            const parentEl = editorRef.querySelector(`[data-task-id="${child.parent_id}"]`);
            const childEl = editorRef.querySelector(`[data-task-id="${child.id}"]`);
            if (!parentEl || !childEl) { missing = true; continue; }

            const parentRect = parentEl.getBoundingClientRect();
            const childRect = childEl.getBoundingClientRect();

            const parentY = parentRect.top - containerRect.top + scrollTop + parentRect.height / 2;
            const childY = childRect.top - containerRect.top + scrollTop + childRect.height / 2;
            const rightEdge = containerRect.width - 20;

            newArrows.push({
                key: `${child.parent_id}-${child.id}`,
                parentId: child.parent_id,
                childId: child.id,
                parentY,
                childY,
                rightEdge,
            });
        }

        setArrows(newArrows);

        if (missing && !retryRef.current) {
            retryRef.current = setTimeout(() => {
                retryRef.current = null;
                computeArrows();
            }, 500);
        }
    }, [tasks, editorRef]);

    useEffect(() => {
        computeArrows();
        const container = document.querySelector(".editor-content");
        if (container) {
            container.addEventListener("scroll", computeArrows);
            return () => container.removeEventListener("scroll", computeArrows);
        }
    }, [computeArrows]);

    useEffect(() => {
        const timer = setTimeout(computeArrows, 200);
        return () => clearTimeout(timer);
    }, [tasks, computeArrows]);

    useEffect(() => {
        const timer = setTimeout(computeArrows, 1000);
        return () => clearTimeout(timer);
    }, [editorRef]);

    // Track which task-block is hovered
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
        <svg className="reply-arrows-overlay">
            {arrows.map(({ key, parentId, childId, parentY, childY, rightEdge }) => {
                const x1 = rightEdge - 16;
                const x2 = rightEdge;
                const active = hoveredTaskId === parentId || hoveredTaskId === childId;
                // Arrow tip pointing left at the child end
                const a = 5;

                return (
                    <g key={key} className={"reply-arrow" + (active ? " active" : "")}>
                        <path
                            d={`M ${x1} ${parentY} L ${x2} ${parentY} L ${x2} ${childY} L ${x1} ${childY}`}
                        />
                        <path
                            d={`M ${x1 + a} ${childY - a} L ${x1} ${childY} L ${x1 + a} ${childY + a}`}
                        />
                    </g>
                );
            })}
        </svg>
    );
}
