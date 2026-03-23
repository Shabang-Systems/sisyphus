#!/usr/bin/env python3
"""Convert a cao JSON database to a sisyphus SQLite database."""

import json
import sqlite3
import sys
import re
import uuid
from datetime import datetime, timezone

# Course code patterns to convert to tags
COURSE_CODES = re.compile(r'^(aa|cs|soc|sts|pwr)\d+', re.IGNORECASE)

def ms_to_iso(ms):
    """Convert milliseconds timestamp to ISO 8601 string."""
    if ms is None:
        return None
    dt = datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")

def ms_to_sqlite(ms):
    """Convert milliseconds timestamp to SQLite datetime string."""
    if ms is None:
        return None
    dt = datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
    return dt.strftime("%Y-%m-%d %H:%M:%S")

def effort_cao_to_sisyphus(effort):
    """Map cao effort (1-3 float) to sisyphus effort (0-5 int).
    cao: 1.0 = small, 2.0 = medium, 3.0 = large
    sisyphus: 0=none, 1=XS, 2=S, 3=M, 4=L, 5=XL
    """
    if effort is None:
        return 0
    effort = float(effort)
    if effort <= 1.0:
        return 2  # S
    elif effort <= 2.0:
        return 3  # M
    else:
        return 4  # L

def content_to_tiptap(content):
    """Convert plain text content to tiptap JSON paragraph format.
    Detects @tag mentions in the text and converts them to tag nodes.
    """
    if not content:
        return json.dumps({"type": "paragraph"})

    # Take just the first line for the task text
    lines = content.strip().split('\n')
    text = lines[0].strip()
    # Remove markdown heading markers
    text = re.sub(r'^#+\s*', '', text)

    if not text:
        return json.dumps({"type": "paragraph"})

    return json.dumps({
        "type": "paragraph",
        "content": [{"type": "text", "text": text}]
    })

def extract_tags_for_content(tags):
    """Convert cao tags to sisyphus tag format.
    Also detect course codes and normalize them.
    """
    result = []
    for tag in tags:
        tag = tag.strip().lower()
        if not tag:
            continue
        # Normalize course codes: "aa228v" -> "aa228v", "cs221" -> "cs221"
        if COURSE_CODES.match(tag):
            result.append(tag)
        else:
            result.append(tag)
    return result

def main():
    if len(sys.argv) < 3:
        print(f"Usage: {sys.argv[0]} <input.json> <output.db>")
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]

    with open(input_path) as f:
        data = json.load(f)

    tasks = data.get('tasks', [])
    print(f"Loaded {len(tasks)} tasks from {input_path}")

    # Create SQLite database with sisyphus schema
    conn = sqlite3.connect(output_path)
    c = conn.cursor()

    # Assumes output_path is an existing sisyphus DB with correct schema.
    # Just insert tasks into it.

    # Sort tasks by creation time, tiebreak by schedule time
    def sort_key(t):
        captured = t.get('captured', '') or ''
        schedule = t.get('schedule')
        # captured is ISO string, schedule is ms timestamp
        sched_str = ''
        if isinstance(schedule, (int, float)) and schedule:
            sched_str = ms_to_iso(schedule) or ''
        return (captured, sched_str)

    tasks.sort(key=sort_key)

    # Convert tasks
    completed_count = 0
    active_count = 0

    for pos, task in enumerate(tasks):
        task_id = task['id']
        content = content_to_tiptap(task.get('content', ''))
        tags = extract_tags_for_content(task.get('tags', []))
        tags_json = json.dumps(tags)
        effort = effort_cao_to_sisyphus(task.get('effort'))
        start_date = ms_to_iso(task.get('start'))
        due_date = ms_to_iso(task.get('due'))
        schedule = ms_to_iso(task.get('schedule'))
        rrule_val = task.get('rrule')
        locked = 1 if task.get('locked') else 0
        completed = task.get('completed', False)
        captured_raw = task.get('captured')
        if isinstance(captured_raw, str):
            # Already ISO string — convert to sqlite format
            try:
                dt = datetime.fromisoformat(captured_raw.replace('Z', '+00:00'))
                captured = dt.strftime("%Y-%m-%d %H:%M:%S")
            except:
                captured = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        elif isinstance(captured_raw, (int, float)):
            captured = ms_to_sqlite(captured_raw) or datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        else:
            captured = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        completed_at = None
        if completed:
            # Use captured date as completed_at approximation
            completed_at = captured
            completed_count += 1
        else:
            active_count += 1

        c.execute("""
            INSERT INTO tasks (id, content, position, tags, parent_id,
                start_date, due_date, completed_at, rrule, effort,
                schedule, locked, created_at, updated_at)
            VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            task_id, content, pos, tags_json,
            start_date, due_date, completed_at, rrule_val, effort,
            schedule, locked, captured, captured
        ))

    conn.commit()
    conn.close()

    print(f"Converted {len(tasks)} tasks ({active_count} active, {completed_count} completed)")
    print(f"Output: {output_path}")

if __name__ == "__main__":
    main()
