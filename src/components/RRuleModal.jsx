import { useState, useEffect, useRef, useCallback } from "react";
import { useDetectClickOutside } from "react-detect-click-outside";
import { RRule } from "rrule";
import strings from "@strings";
import "./RRuleModal.css";

export default function RRuleModal({ onClose, onChange, initialRrule }) {
    const [textValue, setText] = useState(initialRrule ? RRule.fromString(initialRrule).toText() : "");
    const [rrule, setRRule] = useState(initialRrule ? RRule.fromString(initialRrule) : null);
    const inputRef = useRef(null);
    const changeTimeout = useRef(null);

    useEffect(() => {
        if (inputRef.current) inputRef.current.focus();
    }, []);

    useEffect(() => {
        return () => { if (changeTimeout.current) clearTimeout(changeTimeout.current); };
    }, []);

    const rrulify = useCallback((text) => {
        try {
            if (!text || !text.trim()) {
                setRRule(null);
                if (typeof onChange === "function") onChange(null);
            } else {
                const rule = RRule.fromText(text.trim());
                setRRule(rule);
                if (typeof onChange === "function") onChange(rule.toString());
            }
        } catch {
            setRRule(null);
            if (typeof onChange === "function") onChange(null);
        }
    }, [onChange]);

    const wrapperRef = useDetectClickOutside({
        onTriggered: () => { if (typeof onClose === "function") onClose(); },
    });

    return (
        <div className="rrulemodal-backdrop">
            <div className="rrulemodal" ref={wrapperRef}>
                <div className="rrulemodal-header">{strings.COMPONENTS__RRULEMODAL_REPEAT}</div>
                <input
                    ref={inputRef}
                    className="rrulemodal-input"
                    autoCorrect="off"
                    placeholder={strings.COMPONENTS__RRULEMODAL_EVERY}
                    value={textValue}
                    onKeyDown={e => {
                        if (e.key === "Enter") { if (typeof onClose === "function") onClose(); }
                        else if (e.key === "Escape") { if (typeof onClose === "function") onClose(); }
                    }}
                    onChange={e => {
                        setText(e.target.value);
                        if (changeTimeout.current) clearTimeout(changeTimeout.current);
                        changeTimeout.current = setTimeout(() => {
                            let lc = e.target.value.trim().toLowerCase();
                            if (lc && !lc.startsWith("every")) lc = "every " + lc;
                            rrulify(lc);
                        }, 100);
                    }}
                />
                <div className="rrulemodal-hint">
                    {rrule ? rrule.toText() : strings.COMPONENTS__RRULEMODAL_NONE}
                </div>
            </div>
        </div>
    );
}
