import collection from '../collection.config.json' with { type: 'json' };
import { collectLiveSnapshot } from '../scripts/fetch-live.mjs';

/** Reuse durable collection; retain on-demand providers during a collector outage. */
export function archiveLiveSource({ fetcher = fetch, fallback = collectLiveSnapshot, now = Date.now } = {}) {
  return async options => {
    try {
      const response = await fetcher(`${collection.origin}/api/live`, {
        signal: AbortSignal.any([options.signal, AbortSignal.timeout(1800)]),
      });
      if (!response.ok) throw new Error('Collector unavailable');
      const body = await response.text();
      if (body.length > 2_000_000) throw new Error('Snapshot too large');
      const snap = JSON.parse(body);
      const age = now() - Date.parse(snap.t);
      const current = [snap.traffic, snap.vehicles].some(s => {
        const sourceAge = now() - Date.parse(s?.observedAt ?? s?.t);
        return sourceAge >= -60_000 && sourceAge < 300_000;
      });
      if (snap.v !== 3 || !(age >= -60_000 && age < 300_000) || !current) throw new Error('Collector observations expired');
      return snap;
    } catch { return fallback(options); }
  };
}
