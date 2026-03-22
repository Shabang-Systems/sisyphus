import { useRef } from "react";
import { useDetectClickOutside } from "react-detect-click-outside";
import DatePicker from "./DatePicker.jsx";
import "./DateModal.css";

export default function DateModal({ onDate, onClose, initialDate, label }) {
    const wrapperRef = useDetectClickOutside({
        onTriggered: () => { if (typeof onClose === "function") onClose(); },
    });

    return (
        <div className="datemodal-backdrop">
            <div className="datemodal" ref={wrapperRef}>
                {label && <div className="datemodal-label">{label}</div>}
                <DatePicker
                    initialDate={initialDate}
                    onDate={d => { if (typeof onDate === "function") onDate(d); }}
                    onDone={d => {
                        if (typeof onDate === "function") onDate(d);
                        if (typeof onClose === "function") onClose();
                    }}
                    focus={true}
                />
            </div>
        </div>
    );
}
