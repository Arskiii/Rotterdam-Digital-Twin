// Version 2 keeps the compact hourly format, reserving sentinels for missing
// measurements. A failed feed must never become a measured zero.
import { DISTRICTS } from '../scripts/lib/city.mjs';

export const SLOT_MS = 300_000;
export const HOUR_MS = 3_600_000;
const WINDOWS = { traffic: 5, vehicles: 5, situations: 20, weather: 60, water: 60, air: 240, departures: 20 };
export function sourceTime(snap, key) {
  return Date.parse(key === 'situations' ? snap.situationsAt : snap[key]?.observedAt ?? snap[key]?.t);
}
export function fresh(snap, key, now) {
  const age = now - sourceTime(snap, key);
  return Number.isFinite(age) && age >= -60_000 && age <= WINDOWS[key] * 60_000;
}
export function mergeSnapshot(previous, incoming, now) {
  const result = { v: 3, t: incoming.t };
  for (const key of Object.keys(WINDOWS)) {
    const candidates = [previous, incoming].filter(s => s && fresh(s, key, now));
    candidates.sort((a, b) => sourceTime(b, key) - sourceTime(a, key));
    const chosen = candidates[0];
    if (!chosen) continue;
    if (key === 'situations') {
      result.situationsAt = chosen.situationsAt;
      result.incidents = chosen.incidents ?? [];
      result.bridges = chosen.bridges ?? [];
    } else result[key] = chosen[key];
  }
  return result;
}
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
export function summarize(snap, stations) {
  const districts = DISTRICTS.map(() => ({ flows: [], speeds: [], ratios: [] }));
  const fine = Buffer.alloc(stations.length * 3, 255);
  for (const [i, flow, speed] of snap.traffic?.s ?? []) {
    const st = stations[i];
    if (!st) continue;
    let closest = 0, distance = Infinity;
    DISTRICTS.forEach((d, j) => {
      const next = (d.x - st.x) ** 2 + (d.y - st.y) ** 2;
      if (next < distance) { closest = j; distance = next; }
    });
    const d = districts[closest];
    if (Number.isFinite(flow) && flow >= 0) {
      d.flows.push(flow);
      fine.writeUInt16LE(Math.min(65534, Math.round(flow)), i * 3);
    }
    // NDW uses zero speed when there is no speed measurement.
    if (Number.isFinite(speed) && speed > 0) {
      d.speeds.push(speed);
      d.ratios.push(Math.min(1, speed / (st.speed > 5 ? st.speed : 50)));
      fine.writeUInt8(Math.min(254, Math.round(speed)), i * 3 + 2);
    }
  }
  const air = index => mean((snap.air?.s ?? []).map(s => s[index]).filter(Number.isFinite));
  const coarse = {
    temp: snap.weather?.temp ?? null, rain: snap.weather?.rain ?? null,
    waterCm: snap.water?.cm ?? null,
    incidents: snap.situationsAt ? snap.incidents.length : null,
    bridges: snap.situationsAt ? snap.bridges.length : null,
    transit: snap.vehicles?.v?.length ?? null, no2: air(2), pm25: air(3),
    districts: districts.map(d => ({
      flow: d.flows.length ? d.flows.reduce((a, b) => a + b, 0) : null,
      speed: mean(d.speeds), congestion: d.ratios.length ? 1 - mean(d.ratios) : null,
    })),
    sourceTimes: Object.fromEntries(Object.keys(WINDOWS).filter(k => Number.isFinite(sourceTime(snap, k))).map(k => [k, sourceTime(snap, k)])),
  };
  return { coarse, fine: snap.traffic?.s?.length ? fine : null };
}
export function encodeHour(rows, hour, tier, stationCount) {
  const coarse = tier === 'c';
  const available = coarse ? rows : rows.filter(row => row.fine);
  if (!available.length) return null;
  const size = coarse ? 13 + DISTRICTS.length * 4 : 1 + stationCount * 3;
  const head = coarse ? 13 : 14;
  const out = Buffer.alloc(head + available.length * size);
  out.write(coarse ? 'RTAC' : 'RTAF'); out.writeUInt16LE(2, 4); out.writeUInt32LE(hour / 1000, 6);
  if (coarse) { out.writeUInt8(DISTRICTS.length, 10); out.writeUInt16LE(available.length, 11); }
  else { out.writeUInt16LE(stationCount, 10); out.writeUInt16LE(available.length, 12); }
  available.forEach((row, index) => {
    let p = head + index * size;
    out.writeUInt8((row.slot - hour) / 60_000, p++);
    if (!coarse) { Buffer.from(row.fine).copy(out, p); return; }
    const c = JSON.parse(row.coarse);
    const write = (value, bytes, scale = 1, signed = false) => {
      const missing = signed ? -32768 : bytes === 2 ? 65535 : 255;
      const n = Number.isFinite(value) ? Math.max(signed ? -32767 : 0, Math.min(signed ? 32767 : missing - 1, Math.round(value * scale))) : missing;
      if (signed) out.writeInt16LE(n, p);
      else if (bytes === 2) out.writeUInt16LE(n, p);
      else out.writeUInt8(n, p);
      p += bytes;
    };
    write(c.temp, 2, 10, true); write(c.rain, 2, 100); write(c.waterCm, 2, 1, true);
    write(c.incidents, 1); write(c.bridges, 1); write(c.transit, 2); write(c.no2, 1); write(c.pm25, 1);
    for (const d of c.districts) { write(d.flow, 2); write(d.speed, 1); write(d.congestion, 1, 254); }
  });
  return out;
}
