import { DatabaseSync } from 'node:sqlite';
import { gzipSync, gunzipSync } from 'node:zlib';
import { SLOT_MS, HOUR_MS, fresh, mergeSnapshot, summarize, encodeHour } from './archive.mjs';

export class ArchiveStore {
  constructor(path, stations, now = Date.now()) {
    this.stations = stations;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS slots (slot INTEGER PRIMARY KEY, coarse TEXT NOT NULL, fine BLOB);
      CREATE INDEX IF NOT EXISTS retained_fine ON slots(slot) WHERE fine IS NOT NULL;
      CREATE TABLE IF NOT EXISTS snapshots (slot INTEGER PRIMARY KEY, body BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS events (key TEXT NOT NULL, t INTEGER NOT NULL, seen INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(key,t));
      CREATE INDEX IF NOT EXISTS events_time ON events(t);`);
    if (!this.get('startedAt')) this.set('startedAt', now);
    // Fine station indexes must remain tied to the published station catalog.
    const catalog = JSON.stringify(stations.map(s => s.id ?? [s.x, s.y]));
    if (this.get('stations') && this.get('stations') !== catalog) throw new Error('Archive station catalog changed; migrate indexes before collecting');
    this.set('stations', catalog);
  }
  get(key) { const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; }
  set(key, value) { this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key, JSON.stringify(value)); }
  attempt(now) { this.set('lastAttemptAt', now); }
  fail(error, now) { this.set('lastError', { at: now, message: String(error.message ?? error).slice(0, 240) }); }
  save(incoming, now = Date.now()) {
    const t = Date.parse(incoming.t);
    if (!Number.isFinite(t) || t > now + 60_000 || t < now - SLOT_MS) throw new Error('Snapshot envelope is not current');
    if (!['traffic', 'vehicles'].some(k => fresh(incoming, k, now))) throw new Error('No current traffic or transit observations');
    const slot = Math.floor(t / SLOT_MS) * SLOT_MS;
    const last = this.get('lastStoredAt');
    if (last && t <= last) return false;
    const existing = this.db.prepare('SELECT body FROM snapshots WHERE slot=?').get(slot);
    const previous = existing ? JSON.parse(gunzipSync(existing.body)) : null;
    const snap = mergeSnapshot(previous, incoming, now);
    const { coarse, fine } = summarize(snap, this.stations);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT OR REPLACE INTO slots VALUES (?,?,?)').run(slot, JSON.stringify(coarse), fine);
      this.db.prepare('INSERT OR REPLACE INTO snapshots VALUES (?,?)').run(slot, gzipSync(JSON.stringify(snap)));
      if (fresh(incoming, 'situations', now)) this.events(incoming, t);
      this.db.prepare('DELETE FROM snapshots WHERE slot < ?').run(now - 2 * 86400_000);
      this.db.prepare('UPDATE slots SET fine=NULL WHERE slot < ? AND fine IS NOT NULL').run(now - 45 * 86400_000);
      this.set('lastStoredAt', t); this.set('lastSuccessAt', now); this.set('lastError', null);
      this.db.exec('COMMIT');
      return true;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  events(snap, t) {
    const rows = [
      ...(snap.incidents ?? []).map(e => ({ ...e, type: ['accident','obstruction','jam','closure','roadworks'][e.kind] ?? String(e.kind) })),
      ...(snap.bridges ?? []).map(e => ({ ...e, type: 'bridge-open' })),
    ];
    for (const e of rows) {
      const key = `${e.type}:${Math.round(e.x)}:${Math.round(e.y)}`;
      const old = this.db.prepare('SELECT t,seen FROM events WHERE key=? ORDER BY t DESC LIMIT 1').get(key);
      const start = old && t - old.seen <= 2 * HOUR_MS ? old.t : t;
      const body = { k: key, t: new Date(start).toISOString(), seen: new Date(t).toISOString(), type: e.type, name: e.name ?? '', x: e.x, y: e.y, until: e.until ?? null };
      this.db.prepare('INSERT OR REPLACE INTO events VALUES (?,?,?,?)').run(key, start, t, JSON.stringify(body));
    }
  }
  latest() {
    const row = this.db.prepare('SELECT body FROM snapshots ORDER BY slot DESC LIMIT 1').get();
    return row ? JSON.parse(gunzipSync(row.body)) : null;
  }
  hour(tier, hour) {
    return encodeHour(this.db.prepare('SELECT * FROM slots WHERE slot>=? AND slot<? ORDER BY slot').all(hour, hour + HOUR_MS), hour, tier, this.stations.length);
  }
  month(start, end) { return this.db.prepare('SELECT body FROM events WHERE t>=? AND t<? ORDER BY t').all(start, end).map(row => JSON.parse(row.body)); }
  status(now = Date.now()) {
    // Count completed slots only. The current slot still has time to arrive.
    const end = Math.floor(now / SLOT_MS) * SLOT_MS;
    const start = Math.max(Math.floor(this.get('startedAt') / SLOT_MS) * SLOT_MS, end - 24 * HOUR_MS);
    const expected = Math.max(0, (end - start) / SLOT_MS);
    const recorded = this.db.prepare('SELECT COUNT(*) AS n FROM slots WHERE slot>=? AND slot<?').get(start, end).n;
    const lastSuccessAt = this.get('lastSuccessAt');
    return { v: 1, healthy: !!lastSuccessAt && now - lastSuccessAt < 5 * 60_000, startedAt: this.get('startedAt'),
      lastAttemptAt: this.get('lastAttemptAt'), lastSuccessAt, lastStoredAt: this.get('lastStoredAt'), lastError: this.get('lastError'),
      cadenceSeconds: 120, archiveResolutionSeconds: 300,
      coverage: { from: start, to: end, expected, recorded, missing: expected - recorded },
      maintenance: this.get('maintenance') ?? {} };
  }
  close() { this.db.close(); }
}
