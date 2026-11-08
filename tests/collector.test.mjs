import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArchiveStore } from '../collector/store.mjs';
import { startLoop } from '../collector/loop.mjs';
import { createHandler, mergeHours } from '../collector/http.mjs';
import { mergeSnapshot, summarize } from '../collector/archive.mjs';
import { archiveLiveSource } from '../server/archive-live-source.mjs';
import { DISTRICTS } from '../scripts/lib/city.mjs';

const at = Date.parse('2026-11-07T18:00:00Z');
const iso = t => new Date(t).toISOString();
const stations = [{ id: 'station', x: DISTRICTS[0].x, y: DISTRICTS[0].y, speed: 50 }];
const snapshot = (t = at) => ({ v: 3, t: iso(t), traffic: { t: iso(t), s: [[0, 100, 25]] } });
function database(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rotterdam-collector-'));
  let store = new ArchiveStore(join(dir, 'archive.sqlite'), stations, at);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { get store() { return store; }, dir, reopen() { store.close(); store = new ArchiveStore(join(dir, 'archive.sqlite'), stations, at + 600_000); return store; } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const call = async (handler, url, method = 'GET') => {
  const response = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(body) { this.body = body; } };
  await handler({ method, url }, response); return response;
};

test('archive survives restart and counts real completed slots, including gaps', t => {
  const db = database(t);
  db.store.save(snapshot(), at);
  db.store.save(snapshot(at + 600_000), at + 600_000);
  const reopened = db.reopen();
  assert.equal(reopened.latest().t, iso(at + 600_000));
  assert.equal(reopened.hour('c', at).readUInt16LE(11), 2);
  assert.deepEqual(reopened.status(at + 900_000).coverage, { from: at, to: at + 900_000, expected: 3, recorded: 2, missing: 1 });
});
test('duplicate polling is idempotent, while newer observations improve the same slot', t => {
  const { store } = database(t);
  assert.equal(store.save(snapshot(), at), true);
  assert.equal(store.save(snapshot(), at), false);
  assert.equal(store.save(snapshot(at + 120_000), at + 120_000), true);
  assert.equal(store.hour('c', at).readUInt16LE(11), 1);
  assert.equal(store.latest().t, iso(at + 120_000));
});
test('an interrupted transaction rolls back records and success heartbeat together', t => {
  const { store } = database(t);
  store.save(snapshot(), at);
  store.db.exec("CREATE TRIGGER broken_disk BEFORE INSERT ON snapshots BEGIN SELECT RAISE(FAIL, 'disk full'); END;");
  assert.throws(() => store.save(snapshot(at + 300_000), at + 300_000), /disk full/);
  assert.equal(store.get('lastSuccessAt'), at);
  assert.equal(store.hour('c', at).readUInt16LE(11), 1);
  assert.equal(store.latest().t, iso(at));
});
test('new envelopes do not archive stale traffic, old snapshots or future timestamps', t => {
  const { store } = database(t);
  for (const bad of [{ ...snapshot(), traffic: { t: iso(at - 600_000), s: [] } }, snapshot(at - 600_000), snapshot(at + 120_000), { v: 3, t: 'invalid' }]) {
    assert.throws(() => store.save(bad, at));
  }
  assert.equal(store.latest(), null);
  assert.equal(store.status(at).healthy, false);
});
test('partial refresh keeps fresher sections within the slot but drops expired measurements', () => {
  const previous = { ...snapshot(), weather: { t: iso(at), temp: 0, rain: 0 }, water: { t: iso(at - 7200_000), cm: 10 } };
  const merged = mergeSnapshot(previous, { ...snapshot(at + 120_000), weather: { t: iso(at - 600_000), temp: 20 } }, at + 120_000);
  assert.equal(merged.weather.temp, 0);
  assert.equal(merged.water, undefined);
  assert.equal(merged.traffic.t, iso(at + 120_000));
});
test('wire v2 distinguishes observed zero from missing feeds and stations', t => {
  const { store } = database(t);
  store.save({ ...snapshot(), weather: { t: iso(at), temp: 0, rain: 0 } }, at);
  const coarse = store.hour('c', at);
  assert.equal(coarse.readUInt16LE(4), 2);
  assert.equal(coarse.readInt16LE(14), 0);
  assert.equal(coarse.readInt16LE(18), -32768);
  assert.equal(coarse.readUInt8(20), 255);
  const { coarse: summary, fine } = summarize({ ...snapshot(), traffic: { s: [[0, 0, 0]] } }, [...stations, { id: 'missing' }]);
  assert.equal(summary.districts[0].flow, 0); assert.equal(summary.districts[0].speed, null);
  assert.equal(fine.readUInt16LE(0), 0); assert.equal(fine.readUInt16LE(3), 65535);
});
test('retention bounds raw and fine storage without deleting coarse history', t => {
  const { store } = database(t);
  store.save(snapshot(), at);
  const later = at + 46 * 86400_000;
  store.save(snapshot(later), later);
  assert.equal(store.hour('f', at), null);
  assert.ok(store.hour('c', at));
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM snapshots').get().n, 1);
});
test('events retain first sighting and revised end times without duplicate occurrences', t => {
  const { store } = database(t);
  const event = { x: 10, y: 20, kind: 0, name: 'Incident', until: iso(at + 300_000) };
  store.save({ ...snapshot(), situationsAt: iso(at), incidents: [event] }, at);
  store.save({ ...snapshot(at + 120_000), situationsAt: iso(at + 120_000), incidents: [{ ...event, until: iso(at + 600_000) }] }, at + 120_000);
  const rows = store.month(at, at + 3600_000);
  assert.equal(rows.length, 1); assert.equal(rows[0].t, iso(at)); assert.equal(rows[0].until, iso(at + 600_000));
});
test('loop never overlaps work, retries failures promptly, and stops cleanly', async () => {
  let release, count = 0, clock = 0; const scheduled = [];
  const stop = startLoop(async () => { count++; if (count === 1) await new Promise(r => { release = r; }); else throw new Error('offline'); }, {
    now: () => clock, schedule: (fn, delay) => { scheduled.push({ fn, delay }); return 1; }, cancel: () => {}, onError: () => {},
  });
  await tick(); assert.equal(count, 1); assert.equal(scheduled.length, 0);
  clock = 25_000; release(); await tick(); assert.equal(scheduled[0].delay, 95_000);
  scheduled[0].fn(); await tick(); assert.equal(scheduled[1].delay, 30_000);
  await stop(); assert.equal(count, 2);
});
test('public API is read-only, reports a delayed collector, and does not invent missing hours', async t => {
  const { store, dir } = database(t); let requests = 0;
  const handler = createHandler({ store, dataDir: dir, now: () => at + 600_000, fetcher: async () => { requests++; return new Response(null, { status: 404 }); } });
  assert.equal((await call(handler, '/health')).statusCode, 503);
  assert.equal((await call(handler, '/api/live')).statusCode, 503);
  assert.equal((await call(handler, '/ready')).statusCode, 200);
  assert.equal((await call(handler, '/archive/status', 'POST')).statusCode, 405);
  assert.equal((await call(handler, '/archive/c/2026/11/07/18.bin')).statusCode, 404);
  assert.equal((await call(handler, '/archive/c/2026/11/31/18.bin')).statusCode, 404);
  assert.equal((await call(handler, '/data/../../archive.sqlite')).statusCode, 404);
  assert.equal(requests, 1);
});
test('historical fallback preserves old hours and merges both sides of the cutover hour', async t => {
  const { store, dir } = database(t);
  store.save(snapshot(), at);
  const old = Buffer.from(store.hour('c', at)); old.writeUInt16LE(1, 4);
  store.save(snapshot(at + 300_000), at + 300_000);
  const merged = mergeHours(store.hour('c', at), old, 'c');
  assert.equal(merged.readUInt16LE(11), 2);
  const handler = createHandler({ store, dataDir: dir, now: () => at + 300_000, fetcher: async () => new Response(old) });
  const res = await call(handler, '/archive/c/2026/11/07/17.bin');
  assert.equal(res.statusCode, 200); assert.deepEqual(res.body, old);
});
test('a historical mirror outage cannot hide newly stored observations', async t => {
  const { store, dir } = database(t); store.save(snapshot(), at);
  const handler = createHandler({ store, dataDir: dir, now: () => at, fetcher: async () => { throw new Error('offline'); } });
  const res = await call(handler, '/archive/c/2026/11/07/18.bin');
  assert.equal(res.statusCode, 200); assert.equal(res.body.readUInt16LE(11), 1);
  assert.equal((await call(handler, '/archive/c/2026/11/07/17.bin')).statusCode, 502);
});
test('on-demand live collection reuses current persisted data, then falls back on expiry or outage', async () => {
  let calls = 0;
  const fallback = async () => { calls++; return snapshot(); };
  const options = { signal: AbortSignal.timeout(10_000) };
  const current = archiveLiveSource({ now: () => at, fallback, fetcher: async () => new Response(JSON.stringify(snapshot())) });
  assert.equal((await current(options)).t, iso(at)); assert.equal(calls, 0);
  const stale = archiveLiveSource({ now: () => at, fallback, fetcher: async () => new Response(JSON.stringify(snapshot(at - 600_000))) });
  await stale(options); assert.equal(calls, 1);
  const offline = archiveLiveSource({ fallback, fetcher: async () => { throw new Error('offline'); } });
  await offline(options); assert.equal(calls, 2);
});

test('timetable validation checks the staged file instead of a usable packaged calendar', t => {
  const { dir } = database(t);
  writeFileSync(join(dir, 'ret-timetable.bin'), 'broken');
  const result = spawnSync(process.execPath, ['scripts/check-timetable.mjs', '--days', '14'], { env: { ...process.env, TRANSIT_DATA_DIR: dir }, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not parse/);
});
