#!/usr/bin/env python3
"""Fail when the Stream Slack task tree disagrees with its declared contract."""

import re
import sys
from collections import defaultdict
from pathlib import Path

from build_queue import TASKS, parse_frontmatter

REQUIRED_FIELDS = {
    "id",
    "epic",
    "title",
    "priority",
    "status",
    "depends_on",
    "estimate",
    "capstone",
}
REQUIRED_SECTIONS = (
    "## Goal",
    "## Context",
    "## Deliverables",
    "## Acceptance criteria",
    "## Adversarial verification",
    "## Verification log",
)


def fail(errors: list[str], message: str) -> None:
    errors.append(message)


def main() -> int:
    errors: list[str] = []
    tasks: dict[str, dict] = {}
    priorities: dict[int | float, str] = {}
    by_epic: dict[int | float, list[dict]] = defaultdict(list)

    for path in sorted(TASKS.glob("epic-*/E*-T*/readme.md")):
        task = parse_frontmatter(path)
        if task is None:
            fail(errors, f"{path}: missing flat YAML frontmatter")
            continue

        missing = REQUIRED_FIELDS - set(task)
        if missing:
            fail(errors, f"{path}: missing fields {sorted(missing)}")
            continue

        task_id = task["id"]
        if task_id in tasks:
            fail(errors, f"{path}: duplicate id {task_id}")
        tasks[task_id] = task
        by_epic[task["epic"]].append(task)

        priority = task["priority"]
        if priority in priorities:
            fail(
                errors,
                f"{path}: priority {priority} duplicates {priorities[priority]}",
            )
        priorities[priority] = task_id

        match = re.fullmatch(r"E(\d+)-T(\d+)([ab]?)", task_id)
        if not match:
            fail(errors, f"{path}: unsupported task id {task_id!r}")
        else:
            epic_number = int(match.group(1))
            task_number = int(match.group(2))
            expected_priority = epic_number * 100 + task_number
            if epic_number == 0:
                expected_priority = task_number
            if priority != expected_priority:
                fail(
                    errors,
                    f"{path}: priority {priority} should be {expected_priority}",
                )
            if task["epic"] != epic_number:
                fail(
                    errors,
                    f"{path}: epic {task['epic']} disagrees with id {task_id}",
                )

        text = path.read_text(encoding="utf-8")
        section_positions = [text.find(section) for section in REQUIRED_SECTIONS]
        if any(position < 0 for position in section_positions):
            missing_sections = [
                section
                for section, position in zip(REQUIRED_SECTIONS, section_positions)
                if position < 0
            ]
            fail(errors, f"{path}: missing sections {missing_sections}")
        elif section_positions != sorted(section_positions):
            fail(errors, f"{path}: required sections are out of order")

        acceptance = text.split("## Acceptance criteria", 1)[-1].split(
            "## Adversarial verification", 1
        )[0]
        if acceptance.count("- [ ]") < 3:
            fail(errors, f"{path}: fewer than three binary acceptance criteria")
        if "- [x]" in acceptance.lower():
            fail(errors, f"{path}: acceptance boxes must remain unchecked")

        adversarial = text.split("## Adversarial verification", 1)[-1].split(
            "## Verification log", 1
        )[0]
        if len(re.findall(r"(?m)^\d+\. ", adversarial)) < 2:
            fail(errors, f"{path}: fewer than two adversarial attacks")

        if task["epic"] <= 7 and "Replay: N/A" not in text:
            fail(errors, f"{path}: server task lacks explicit Replay N/A declaration")
        if task["epic"] >= 8 and ("Replay" not in text or "MP4" not in text):
            fail(errors, f"{path}: browser task lacks Replay plus MP4 evidence")

    if not tasks:
        fail(errors, "no tasks found")

    capstone_by_epic: dict[str, str] = {}
    for epic, epic_tasks in sorted(by_epic.items()):
        capstones = [task for task in epic_tasks if task["capstone"]]
        if len(capstones) != 1:
            fail(errors, f"E{epic}: expected one capstone, found {len(capstones)}")
            continue
        capstone = capstones[0]
        capstone_by_epic[f"E{epic}"] = capstone["id"]
        if capstone["priority"] != max(task["priority"] for task in epic_tasks):
            fail(errors, f"{capstone['id']}: capstone is not last in its epic")

    # Resolve bare epic dependencies to capstone task IDs and reject unknown refs.
    graph: dict[str, list[str]] = {}
    for task_id, task in tasks.items():
        resolved: list[str] = []
        for dependency in task["depends_on"]:
            if dependency in tasks:
                resolved.append(dependency)
            elif dependency in capstone_by_epic:
                resolved.append(capstone_by_epic[dependency])
            else:
                fail(errors, f"{task_id}: unknown dependency {dependency}")
        graph[task_id] = resolved

    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(task_id: str, trail: list[str]) -> None:
        if task_id in visiting:
            cycle_start = trail.index(task_id)
            fail(errors, "dependency cycle: " + " -> ".join(trail[cycle_start:] + [task_id]))
            return
        if task_id in visited:
            return
        visiting.add(task_id)
        for dependency in graph.get(task_id, []):
            visit(dependency, trail + [task_id])
        visiting.remove(task_id)
        visited.add(task_id)

    for task_id in graph:
        visit(task_id, [])

    expected_epics = list(range(12))
    actual_epics = sorted(int(epic) for epic in by_epic)
    if actual_epics != expected_epics:
        fail(
            errors,
            f"epic set is {actual_epics}; expected {expected_epics}",
        )

    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        print(f"backlog audit failed: {len(errors)} error(s)", file=sys.stderr)
        return 1

    print(
        f"ok: {len(tasks)} tasks, {len(by_epic)} epics, "
        f"{len(capstone_by_epic)} capstones, dependency graph acyclic"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
