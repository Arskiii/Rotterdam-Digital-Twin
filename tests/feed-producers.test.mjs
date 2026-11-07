import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTraffic, parseVehiclePositions, parseTripDelays, realtimeTime, cachedSource, parseWater, fetchAir } from '../scripts/fetch-live.mjs';

const now = Date.parse('2026-11-07T16:00:00Z'), sec = now / 1000;
const iso = (minutes) => new Date(now - minutes * 60000).toISOString();
const site = (id, time, flow) => `<siteMeasurements><measurementSiteReference id="${id}"/><measurementTimeDefault>${time}</measurementTimeDefault><vehicleFlowRate>${flow}</vehicleFlowRate><speed>30</speed></siteMeasurements>`;
test('air readings use source time and do not turn null or expired measurements into zero', async (t) => {
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [
    { formula: 'NO2', value: null, timestamp_measured: iso(0) },
    { formula: 'NO2', value: 20, timestamp_measured: iso(60) },
    { formula: 'PM25', value: 8, timestamp_measured: iso(300) },
  ] }));
  const air = await fetchAir();
  assert.equal(air.t, iso(60)); assert.ok(air.s.length > 0);
  assert.ok(air.s.every((row) => row[2] === 20 && row[3] === null));
});
test('river readings exclude forecasts, unsupported units, stale and future timestamps', () => {
  const series = (type, value, time, unit = 'cm') => ({ AquoMetadata: { ProcesType: type, Eenheid: { Code: unit }, Hoedanigheid: { Code: 'NAP' } }, MetingenLijst: [{ Tijdstip: time, Meetwaarde: { Waarde_Numeriek: value } }] });
  const data = { WaarnemingenLijst: [series('verwachting', 99, iso(0)), series('meting', 10, iso(10)), series('meting', 20, iso(0)), series('meting', 5, iso(-10)), series('meting', 80, iso(120)), series('meting', 4, iso(0), 'm')] };
  assert.deepEqual(parseWater(data, now), { station: 'Boerengat', cm: 20, trend: 0, t: iso(0) });
  assert.throws(() => parseWater({ WaarnemingenLijst: [series('verwachting', 99, iso(0))] }, now), /empty series/);
});
test('NDW uses actual measurement time, rejects old/future sites and preserves measured zero flow', () => {
  const stations = ['fresh', 'old', 'future', 'missing'].map(id => ({ ids: [id] }));
  const xml = `<publicationTime>${iso(0)}</publicationTime>` + site('fresh', iso(2), 0) + site('old', iso(10), 100) + site('future', iso(-10), 200) + site('missing', '', 300);
  const result = parseTraffic(xml, stations, now);
  assert.equal(result.t, iso(2)); assert.deepEqual(result.s, [[0, 0, 30]]);
  assert.throws(() => parseTraffic(site('fresh', iso(0), 1), stations, now), /timestamp/);
  assert.throws(() => parseTraffic(xml.replace(iso(0), iso(-10)), stations, now), /timestamp/);
});

const vint = (n) => { let v = BigInt(n); const bytes = []; while (v >= 128n) { bytes.push(Number(v & 127n) | 128); v >>= 7n; } return Buffer.from([...bytes, Number(v)]); };
const field = (id, value, wire = 2) => {
  const b = wire === 0 ? vint(value) : typeof value === 'string' ? Buffer.from(value) : value;
  return Buffer.concat([vint(id * 8 + wire), ...(wire === 2 ? [vint(b.length)] : []), b]);
};
const float = (value) => { const b = Buffer.alloc(4); b.writeFloatLE(value); return b; };
const message = (...parts) => Buffer.concat(parts);
const header = (time = sec) => field(1, message(field(1, '2.0'), field(3, time, 0)));
const trip = (id) => field(1, message(field(1, id), field(5, 'route')));
const vehicle = (id, at) => field(2, field(4, message(trip(id), field(2, message(field(1, float(51.92), 5), field(2, float(4.48), 5))), field(5, at, 0))));

test('GTFS headers and individual positions cannot freshen stale, unknown or future fixes', () => {
  const positions = message(header(), vehicle('fresh', sec - 120), vehicle('old', sec - 500), vehicle('unknown', 0), vehicle('future', sec + 120));
  const result = parseVehiclePositions(positions, { route: ['RET', '4', 0] }, now);
  assert.equal(result.v.length, 1); assert.equal(result.v[0][4], 'fresh');
  assert.equal(result.observedAt, iso(2)); assert.equal(result.t, iso(0)); assert.equal(result.v[0][8], 120);
  assert.throws(() => realtimeTime(header(sec - 600), now), /stale/);
  assert.throws(() => realtimeTime(header(sec + 120), now), /timestamp/);
  assert.throws(() => realtimeTime(Buffer.alloc(0), now), /missing/);
});

test('trip delay measurements expire independently of a fresh GTFS publication', () => {
  const update = (id, at) => field(2, field(3, message(trip(id), field(4, at, 0), field(2, field(3, field(1, 120, 0))))));
  const delays = parseTripDelays(message(header(), update('fresh', sec - 30), update('old', sec - 600), update('future', sec + 120)), now);
  assert.deepEqual([...delays.keys()], ['fresh']); assert.deepEqual(delays.get('fresh'), { delay: 120, live: true, cancelled: false });
});

test('hourly-provider caching coalesces calls, preserves source timestamps and retries failures', async () => {
  let clock = now, calls = 0, fail = false;
  const load = cachedSource(async () => { calls++; if (fail) throw new Error('offline'); return { t: iso(60) }; }, 300000, () => clock);
  const [a, b] = await Promise.all([load(), load()]); assert.equal(a, b); assert.equal(calls, 1);
  clock += 299999; assert.equal(await load(), a); assert.equal(calls, 1);
  clock += 2; fail = true; await assert.rejects(load(), /offline/);
  fail = false; assert.equal((await load()).t, iso(60)); assert.equal(calls, 3);
});
