import type { Network, NetworkEdge } from "../sim/types";
import { matchCorridor, type CorridorMatch, type TrafficReading } from "./scenario";

export const MAX_OBSERVATION_GAP_MS = 90 * 60_000;
export function historyGapLabel(samples: Array<{ observedAt: string }>): string {
  let largest = 0;
  for (let i = 1; i < samples.length; i++) largest = Math.max(largest, Date.parse(samples[i].observedAt) - Date.parse(samples[i - 1].observedAt));
  return largest > MAX_OBSERVATION_GAP_MS ? `Largest observation gap: ${(largest / 3_600_000).toFixed(1)} hours. Missing periods have no measurements.` : "";
}

export function selectedCorridor(net: Network, edgeId: string): CorridorMatch | null {
  const edge = net.edges.get(edgeId);
  if (!edge || net.nodes.get(edge.from)?.kind !== "intersection" || net.nodes.get(edge.to)?.kind !== "intersection" || edge.length < 3) return null;
  const reverse = `${edge.to}->${edge.from}`;
  return { edgeIds: net.edges.has(reverse) ? [edge.id, reverse] : [edge.id], distanceM: 0 };
}

export function corridorLabel(edge: NetworkEdge): string {
  return `${edge.name || "Unnamed road"} · ${Math.round(edge.length)} m · ${edge.from}–${edge.to}`;
}

/** Associate only the nearest mapped segment, not every street within 40 metres. */
export function corridorReadings(net: Network, rows: TrafficReading[], origin: { lat: number; lon: number }, selected: CorridorMatch): TrafficReading[] {
  const matches = new Map<string, boolean>();
  return rows.filter((row) => {
    const key = `${row.id}|${row.lat}|${row.lon}`;
    if (!matches.has(key)) {
      const match = matchCorridor(net, row, origin);
      matches.set(key, !!match?.edgeIds.some((id) => selected.edgeIds.includes(id)));
    }
    return matches.get(key)!;
  });
}

export function freshness(observedAt: string, now = Date.now()): string {
  const time = Date.parse(observedAt);
  if (!Number.isFinite(time) || time > now + 120_000) return "Invalid observation time";
  const minutes = Math.max(0, Math.floor((now - time) / 60_000));
  return `${minutes < 90 ? "Recent" : "Historical"} · ${new Date(time).toLocaleString()}`;
}
