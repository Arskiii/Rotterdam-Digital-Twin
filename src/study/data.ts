import studyNetworkUrl from "../../.generated/study-network.json?url";
import { siteUrl } from "../ui/siteUrl";
import { unpackNetwork } from "../lab/networkSnapshot";
import { safeReading } from "../lab/imports";
import { applyOverrides, loadOverrides } from "../v03/overrides";
import { selectedCorridor } from "../v03/corridors";
import { matchCorridor, type TrafficReading } from "../v03/scenario";
import type { Network } from "../sim/types";

export type Origin = { lat: number; lon: number };
export interface StudyData { network: Network; origin: Origin; readings: TrafficReading[] }
let pending: Promise<StudyData> | null = null;
export function loadStudy(): Promise<StudyData> {
  pending ??= Promise.all([
    fetch(studyNetworkUrl, { signal: AbortSignal.timeout(15_000) }).then(async (response) => {
      if (!response.ok) throw new Error(`Study map: HTTP ${response.status}`);
      const study = await response.json();
      if (study.version !== 1 || !Number.isFinite(study.origin?.lat) || !Number.isFinite(study.origin?.lon)) throw new Error("Invalid study network");
      const network = unpackNetwork(study.network);
      applyOverrides(network, loadOverrides());
      return { network, origin: study.origin as Origin };
    }),
    fetch(siteUrl("data/traffic-history.json"), { signal: AbortSignal.timeout(10_000) })
      .then(async (r) => r.ok ? await r.json() : null).catch(() => null),
  ]).then(([study, history]) => ({ ...study,
    readings: Array.isArray(history?.readings) ? history.readings.slice(0, 3000).map(safeReading).filter((r: TrafficReading | null): r is TrafficReading => r !== null) : [],
  })).catch((error) => { pending = null; throw error; });
  return pending;
}

/** The city and corridor models use different latitude scales and origins. */
export function cityPoint(point: { x: number; y: number }, study: Origin, city: Origin) {
  const lon = study.lon + point.x / (111320 * Math.cos(study.lat * Math.PI / 180));
  const lat = study.lat - point.y / 111320;
  return { x: (lon - city.lon) * 111320 * Math.cos(city.lat * Math.PI / 180), z: -(lat - city.lat) * 110574 };
}

/** Deduplicate opposite directions, keeping the original Lab edge identity. */
export function studySections(study: StudyData) {
  const measured = new Set<string>();
  const seenSensors = new Set<string>();
  for (const row of study.readings) {
    const key = `${row.id}|${row.lat}|${row.lon}`;
    if (seenSensors.has(key)) continue;
    seenSensors.add(key);
    for (const id of matchCorridor(study.network, row, study.origin)?.edgeIds ?? []) measured.add(id);
  }
  const seen = new Set<string>();
  return [...study.network.edges.values()].filter((edge) => {
    const match = selectedCorridor(study.network, edge.id);
    if (!match || match.edgeIds.some((id) => seen.has(id))) return false;
    match.edgeIds.forEach((id) => seen.add(id)); return true;
  }).map((edge) => ({ edge, measured: measured.has(edge.id) }))
    .sort((a, b) => Number(b.measured) - Number(a.measured) || (a.edge.name ?? "").localeCompare(b.edge.name ?? "") || a.edge.id.localeCompare(b.edge.id));
}

export function nearestSection(point: { x: number; z: number }, sections: Array<{ id: string; a: { x: number; z: number }; b: { x: number; z: number } }>, radius = 35): string | null {
  let best: string | null = null, distance = radius * radius;
  for (const { id, a, b } of sections) {
    const dx = b.x - a.x, dz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
    const d = (point.x - a.x - t * dx) ** 2 + (point.z - a.z - t * dz) ** 2;
    if (d < distance) { distance = d; best = id; }
  }
  return best;
}
