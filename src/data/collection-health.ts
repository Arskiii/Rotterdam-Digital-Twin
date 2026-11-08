import collection from '../../collection.config.json';

export interface CollectionHealth {
  v: number;
  healthy: boolean;
  startedAt: number;
  lastSuccessAt: number | null;
  coverage: { from: number; to: number; expected: number; recorded: number; missing: number };
  maintenance: Record<string, { lastSuccessAt?: number; error?: string; running?: boolean }>;
}
export function collectionSummary(status: CollectionHealth, now = Date.now()) {
  const age = status.lastSuccessAt === null ? Infinity : now - status.lastSuccessAt;
  const healthy = status.healthy && age >= -60_000 && age < 300_000;
  const c = status.coverage;
  const delayed = Object.entries(status.maintenance ?? {}).filter(([, job]) => !!job.error).map(([key]) => key === 'publicData' ? 'corridor refresh' : key === 'transit' ? 'timetable refresh' : 'CBS refresh');
  return { healthy, text: `${healthy ? 'Collecting' : 'Collection delayed'} · ${c.recorded}/${c.expected} completed archive slots since ${new Date(c.from).toLocaleString('en-GB', { timeZone: 'Europe/Amsterdam', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} · ${c.missing} missing${delayed.length ? ` · Delayed: ${delayed.join(', ')}` : ''}` };
}
export async function loadCollectionHealth(): Promise<CollectionHealth> {
  const response = await fetch(`${collection.origin}/archive/status`, { cache: 'no-store', signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error('Collection health unavailable');
  const value = await response.json() as CollectionHealth;
  if (value.v !== 1 || !value.coverage || !Number.isFinite(value.coverage.expected) || !Number.isFinite(value.coverage.recorded)) throw new Error('Invalid collection status');
  return value;
}
