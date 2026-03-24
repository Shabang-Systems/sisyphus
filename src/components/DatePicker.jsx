import { useEffect, useState, useCallback, useRef } from "react";
import { hydrateCalendar } from "@api/utils/date.js";
import moment from "moment";
import * as chrono from "chrono-node";
import strings from "@strings";
import "./DatePicker.css";

export default function DatePicker({ onDate, onDone, focus, initialDate }) {
    const [ref, setRef] = useState(initialDate || new Date());
    const [date, setDate] = useState(initialDate);
    const [timeString, setTimeString] = useState(initialDate ? moment(initialDate).format("h:mm a") : "");
    const dateField = useRef(null);

    useEffect(() => {
        if (focus && dateField.current) dateField.current.focus();
    }, [focus]);

    const today = new Date();
    const dateSeries = hydrateCalendar(ref.getFullYear(), ref.getMonth());

    // Set date and notify parent immediately
    const pickDate = useCallback((d) => {
        setDate(d);
        if (typeof onDate === "function") onDate(d);
    }, [onDate]);

    const parseDate = useCallback((text) => {
        try {
            const parsed = chrono.parse(text, new Date(), { forwardDate: true });
            if (!parsed.length) return null;
            const nd = parsed[0].start;
            const ndDate = nd.date();

            let newDate;
            const isTimeOnly = nd.impliedValues.day && nd.impliedValues.month && nd.impliedValues.year
                && typeof nd.knownValues.weekday === "undefined";
            if (isTimeOnly) {
                const d = date || ref;
                newDate = new Date(d.getFullYear(), d.getMonth(), d.getDate(),
                    ndDate.getHours(), ndDate.getMinutes(), ndDate.getSeconds());
            } else {
                newDate = ndDate;
                setRef(new Date(ndDate.getFullYear(), ndDate.getMonth(), 1));
            }
            setTimeString(moment(newDate).format("h:mm a"));
            pickDate(newDate);
            return newDate;
        } catch {
            setTimeString(moment(date || ref).format("h:mm a"));
            return date;
        }
    }, [date, ref, pickDate]);

    const forward = () => setRef(new Date(ref.getFullYear(), ref.getMonth() + 1, 1));
    const backward = () => setRef(new Date(ref.getFullYear(), ref.getMonth(), 0));

    const selectDay = (day) => {
        const d = date || ref;
        const res = new Date(ref.getFullYear(), ref.getMonth(), day,
            d.getHours(), d.getMinutes(), d.getSeconds());
        setTimeString(moment(res).format("h:mm a"));
        pickDate(res);
    };

    return (
        <div className="datepicker">
            <div className="datepicker-header">
                <div className="datepicker-nav" onClick={backward}>
                    <i className="fa-solid fa-angle-left" />
                </div>
                <div className="datepicker-title" onClick={() => setRef(new Date())}>
                    {moment(ref).format("MMMM YYYY")}
                </div>
                <div className="datepicker-nav" onClick={forward}>
                    <i className="fa-solid fa-angle-right" />
                </div>
            </div>
            <div className="dategrid">
                {["Su","Mo","Tu","We","Th","Fr","Sa"].map(d =>
                    <div key={d} className="dategrid-ann">{d}</div>
                )}
                {dateSeries[0].map(x =>
                    <div key={x + "p"} className="dategrid-cell dim" onClick={backward}>{x}</div>
                )}
                {dateSeries[1].map(x => {
                    const isActive = date && ref.getFullYear() === date.getFullYear() &&
                        ref.getMonth() === date.getMonth() && x === date.getDate();
                    const isToday = ref.getFullYear() === today.getFullYear() &&
                        ref.getMonth() === today.getMonth() && x === today.getDate();
                    return (
                        <div key={x}
                            className={"dategrid-cell" + (isActive ? " active" : "") + (isToday ? " today" : "")}
                            onClick={() => selectDay(x)}>{x}</div>
                    );
                })}
                {dateSeries[2].map(x =>
                    <div key={x + "s"} className="dategrid-cell dim" onClick={forward}>{x}</div>
                )}
            </div>
            <div className="datepicker-time">
                <input ref={dateField} className="datepicker-input"
                    placeholder={date ? strings.COMPONENTS__DATEPICKER_TIME : strings.COMPONENTS__DATEPICKER_DATETIME}
                    value={timeString}
                    autoComplete="off" autoCorrect="off" spellCheck={false}
                    onChange={e => setTimeString(e.target.value)}
                    onKeyDown={e => {
                        if (e.key === "Enter") {
                            const d = parseDate(e.target.value);
                            if (typeof onDone === "function") onDone(d);
                        } else if (e.key === "Escape") {
                            if (typeof onDone === "function") onDone(date);
                        }
                    }} />
                <i className="fa-solid fa-xmark datepicker-icon"
                    onClick={() => { setTimeString(""); pickDate(null); }} />
                <i className="fa-solid fa-check datepicker-icon"
                    onClick={() => {
                        if (dateField.current) parseDate(dateField.current.value);
                        if (typeof onDone === "function") onDone(date);
                    }} />
            </div>
        </div>
    );
}
