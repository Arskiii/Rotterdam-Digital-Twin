import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HOUR_MS } from './archive.mjs';

const LEGACY = 'https://raw.githubusercontent.com/Arskiii/Rotterdam-Digital-Twin/archive/';
// Same-hour cutovers must retain the records written by the former collector.
export function mergeHours(current, legacy, tier) {
  if (!current) return legacy;
  if (!legacy) return current;
  const head = tier === 'c' ? 13 : 14;
  if (legacy.length < head || legacy.toString('ascii', 0, 4) !== (tier === 'c' ? 'RTAC' : 'RTAF')) return current;
  const countAt = tier === 'c' ? 11 : 12;
  const units = tier === 'c' ? current.readUInt8(10) : current.readUInt16LE(10);
  if (units !== (tier === 'c' ? legacy.readUInt8(10) : legacy.readUInt16LE(10))) return current;
  const size = tier === 'c' ? 13 + units * 4 : 1 + units * 3;
  const rows = new Map();
  for (const data of [legacy, current]) {
    const version = data.readUInt16LE(4);
    if (![1, 2].includes(version) || data.length !== head + data.readUInt16LE(countAt) * size) continue;
    for (let p = head; p < data.length; p += size) {
      const row = Buffer.from(data.subarray(p, p + size));
      if (tier === 'c' && version === 1) for (let d = 0; d < units; d++) row[16 + d * 4] = Math.round(row[16 + d * 4] / 255 * 254);
      rows.set(row[0], row);
    }
  }
  const header = Buffer.from(current.subarray(0, head));
  header.writeUInt16LE(rows.size, countAt);
  return Buffer.concat([header, ...[...rows].sort((a, b) => a[0] - b[0]).map(([, row]) => row)]);
}
export function createHandler({ store, dataDir, fetcher = fetch, now = Date.now }) {
  const cache = new Map(), inflight = new Map();
  const legacy = async path => {
    if (cache.has(path)) return cache.get(path);
    if (inflight.has(path)) return inflight.get(path);
    const pending = (async () => {
      const response = await fetcher(LEGACY + path, { signal: AbortSignal.timeout(6000) });
      if (!response.ok && response.status !== 404) throw new Error('Historical mirror unavailable');
      const bytes = response.ok ? Buffer.from(await response.arrayBuffer()) : null;
      if (bytes?.length > 5_000_000) throw new Error('Historical file too large');
      if (cache.size >= 600) cache.delete(cache.keys().next().value);
      cache.set(path, bytes);
      return bytes;
    })().finally(() => inflight.delete(path));
    inflight.set(path, pending);
    return pending;
  };
  return async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const send = (status, body) => { res.statusCode = status; res.end(req.method === 'HEAD' ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
    if (req.method === 'OPTIONS') return send(204);
    if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('Allow', 'GET, HEAD, OPTIONS'); return send(405, { error: 'Method not allowed' }); }
    const path = new URL(req.url, 'http://localhost').pathname;
    try {
      if (path === '/ready') return send(200, { ready: true });
      if (path === '/health' || path === '/archive/status') {
        const status = store.status(now());
        return send(path === '/health' && !status.healthy ? 503 : 200, status);
      }
      if (path === '/api/live') {
        if (!store.status(now()).healthy) return send(503, { error: 'Collection delayed' });
        res.setHeader('Cache-Control', 'public, max-age=15');
        return send(200, store.latest());
      }
      const file = /^\/data\/(rotterdam-snapshot\.json|traffic-history\.json|cbs-neighborhoods\.json|transit\.json\.gz)$/.exec(path);
      if (file) {
        const body = await readFile(join(dataDir, file[1]));
        if (file[1].endsWith('.gz')) res.setHeader('Content-Type', 'application/gzip');
        return send(200, body);
      }
      const hour = /^\/archive\/(c|f)\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{2})\.bin$/.exec(path);
      if (hour) {
        const [, tier, y, m, d, h] = hour;
        const at = Date.UTC(+y, +m - 1, +d, +h);
        if (new Date(at).toISOString().slice(0, 13) !== `${y}-${m}-${d}T${h}` || at > now()) return send(404, { error: 'Hour unavailable' });
        const current = store.hour(tier, at);
        // GitHub is a read-only historical source, never a scheduling dependency.
        let old = null;
        if (at <= Math.floor(store.get('startedAt') / HOUR_MS) * HOUR_MS) {
          try { old = await legacy(path.slice(9)); }
          catch (error) { if (!current) throw error; }
        }
        const body = mergeHours(current, old, tier);
        if (!body) return send(404, { error: 'Hour was not collected' });
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Cache-Control', `public, max-age=${at + HOUR_MS < now() ? 3600 : 30}`);
        return send(200, body);
      }
      const month = /^\/archive\/e\/(\d{4})-(\d{2})\.json$/.exec(path);
      if (month && +month[2] >= 1 && +month[2] <= 12) {
        const start = Date.UTC(+month[1], +month[2] - 1, 1), end = Date.UTC(+month[1], +month[2], 1);
        const old = start <= store.get('startedAt') ? await legacy(path.slice(9)) : null;
        return send(200, [...(old ? JSON.parse(old) : []), ...store.month(start, end)]);
      }
      return send(404, { error: 'Not found' });
    } catch (error) {
      console.warn('Read endpoint:', error.message);
      return send(error.code === 'ENOENT' ? 503 : 502, { error: 'Data temporarily unavailable' });
    }
  };
}
