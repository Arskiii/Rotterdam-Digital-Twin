/** Display/expiry windows in minutes, matched to each provider's cadence. */
export const FEED_WINDOWS = {
  traffic: [9, 20], vehicles: [9, 20], departures: [9, 20], situations: [9, 20],
  water: [20, 60], weather: [30, 60], air: [120, 240],
} as const;
export type FeedKind = keyof typeof FEED_WINDOWS;
export function observationAge(time: string | undefined | null, now = Date.now()): number | null {
  const age = now - Date.parse(time ?? "");
  return Number.isFinite(age) && age >= -60_000 ? Math.max(0, age / 60_000) : null;
}
export function observationFresh(kind: FeedKind, time: string | undefined | null, now = Date.now()): boolean {
  const age = observationAge(time, now);
  return age !== null && age <= FEED_WINDOWS[kind][1];
}
