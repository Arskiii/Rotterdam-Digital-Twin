"""Keep a bounded history of real NDW observations across static site builds."""

import json
import math
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SNAPSHOT = ROOT / "public/data/rotterdam-snapshot.json"
OUTPUT = ROOT / "public/data/traffic-history.json"
RETENTION_DAYS = 7


def parse_time(value):
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        return None


def valid_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def merge_history(previous, current, now):
    cutoff = now - timedelta(days=RETENTION_DAYS)
    merged = {}
    for row in [*previous, *current]:
        if not isinstance(row, dict):
            continue
        observed = parse_time(row.get("observedAt"))
        if not observed or observed.tzinfo is None or not cutoff <= observed <= now + timedelta(minutes=2):
            continue
        ident = row.get("id")
        speed, flow = row.get("speedKmh"), row.get("vehiclesPerHour")
        lat, lon = row.get("lat"), row.get("lon")
        if not isinstance(ident, str) or not ident.strip() or len(ident) > 100 or not (
            (valid_number(speed) and 0 <= speed <= 200) or
            (valid_number(flow) and 0 <= flow <= 100_000)
        ) or not (valid_number(lat) and 51.8 <= lat <= 52.1 and
                  valid_number(lon) and 4.3 <= lon <= 4.7):
            continue
        # Equivalent timestamps with different offsets identify one observation.
        # Store one UTC representation even if a producer changes its timezone.
        observed_at = observed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        merged[(ident, observed_at)] = {
            "id": ident, "name": str(row.get("name") or "Traffic detector")[:80],
            "lat": lat, "lon": lon,
            "observedAt": observed_at,
            "speedKmh": speed if valid_number(speed) and 0 <= speed <= 200 else None,
            "vehiclesPerHour": flow if valid_number(flow) and 0 <= flow <= 100_000 else None,
        }
    return sorted(merged.values(), key=lambda item: (parse_time(item["observedAt"]), item["id"]))[-2000:]


def load_previous(path):
    if not path.exists():
        return []
    if path.stat().st_size > 2_000_000:
        raise ValueError("Retained history exceeds 2 MB; refusing to overwrite it")
    data = json.loads(path.read_text())
    if not isinstance(data, dict) or data.get("schemaVersion") != 1 or not isinstance(data.get("readings"), list):
        raise ValueError("Invalid retained history; refusing to overwrite it")
    return data["readings"]


def write_history(snapshot_path, output_path, now):
    snapshot = json.loads(snapshot_path.read_text())
    if not isinstance(snapshot, dict) or not isinstance(snapshot.get("traffic", {}), dict):
        raise ValueError("Invalid traffic snapshot")
    previous = load_previous(output_path)
    current = snapshot.get("traffic", {}).get("readings", [])
    if not isinstance(current, list):
        raise ValueError("Invalid traffic readings")
    readings = merge_history(previous, current, now)
    payload = {"schemaVersion": 1, "source": "https://opendata.ndw.nu/",
               "retentionDays": RETENTION_DAYS,
               "generatedAt": now.isoformat(timespec="seconds").replace("+00:00", "Z"),
               "coverage": {"records": len(readings), "detectors": len({row["id"] for row in readings}),
                            "firstObservedAt": readings[0]["observedAt"] if readings else None,
                            "lastObservedAt": readings[-1]["observedAt"] if readings else None},
               "readings": readings}
    # Keep the previous history intact if serialization/writing fails mid-build.
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=output_path.parent, delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
        temporary.replace(output_path)
    finally:
        if temporary and temporary.exists():
            temporary.unlink()
    print(f"Traffic history: {len(readings)} observations across {len({r['observedAt'] for r in readings})} times")


def main():
    write_history(SNAPSHOT, OUTPUT, datetime.now(timezone.utc))


if __name__ == "__main__":
    main()
