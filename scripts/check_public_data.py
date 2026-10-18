"""Validate the deployable public snapshot and report feed health to Actions."""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SNAPSHOT = ROOT / "public/data/rotterdam-snapshot.json"
HISTORY = ROOT / "public/data/traffic-history.json"
REQUIRED = ("traffic", "disruptions", "trees", "buildings", "resilience")


def age_hours(value, now):
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None or (parsed - now).total_seconds() > 120:
            return float("inf")
        return max(0, (now - parsed).total_seconds() / 3600)
    except (AttributeError, ValueError):
        return float("inf")


def check(snapshot, history, now):
    errors = []
    notes = []
    if not isinstance(snapshot, dict) or not isinstance(history, dict):
        return ["Snapshot and history must be JSON objects"], notes
    if snapshot.get("schemaVersion") != 1 or history.get("schemaVersion") != 1:
        errors.append("Unsupported data schema")
    for name in REQUIRED:
        section = snapshot.get(name)
        if not isinstance(section, dict):
            errors.append(f"Missing {name} section")
            continue
        age = age_hours(section.get("retrievedAt"), now)
        health = snapshot.get("health")
        feed_health = health.get(name) if isinstance(health, dict) else None
        status = feed_health.get("status", "unknown") if isinstance(feed_health, dict) else "unknown"
        notes.append(f"| {name} | {status} | {age:.1f} h |")
        if name == "traffic" and age > 4:
            errors.append("NDW traffic snapshot is over four hours old")
        if name == "traffic":
            readings = section.get("readings")
            if not isinstance(readings, list):
                readings = []
            latest_age = min((age_hours(row.get("observedAt"), now) for row in readings
                              if isinstance(row, dict)), default=float("inf"))
            if latest_age > 2:
                errors.append("NDW detector observations are missing or over two hours old")
        if name == "buildings" and not section.get("buildings"):
            errors.append("No 3DBAG buildings available")
    if not isinstance(history.get("readings"), list):
        errors.append("Traffic history is invalid")
    return errors, notes


def main():
    snapshot = json.loads(SNAPSHOT.read_text())
    history = json.loads(HISTORY.read_text())
    errors, notes = check(snapshot, history, datetime.now(timezone.utc))
    report = "## Rotterdam public data\n\n| Feed | Refresh | Age |\n| --- | --- | --- |\n" + "\n".join(notes)
    if errors:
        report += "\n\n" + "\n".join(f"- Error: {error}" for error in errors)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as out:
            out.write(report + "\n")
    print(report)
    if errors:
        sys.exit(1)


if __name__ == "__main__":
    main()
