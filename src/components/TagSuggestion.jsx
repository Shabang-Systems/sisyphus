import { useState, useEffect, forwardRef, useImperativeHandle } from "react";
import "./TagSuggestion.css";

export default forwardRef(function TagSuggestion({ items, command, query }, ref) {
    const [selectedIndex, setSelectedIndex] = useState(0);

    useEffect(() => setSelectedIndex(0), [items]);

    useImperativeHandle(ref, () => ({
        onKeyDown: ({ event }) => {
            if (event.key === "ArrowUp") {
                setSelectedIndex((i) => (i + items.length - 1) % items.length);
                return true;
            }
            if (event.key === "ArrowDown") {
                setSelectedIndex((i) => (i + 1) % items.length);
                return true;
            }
            if (event.key === "Enter" || event.key === "Tab") {
                const pick = items[selectedIndex] || query;
                if (pick) command({ id: pick });
                return true;
            }
            if (event.key === " ") {
                // Space commits the tag with current query text
                if (query) command({ id: query });
                return true;
            }
            return false;
        },
    }));

    if (!items.length && !query) return null;

    return (
        <div className="tag-suggestion">
            {items.map((item, i) => (
                <div
                    key={item}
                    className={"tag-suggestion-item" + (i === selectedIndex ? " selected" : "")}
                    onClick={() => command({ id: item })}
                >
                    @{item}
                </div>
            ))}
        </div>
    );
});
