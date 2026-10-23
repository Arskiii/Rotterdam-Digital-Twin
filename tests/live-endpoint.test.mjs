import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { collectLiveSnapshot } from '../scripts/fetch-live.mjs';
import { createLiveHandler } from '../server/live-endpoint.mjs';
import { createTransitCatalog } from '../server/transit-catalog.mjs';

const quiet = { log() {}, warn() {} };
const at = Date.parse('2026-10-23T18:00:00Z');
const fresh = () => ({ v: 3, t: new Date(at).toISOString(), vehicles: { t: new Date(at).toISOString(), v: [] } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const response = () => ({ headers: {}, statusCode: 0, setHeader(k, v) { this.headers[k] = v; }, end(body) { this.body = body; } });
const call = async (handler, method = 'GET') => { const res = response(); await handler({ method }, res); return res; };
const catalog = async () => ({});

test('collector starts independent sources together and rebases paths after vehicle identity arrives', async () => {
  const started = [], gate = deferred();
  const read = (key, value) => async () => { started.push(key); await gate.promise; return value; };
  const snapshot = collectLiveSnapshot({ log: quiet, sources: {
    vehicles: read('vehicles', { t: new Date(at).toISOString(), v: [[1, 2, 0, '4', 'trip', 1, 0, 'a', 0]] }),
    traffic: read('traffic', { t: new Date(at).toISOString(), todMin: 1200, s: [] }),
    situations: read('situations', { bridges: [], incidents: [] }),
    weather: read('weather', { rain: 0 }), water: read('water', { cm: 5 }), air: read('air', { s: [] }),
    departures: async (running) => {
      started.push('departures'); assert.deepEqual([...running], ['trip']);
      return { t: new Date(at + 2000).toISOString(), planT: at / 1000 + 2, plans: { trip: [[1, 2, -10], [20, 30, 60]] }, stops: {}, dep: {} };
    },
  } });
  assert.deepEqual(started.sort(), ['air', 'situations', 'traffic', 'vehicles', 'water', 'weather']);
  gate.resolve();
  const result = await snapshot;
  assert.deepEqual(result.vehicles.plan.trip, [[1, 2, -8], [20, 30, 62]]);
  assert.equal(result.vehicles.t, new Date(at).toISOString());
  assert.equal(result.departures.plans, undefined);
});

test('failed providers are omitted; a total outage never gets a fresh envelope', async () => {
  const fail = async () => { throw new Error('offline'); };
  const sources = Object.fromEntries(['vehicles', 'departures', 'traffic', 'situations', 'water', 'weather', 'air'].map(k => [k, fail]));
  await assert.rejects(collectLiveSnapshot({ sources, log: quiet }), /every live feed failed/);
  sources.traffic = async () => ({ t: new Date(at).toISOString(), s: [] });
  const partial = await collectLiveSnapshot({ sources, log: quiet });
  assert.deepEqual(Object.keys(partial).sort(), ['t', 'traffic', 'v']);
});

test('endpoint coalesces concurrent requests, caches briefly, then collects again', async () => {
  let clock = at, calls = 0; const gate = deferred();
  const handler = createLiveHandler({ catalog, now: () => clock, collect: async ({ signal }) => {
    calls++; assert.ok(signal instanceof AbortSignal); await gate.promise; return fresh();
  } });
  const first = call(handler), second = call(handler); gate.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1); assert.equal(a.statusCode, 200); assert.equal(a.body, b.body);
  assert.equal(a.headers['Access-Control-Allow-Origin'], '*');
  assert.match(a.headers['Vercel-CDN-Cache-Control'], /s-maxage=30/);
  await call(handler); assert.equal(calls, 1);
  clock += 30_001; await call(handler); assert.equal(calls, 2);
  const head = await call(handler, 'HEAD'); assert.equal(head.statusCode, 200); assert.equal(head.body, undefined);
});

test('endpoint rejects mutations and does not cache upstream failures or old observations', async () => {
  let calls = 0;
  const handler = createLiveHandler({ catalog, now: () => at, collect: async () => { calls++; return { ...fresh(), vehicles: { t: '2020-01-01T00:00:00Z', v: [] } }; } });
  assert.equal((await call(handler, 'POST')).statusCode, 405);
  assert.equal((await call(handler, 'OPTIONS')).statusCode, 204);
  assert.equal(calls, 0);
  const unavailable = await call(handler); assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.headers['Cache-Control'], 'no-store');
  assert.equal(unavailable.headers['Vercel-CDN-Cache-Control'], undefined);
  await call(handler); assert.equal(calls, 1, 'a short cooldown prevents retry storms');
});

function timetableFixture() {
  const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
  const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const str = s => Buffer.concat([u16(s.length), Buffer.from(s)]);
  const list = values => Buffer.concat([u32(values.length), ...values.map(str)]);
  return Buffer.concat([Buffer.from('RTTT'), u16(1), list(['4']), list(['stop']), list(['Center']),
    u32(1), u32(1), u32(20261023), u32(1), str('trip'), u16(0), Buffer.from([0]), u16(0), u16(0), u16(1), u16(0), u16(36000)]);
}

test('published transit bundle is atomic, parsed once, and refreshes independently of deployments', async () => {
  const bytes = gzipSync(JSON.stringify({ v: 1, routes: { route: ['RET', '4', 0] }, stops: { stop: { n: 'Center', x: 1, y: 2 } }, timetable: timetableFixture().toString('base64') }));
  let calls = 0, clock = at;
  const load = createTransitCatalog({ now: () => clock, fetcher: async () => { calls++; return new Response(bytes); } });
  const [a, b] = await Promise.all([load(), load()]);
  assert.equal(a, b); assert.equal(calls, 1); assert.equal(a.timetable.trips[0].id, 'trip');
  assert.equal(a.routes.route[1], '4');
  clock += 15 * 60_000 - 1; await load(); assert.equal(calls, 1);
  clock += 2; await load(); assert.equal(calls, 2);
});

test('a malformed transit catalog fails closed and may be retried', async () => {
  let calls = 0;
  const load = createTransitCatalog({ fetcher: async () => { calls++; return new Response(gzipSync('{}')); } });
  await assert.rejects(load(), /Invalid transit catalog/);
  await assert.rejects(load(), /Invalid transit catalog/); assert.equal(calls, 2);
});
