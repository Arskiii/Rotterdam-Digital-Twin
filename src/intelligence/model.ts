import type { LiveSnapshot } from "../data/live";
import type { ExperimentResultMsg } from "../sim/protocol";

export interface FeedQuality { id: string; label: string; observedAt: string | null; count: number; ageMin: number | null; status: "current" | "late" | "stale" | "missing"; source: string; licence: string; caveat: string }
const age = (time: string | null, now: number) => {
  if (!time) return null;
  const t = Date.parse(time);
  return Number.isFinite(t) ? Math.max(0, Math.round((now - t) / 60000)) : null;
};
export function qualityRows(snap: LiveSnapshot | null, now = Date.now()): FeedQuality[] {
  const rows: Omit<FeedQuality, "ageMin" | "status">[] = [
    { id: "traffic", label: "Road sensor flow", observedAt: snap?.traffic?.t ?? null, count: snap?.traffic?.s?.length ?? 0, source: "NDW Open Data", licence: "Publisher terms", caveat: "Sensor coverage is uneven; values do not describe every road." },
    { id: "bridges", label: "Bridge openings", observedAt: snap?.t ?? null, count: snap?.bridges?.length ?? 0, source: "NDW situations", licence: "Publisher terms", caveat: "Zero can mean no reported opening; it is not proof every bridge is closed to ships." },
    { id: "transit", label: "Transit vehicle fixes", observedAt: snap?.vehicles?.t ?? null, count: snap?.vehicles?.v?.length ?? 0, source: "OVapi GTFS-RT", licence: "Publisher terms", caveat: "Positions may lag; route paths between fixes are interpolated." },
    { id: "water", label: "Maas water level", observedAt: snap?.water?.t ?? null, count: snap?.water ? 1 : 0, source: "Rijkswaterstaat Boompjes", licence: "CC0", caveat: "One river gauge is not a neighborhood flood measurement." },
    { id: "weather", label: "Weather and rain", observedAt: snap?.weather?.t ?? null, count: snap?.weather ? 1 : 0, source: "Buienradar", licence: "Publisher terms", caveat: "Station observation, not a KNMI radar forecast." },
    { id: "air", label: "Air measurements", observedAt: snap?.air?.t ?? null, count: snap?.air?.s?.length ?? 0, source: "Luchtmeetnet", licence: "Publisher terms", caveat: "Monitor locations do not represent each street." },
  ];
  return rows.map((row) => {
    const ageMin = age(row.observedAt, now);
    const status = (row.id !== "bridges" && !row.count) || ageMin === null ? "missing" : ageMin > 20 ? "stale" : ageMin > 9 ? "late" : "current";
    return { ...row, ageMin, status };
  });
}

export interface Validation { matched: number; observed: number; simulated: number; mae: number | null; wmapePct: number | null; caveat: string }
export function validateHoldout(result: ExperimentResultMsg): Validation {
  const rows = result.stationFlows.filter((row) => row.observed > 0 && Number.isFinite(row.observed) && Number.isFinite(row.simulated));
  const observed = rows.reduce((sum, row) => sum + row.observed, 0);
  const simulated = rows.reduce((sum, row) => sum + row.simulated, 0);
  return {
    matched: rows.length, observed, simulated,
    mae: rows.length ? Math.round(rows.reduce((sum, row) => sum + Math.abs(row.simulated - row.observed), 0) / rows.length) : null,
    wmapePct: observed ? Math.round(1000 * rows.reduce((sum, row) => sum + Math.abs(row.simulated - row.observed), 0) / observed) / 10 : null,
    caveat: "Held-out NDW station flow comparison; no fit was made on these stations. One short fixed-seed run is evidence of error, not a validated operational forecast.",
  };
}

export function heldoutStations(stations: { edge: number; flow: number }[]): { edge: number; flow: number }[] {
  // Stable, disjoint 20% selection by edge id. No station is used to tune this trial.
  return stations.filter((station) => station.edge >= 0 && station.flow > 0 && ((Math.imul(station.edge, 2654435761) >>> 0) % 5 === 0));
}
