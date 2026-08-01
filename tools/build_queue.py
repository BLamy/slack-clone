#!/usr/bin/env python3
"""Regenerate .eforest/tasks/QUEUE.md from task readme frontmatter.

Stdlib only. The accepted flat-YAML subset is documented in
.eforest/tasks/README.md.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TASKS = ROOT / ".eforest" / "tasks"
QUEUE = TASKS / "QUEUE.md"

STATUS_ICON = {
    "pending": " ",
    "in-progress": "~",
    "in_progress": "~",
    "implemented": "?",
    "refuted": "!",
    "verified": "x",
    "cancelled": "-",
}


def parse_frontmatter(path: Path) -> dict | None:
    text = path.read_text(encoding="utf-8")
    match = re.match(r"\A---\n(.*?)\n---\n", text, re.DOTALL)
    if not match:
        return None

    frontmatter: dict = {"_path": path}
    for line in match.group(1).splitlines():
        if ":" not in line:
            continue
        key, _, raw_value = line.partition(":")
        key = key.strip()
        value = raw_value.split("#", 1)[0].strip()
        if key == "depends_on":
            frontmatter[key] = [
                dependency.strip()
                for dependency in value.strip("[]").split(",")
                if dependency.strip()
            ]
        elif key == "priority":
            frontmatter[key] = float(value) if "." in value else int(value)
        elif key == "epic":
            frontmatter[key] = int(value) if value.isdigit() else float(value)
        elif key == "capstone":
            frontmatter[key] = value.lower() == "true"
        else:
            frontmatter[key] = value.strip('"')
    return frontmatter


def main() -> int:
    tasks: list[dict] = []
    for path in sorted(TASKS.glob("epic-*/E*-T*/readme.md")):
        task = parse_frontmatter(path)
        if task is None or "id" not in task:
            print(f"error: invalid or missing frontmatter: {path}", file=sys.stderr)
            return 1

        folder_id = re.match(r"(E[0-9.]+-T[0-9]+[ab]?)", path.parent.name)
        if not folder_id or folder_id.group(1) != task["id"]:
            print(
                f"error: folder {path.parent.name!r} disagrees with id {task['id']!r}",
                file=sys.stderr,
            )
            return 1
        tasks.append(task)

    if not tasks:
        print("error: no task readmes found", file=sys.stderr)
        return 1

    tasks.sort(key=lambda task: task.get("priority", 999999))
    task_ids = [task["id"] for task in tasks]
    if len(task_ids) != len(set(task_ids)):
        print("error: duplicate task id", file=sys.stderr)
        return 1

    known_refs = set(task_ids)
    capstones: dict[str, dict] = {}
    for task in tasks:
        if task.get("capstone"):
            epic_ref = f"E{task['epic']}"
            if epic_ref in capstones:
                print(f"error: multiple capstones for {epic_ref}", file=sys.stderr)
                return 1
            capstones[epic_ref] = task
    known_refs.update(capstones)

    for task in tasks:
        for dependency in task.get("depends_on", []):
            if dependency not in known_refs:
                print(
                    f"error: {task['id']} depends on unknown reference {dependency}",
                    file=sys.stderr,
                )
                return 1

    verified = {task["id"] for task in tasks if task.get("status") == "verified"}
    verified_epics = {
        epic_ref
        for epic_ref, task in capstones.items()
        if task.get("status") == "verified"
    }
    satisfied = verified | verified_epics

    def eligible(task: dict) -> bool:
        return task.get("status") in ("pending", "refuted") and all(
            dependency in satisfied for dependency in task.get("depends_on", [])
        )

    active = [
        task
        for task in tasks
        if task.get("status")
        in ("in-progress", "in_progress", "implemented", "refuted")
    ]
    if len(active) > 1:
        print(
            "error: multiple active tasks violate the one-gate rule: "
            + ", ".join(task["id"] for task in active),
            file=sys.stderr,
        )
        return 1

    for task in tasks:
        status = task.get("status", "pending")
        if status not in STATUS_ICON:
            print(f"error: {task['id']} has unknown status {status!r}", file=sys.stderr)
            return 1

    current_gate = active[0] if active else None
    next_up = [
        task
        for task in tasks
        if eligible(task) and task.get("status") == "pending"
    ][:10]

    unlocks: list[dict] = []
    if current_gate is not None:
        hypothetical = satisfied | {current_gate["id"]}
        if current_gate.get("capstone"):
            hypothetical.add(f"E{current_gate['epic']}")
        unlocks = [
            task
            for task in tasks
            if task.get("status") == "pending"
            and all(dep in hypothetical for dep in task.get("depends_on", []))
            and task not in next_up
        ][:10]

    lines = [
        "# Stream Slack Priority Queue",
        "",
        "*Generated by `tools/build_queue.py` — do not edit by hand.*",
        "",
        f"**{len(verified)} / {len(tasks)} tasks verified.**",
        "",
        "Legend: `[ ]` pending · `[~]` in-progress · `[?]` implemented "
        "(awaiting adversarial verification) · `[!]` refuted · `[x]` verified · "
        "`[-]` cancelled",
        "",
        "## Current gate",
        "",
    ]

    if current_gate is None:
        lines.append("No task is currently in progress, awaiting verification, or refuted.")
    else:
        action = {
            "in-progress": "builder working",
            "in_progress": "builder working",
            "implemented": "awaiting independent critic",
            "refuted": "builder rework required",
        }[current_gate["status"]]
        lines.append(
            f"1. **{current_gate['id']}** — {current_gate.get('title', '?')} "
            f"*({action})*"
        )

    lines.extend(["", "## Next up (dependencies satisfied)", ""])
    if next_up:
        for task in next_up:
            lines.append(f"1. **{task['id']}** — {task.get('title', '?')}")
    elif current_gate is not None:
        lines.append(
            f"No new task may start until **{current_gate['id']}** clears the gate."
        )
    else:
        lines.append("No pending task currently has all dependencies verified.")

    if current_gate is not None:
        lines.extend(["", f"## Unlocks when {current_gate['id']} verifies", ""])
        if unlocks:
            for task in unlocks:
                lines.append(f"1. **{task['id']}** — {task.get('title', '?')}")
        else:
            lines.append("No task unlocks directly.")

    current_epic = None
    for task in tasks:
        if task.get("epic") != current_epic:
            current_epic = task.get("epic")
            epic_dir = task["_path"].parent.parent.name
            lines.extend(["", f"## Epic {current_epic} — `{epic_dir}`", ""])

        icon = STATUS_ICON[task.get("status", "pending")]
        relative_path = task["_path"].relative_to(TASKS).as_posix()
        dependencies = ", ".join(task.get("depends_on", [])) or "—"
        capstone = " **[CAPSTONE]**" if task.get("capstone") else ""
        lines.append(
            f"- [{icon}] `{task.get('priority', '?'):>4}` "
            f"[{task['id']}]({relative_path}) — {task.get('title', '?')}"
            f"{capstone} *(deps: {dependencies})*"
        )

    QUEUE.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(
        f"wrote {QUEUE.relative_to(ROOT)}: {len(tasks)} tasks, "
        f"{len(verified)} verified, {len(capstones)} epics"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
