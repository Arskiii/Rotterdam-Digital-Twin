#!/usr/bin/env node
// Convert raw Overpass JSON (data/raw/) into compact binaries in public/data/.
//
//   node scripts/build-data.mjs
//
// Outputs:
//   meta.json      bounds, origin, districts, inventory counts
//   roads.bin      display polylines (all road classes, incl. service/pedestrian)
//   graph.bin      routable graph: nodes, edges w/ geometry, signals, clusters
//   water.bin      triangulated water polygons
//   rail.bin       rail/tram/metro polylines
//   buildings.bin  tiled quantized extrusion footprints (pre-triangulated roofs)

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import earcut from "earcut";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW = join(ROOT, "data", "raw");
const OUT = join(ROOT, "public", "data");
mkdirSync(OUT, { recursive: true });

// ---------------- projection ----------------
const ORIGIN = { lat: 51.92, lon: 4.48 };
const M_PER_LAT = 110574;
const M_PER_LON = 111320 * Math.cos((ORIGIN.lat * Math.PI) / 180);
const px = (lon) => (lon - ORIGIN.lon) * M_PER_LON;
const py = (lat) => (lat - ORIGIN.lat) * M_PER_LAT;

// ---------------- road classes ----------------
const CLASS = {
  motorway: 0, motorway_link: 0,
  trunk: 1, trunk_link: 1,
  primary: 2, primary_link: 2,
  secondary: 3, secondary_link: 3,
  tertiary: 4, tertiary_link: 4,
  residential: 5, unclassified: 5, living_street: 5, busway: 5,
  service: 6,
  pedestrian: 7,
};
const DEFAULT_SPEED = [90, 80, 50, 50, 50, 30, 15, 8];
const SIM_MAX_CLASS = 5; // classes 0..5 form the routable network

const DISTRICTS = [
  { key: "centrum", name: "Centrum", lat: 51.9204, lon: 4.4794 },
  { key: "noord", name: "Noord", lat: 51.9345, lon: 4.4705 },
  { key: "delfshaven", name: "Delfshaven", lat: 51.9092, lon: 4.4363 },
  { key: "overschie", name: "Overschie", lat: 51.9411, lon: 4.4269 },
  { key: "hillegersberg", name: "Hillegersberg-Schiebroek", lat: 51.9565, lon: 4.4779 },
  { key: "kralingen", name: "Kralingen-Crooswijk", lat: 51.9257, lon: 4.5155 },
  { key: "alexander", name: "Prins Alexander", lat: 51.9553, lon: 4.5477 },
  { key: "feijenoord", name: "Feijenoord", lat: 51.8988, lon: 4.5052 },
  { key: "ijsselmonde", name: "IJsselmonde", lat: 51.8853, lon: 4.5433 },
  { key: "charlois", name: "Charlois", lat: 51.8797, lon: 4.4699 },
  { key: "waalhaven", name: "Waalhaven-Eemhaven", lat: 51.8898, lon: 4.4179 },
  { key: "pernis", name: "Pernis", lat: 51.8865, lon: 4.3885 },
  { key: "hoogvliet", name: "Hoogvliet", lat: 51.8632, lon: 4.3623 },
  { key: "schiedam", name: "Schiedam", lat: 51.9186, lon: 4.3991 },
  { key: "capelle", name: "Capelle a/d IJssel", lat: 51.9297, lon: 4.5776 },
].map((d) => ({ ...d, x: px(d.lon), y: py(d.lat) }));

function nearestDistrict(x, y) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < DISTRICTS.length; i++) {
    const dx = DISTRICTS[i].x - x, dy = DISTRICTS[i].y - y;
    const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

// ---------------- binary writer ----------------
class Writer {
  constructor() { this.chunks = []; this.len = 0; this.buf = Buffer.alloc(1 << 20); this.pos = 0; }
  _need(n) {
    if (this.pos + n > this.buf.length) {
      this.chunks.push(this.buf.subarray(0, this.pos));
      this.len += this.pos;
      this.buf = Buffer.alloc(Math.max(1 << 20, n));
      this.pos = 0;
    }
  }
  u8(v) { this._need(1); this.buf.writeUInt8(v & 0xff, this.pos); this.pos += 1; }
  u16(v) { this._need(2); this.buf.writeUInt16LE(v & 0xffff, this.pos); this.pos += 2; }
  i16(v) { this._need(2); this.buf.writeInt16LE(Math.max(-32768, Math.min(32767, v | 0)), this.pos); this.pos += 2; }
  u32(v) { this._need(4); this.buf.writeUInt32LE(v >>> 0, this.pos); this.pos += 4; }
  f32(v) { this._need(4); this.buf.writeFloatLE(v, this.pos); this.pos += 4; }
  done() { this.chunks.push(this.buf.subarray(0, this.pos)); this.len += this.pos; return Buffer.concat(this.chunks, this.len); }
}

const loadJSON = (name) => JSON.parse(readFileSync(join(RAW, name), "utf8"));

// ---------------- helpers ----------------
const keyOf = (lat, lon) => `${Math.round(lat * 1e7)},${Math.round(lon * 1e7)}`;

/** Stitch relation member ways (with .geometry) into closed rings. */
function assembleRings(members) {
  const segs = members
    .filter((m) => m.type === "way" && Array.isArray(m.geometry) && m.geometry.length >= 2)
    .map((m) => m.geometry.map((g) => [g.lat, g.lon]));
  const rings = [];
  const used = new Array(segs.length).fill(false);
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    let ring = segs[i].slice();
    let guard = 0;
    while (guard++ < segs.length + 2) {
      const endK = keyOf(ring[ring.length - 1][0], ring[ring.length - 1][1]);
      const startK = keyOf(ring[0][0], ring[0][1]);
      if (endK === startK && ring.length > 3) break; // closed
      let extended = false;
      for (let j = 0; j < segs.length; j++) {
        if (used[j]) continue;
        const s = segs[j];
        const sStart = keyOf(s[0][0], s[0][1]);
        const sEnd = keyOf(s[s.length - 1][0], s[s.length - 1][1]);
        if (sStart === endK) { ring = ring.concat(s.slice(1)); used[j] = true; extended = true; break; }
        if (sEnd === endK) { ring = ring.concat(s.slice(0, -1).reverse()); used[j] = true; extended = true; break; }
        if (sEnd === startK) { ring = s.slice(0, -1).concat(ring); used[j] = true; extended = true; break; }
        if (sStart === startK) { ring = s.slice(1).reverse().concat(ring); used[j] = true; extended = true; break; }
      }
      if (!extended) break;
    }
    const closed = keyOf(ring[0][0], ring[0][1]) === keyOf(ring[ring.length - 1][0], ring[ring.length - 1][1]);
    if (closed && ring.length > 3) rings.push(ring.slice(0, -1));
  }
  return rings;
}

function ringAreaXY(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Ramer–Douglas–Peucker in XY meters. */
function simplify(pts, eps) {
  if (pts.length <= 4) return pts;
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-12;
    let maxD = -1, maxI = -1;
    for (let i = a + 1; i < b; i++) {
      const [x, y] = pts[i];
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
      const ex = ax + t * dx - x, ey = ay + t * dy - y;
      const d = ex * ex + ey * ey;
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > eps * eps) { keep[maxI] = true; stack.push([a, maxI], [maxI, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

const dist = (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1);

// ============================================================
// 1. ROADS + GRAPH + SIGNALS
// ============================================================
console.log("── roads & graph ──");

const roadWays = new Map();
for (const f of readdirSync(RAW).filter((f) => /^roads-\d+-\d+\.json$/.test(f))) {
  for (const el of loadJSON(f).elements) {
    if (el.type === "way" && el.geometry?.length >= 2 && !roadWays.has(el.id)) roadWays.set(el.id, el);
  }
}
console.log(`road ways: ${roadWays.size}`);

// Signals: OSM node id -> tags
const signalNodes = new Map();
for (const el of loadJSON("signals.json").elements) {
  if (el.type === "node") signalNodes.set(el.id, el);
}
console.log(`signal nodes (raw inventory): ${signalNodes.size}`);

// --- display polylines (all classes) + total km ---
const roadsW = new Writer();
roadsW.u32(0x524d5452); // 'RTMR'
let displayCount = 0;
let totalKm = 0;
const roadsBody = new Writer();
for (const way of roadWays.values()) {
  const cls = CLASS[way.tags?.highway];
  if (cls === undefined) continue;
  if (way.tags?.area === "yes") continue;
  let pts = way.geometry.map((g) => [px(g.lon), py(g.lat)]);
  pts = simplify(pts, 0.4);
  if (pts.length < 2) continue;
  let flags = 0;
  if (way.tags?.bridge && way.tags.bridge !== "no") flags |= 1;
  if (way.tags?.tunnel && way.tags.tunnel !== "no" || way.tags?.covered === "yes") flags |= 2;
  roadsBody.u8(cls);
  roadsBody.u8(flags);
  roadsBody.u16(Math.min(65535, pts.length));
  for (const [x, y] of pts.slice(0, 65535)) { roadsBody.f32(x); roadsBody.f32(y); }
  displayCount++;
  for (let i = 1; i < pts.length; i++) totalKm += dist(...pts[i - 1], ...pts[i]) / 1000;
}
roadsW.u32(displayCount);
const roadsBin = Buffer.concat([roadsW.done(), roadsBody.done()]);
writeFileSync(join(OUT, "roads.bin"), roadsBin);
console.log(`roads.bin: ${displayCount} polylines, ${totalKm.toFixed(0)} km, ${(roadsBin.length / 1e6).toFixed(1)} MB`);

// --- routable graph (classes 0..SIM_MAX_CLASS) ---
const simWays = [...roadWays.values()].filter((w) => {
  const c = CLASS[w.tags?.highway];
  if (c === undefined || c > SIM_MAX_CLASS) return false;
  if (w.tags?.area === "yes") return false;
  const access = w.tags?.access;
  if (access === "no" || access === "private") return false;
  if (w.tags?.motor_vehicle === "no") return false;
  return true;
});

// count node usage to find junctions
const nodeUse = new Map();
for (const w of simWays) {
  const ids = w.nodes;
  for (let i = 0; i < ids.length; i++) {
    nodeUse.set(ids[i], (nodeUse.get(ids[i]) ?? 0) + (i === 0 || i === ids.length - 1 ? 2 : 1));
  }
}

// graph nodes: junctions, endpoints, and any signal node on the network
const nodeIdx = new Map(); // osm id -> graph index
const nodesXY = [];
function ensureNode(osmId, x, y) {
  let idx = nodeIdx.get(osmId);
  if (idx === undefined) {
    idx = nodesXY.length / 2;
    nodeIdx.set(osmId, idx);
    nodesXY.push(x, y);
  }
  return idx;
}

function parseSpeed(tags, cls) {
  const raw = tags?.maxspeed;
  if (raw) {
    const m = String(raw).match(/(\d+)/);
    if (m) return Math.min(130, Math.max(10, parseInt(m[1], 10)));
  }
  return DEFAULT_SPEED[cls];
}

const edges = []; // {a,b,cls,oneway,speed,len,pts:[[x,y]..],district,tunnel,bridge}
for (const w of simWays) {
  const ids = w.nodes;
  const geo = w.geometry;
  if (!ids || ids.length !== geo.length) continue;
  const cls = CLASS[w.tags.highway];
  const rounded = w.tags.junction === "roundabout" || w.tags.junction === "circular";
  let oneway = w.tags.oneway === "yes" || w.tags.oneway === "1" || w.tags.oneway === "true" || rounded;
  const reversed = w.tags.oneway === "-1";
  if (reversed) oneway = true;
  const speed = parseSpeed(w.tags, cls);
  const tunnel = (w.tags.tunnel && w.tags.tunnel !== "no") || w.tags.covered === "yes";
  const bridge = w.tags.bridge && w.tags.bridge !== "no";

  // walk the way, splitting at junctions & signal nodes
  let segIds = [ids[0]];
  let segPts = [[px(geo[0].lon), py(geo[0].lat)]];
  for (let i = 1; i < ids.length; i++) {
    segIds.push(ids[i]);
    segPts.push([px(geo[i].lon), py(geo[i].lat)]);
    const isCut = i === ids.length - 1 || (nodeUse.get(ids[i]) ?? 0) > 1 || signalNodes.has(ids[i]);
    if (isCut) {
      let pts = simplify(segPts, 0.4);
      let len = 0;
      for (let k = 1; k < pts.length; k++) len += dist(...pts[k - 1], ...pts[k]);
      if (len > 0.5) {
        if (reversed) { pts = pts.slice().reverse(); }
        const aId = reversed ? segIds[segIds.length - 1] : segIds[0];
        const bId = reversed ? segIds[0] : segIds[segIds.length - 1];
        const a = ensureNode(aId, pts[0][0], pts[0][1]);
        const b = ensureNode(bId, pts[pts.length - 1][0], pts[pts.length - 1][1]);
        if (a !== b) {
          const mid = pts[Math.floor(pts.length / 2)];
          edges.push({ a, b, cls, oneway, speed, len, pts, district: nearestDistrict(mid[0], mid[1]), tunnel, bridge });
        }
      }
      segIds = [ids[i]];
      segPts = [[px(geo[i].lon), py(geo[i].lat)]];
    }
  }
}
console.log(`graph: ${nodesXY.length / 2} nodes, ${edges.length} edges`);

// --- largest strongly connected component (so every route is reachable) ---
{
  const N = nodesXY.length / 2;
  const outAdj = Array.from({ length: N }, () => []);
  const inAdj = Array.from({ length: N }, () => []);
  edges.forEach((e) => {
    outAdj[e.a].push(e.b);
    inAdj[e.b].push(e.a);
    if (!e.oneway) { outAdj[e.b].push(e.a); inAdj[e.a].push(e.b); }
  });
  // Kosaraju (iterative)
  const order = [];
  const seen = new Uint8Array(N);
  for (let s = 0; s < N; s++) {
    if (seen[s]) continue;
    const stack = [[s, 0]];
    seen[s] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top[1] < outAdj[top[0]].length) {
        const nx = outAdj[top[0]][top[1]++];
        if (!seen[nx]) { seen[nx] = 1; stack.push([nx, 0]); }
      } else { order.push(top[0]); stack.pop(); }
    }
  }
  const comp = new Int32Array(N).fill(-1);
  let nComp = 0;
  for (let i = order.length - 1; i >= 0; i--) {
    const s = order[i];
    if (comp[s] !== -1) continue;
    const stack = [s];
    comp[s] = nComp;
    while (stack.length) {
      const v = stack.pop();
      for (const nx of inAdj[v]) if (comp[nx] === -1) { comp[nx] = nComp; stack.push(nx); }
    }
    nComp++;
  }
  const sizes = new Uint32Array(nComp);
  for (let i = 0; i < N; i++) sizes[comp[i]]++;
  let bigComp = 0;
  for (let c = 1; c < nComp; c++) if (sizes[c] > sizes[bigComp]) bigComp = c;
  var inCore = new Uint8Array(N);
  for (let i = 0; i < N; i++) inCore[i] = comp[i] === bigComp ? 1 : 0;
  console.log(`largest SCC: ${sizes[bigComp]} / ${N} nodes`);
}

// --- signals on network + clustering ---
const netSignals = []; // {nodeIdx, x, y, osmId, crossingOnly}
for (const [osmId, el] of signalNodes) {
  const gi = nodeIdx.get(osmId);
  if (gi === undefined) continue;
  const crossingOnly = el.tags?.highway !== "traffic_signals";
  netSignals.push({ nodeIdx: gi, x: nodesXY[gi * 2], y: nodesXY[gi * 2 + 1], osmId, crossingOnly });
}
console.log(`signals bound to network: ${netSignals.length}`);

// spatial clustering (union-find, 40 m radius)
{
  const R = 40;
  const cell = new Map();
  const ck = (x, y) => `${Math.floor(x / R)},${Math.floor(y / R)}`;
  netSignals.forEach((s, i) => {
    const k = ck(s.x, s.y);
    if (!cell.has(k)) cell.set(k, []);
    cell.get(k).push(i);
  });
  const parent = netSignals.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  netSignals.forEach((s, i) => {
    const cx = Math.floor(s.x / R), cy = Math.floor(s.y / R);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const lst = cell.get(`${cx + dx},${cy + dy}`);
        if (!lst) continue;
        for (const j of lst) if (j > i && dist(s.x, s.y, netSignals[j].x, netSignals[j].y) < R) union(i, j);
      }
  });
  const clusterIdOf = new Map();
  var clusters = [];
  netSignals.forEach((s, i) => {
    const root = find(i);
    let cid = clusterIdOf.get(root);
    if (cid === undefined) { cid = clusters.length; clusterIdOf.set(root, cid); clusters.push({ x: 0, y: 0, n: 0, members: [], crossing: true }); }
    const c = clusters[cid];
    c.x += s.x; c.y += s.y; c.n++;
    c.members.push(i);
    if (!s.crossingOnly) { /* has a real junction signal */ }
    s.cluster = cid;
  });
  clusters.forEach((c) => { c.x /= c.n; c.y /= c.n; });
  // a cluster is a "junction" if a high-incidence graph node (a real fork)
  // lies near its centroid — signal stop-lines themselves sit mid-edge.
  const incidence = new Uint8Array(nodesXY.length / 2);
  edges.forEach((e) => {
    incidence[e.a] = Math.min(250, incidence[e.a] + 1);
    incidence[e.b] = Math.min(250, incidence[e.b] + 1);
  });
  const JR = 55;
  const forkCell = new Map();
  const fk = (x, y) => `${Math.floor(x / JR)},${Math.floor(y / JR)}`;
  for (let i = 0; i < incidence.length; i++) {
    if (incidence[i] < 3) continue;
    const k = fk(nodesXY[i * 2], nodesXY[i * 2 + 1]);
    if (!forkCell.has(k)) forkCell.set(k, []);
    forkCell.get(k).push(i);
  }
  clusters.forEach((c) => {
    const cx = Math.floor(c.x / JR), cy = Math.floor(c.y / JR);
    let junction = false;
    for (let dx = -1; dx <= 1 && !junction; dx++)
      for (let dy = -1; dy <= 1 && !junction; dy++) {
        const lst = forkCell.get(`${cx + dx},${cy + dy}`);
        if (!lst) continue;
        for (const ni of lst)
          if (dist(c.x, c.y, nodesXY[ni * 2], nodesXY[ni * 2 + 1]) < JR) { junction = true; break; }
      }
    c.crossing = !junction;
  });
  console.log(`signal clusters: ${clusters.length} (${clusters.filter((c) => !c.crossing).length} junctions, ${clusters.filter((c) => c.crossing).length} crossings)`);
}

// phase group per signal: bearing of the roadway through the node (mod 180°)
const nodeBearing = new Map(); // graph node idx -> bearing deg [0,180)
edges.forEach((e) => {
  const setB = (ni, x1, y1, x2, y2) => {
    if (nodeBearing.has(ni)) return;
    let deg = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
    deg = ((deg % 180) + 180) % 180;
    nodeBearing.set(ni, deg);
  };
  const p = e.pts;
  setB(e.a, p[0][0], p[0][1], p[1][0], p[1][1]);
  setB(e.b, p[p.length - 2][0], p[p.length - 2][1], p[p.length - 1][0], p[p.length - 1][1]);
});
netSignals.forEach((s) => {
  const c = clusters[s.cluster];
  const bearing = nodeBearing.get(s.nodeIdx) ?? 0;
  if (c.axis === undefined) c.axis = bearing;
  const diff = Math.abs(bearing - c.axis);
  s.phase = diff < 45 || diff > 135 ? 0 : 1;
});

// deterministic per-cluster timing
function hash32(n) {
  n = (n ^ 61) ^ (n >>> 16);
  n = (n + (n << 3)) | 0;
  n = n ^ (n >>> 4);
  n = Math.imul(n, 0x27d4eb2d);
  n = n ^ (n >>> 15);
  return n >>> 0;
}
clusters.forEach((c, i) => {
  const h = hash32(i * 2654435761);
  c.cycle = c.crossing ? 60 : 52 + (h % 5) * 7; // 52..80 s
  c.offset = h % c.cycle;
});

// aux signals: pedestrian/cycle heads not on the drivable graph — rendered
// with the phase of the nearest cluster so junctions light up densely.
const auxSignals = [];
{
  const AR = 60;
  const cell = new Map();
  clusters.forEach((c, i) => {
    const k = `${Math.floor(c.x / AR)},${Math.floor(c.y / AR)}`;
    if (!cell.has(k)) cell.set(k, []);
    cell.get(k).push(i);
  });
  for (const [osmId, el] of signalNodes) {
    if (nodeIdx.has(osmId)) continue;
    const x = px(el.lon), y = py(el.lat);
    const cx = Math.floor(x / AR), cy = Math.floor(y / AR);
    let best = -1, bd = AR * AR;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const lst = cell.get(`${cx + dx},${cy + dy}`);
        if (!lst) continue;
        for (const ci of lst) {
          const d = (clusters[ci].x - x) ** 2 + (clusters[ci].y - y) ** 2;
          if (d < bd) { bd = d; best = ci; }
        }
      }
    auxSignals.push({ x, y, cluster: best });
  }
  console.log(`aux signals (off-network heads): ${auxSignals.length}`);
}

// --- write graph.bin ---
{
  const w = new Writer();
  w.u32(0x474d5452); // 'RTMG'
  w.u32(2); // version
  const N = nodesXY.length / 2;
  w.u32(N);
  for (let i = 0; i < N; i++) { w.f32(nodesXY[i * 2]); w.f32(nodesXY[i * 2 + 1]); w.u8(inCore[i]); }
  w.u32(netSignals.length);
  netSignals.forEach((s) => {
    w.u32(s.nodeIdx);
    w.u16(s.cluster);
    w.u8(s.phase);
    w.u8(s.crossingOnly ? 1 : 0);
  });
  w.u32(auxSignals.length);
  auxSignals.forEach((s) => {
    w.f32(s.x); w.f32(s.y);
    w.i16(s.cluster);
    w.u8(hash32(Math.round(s.x * 7 + s.y * 13) >>> 0) % 2); // phase group guess
    w.u8(0);
  });
  w.u32(clusters.length);
  clusters.forEach((c) => {
    w.f32(c.x); w.f32(c.y);
    w.u8(c.crossing ? 1 : 0);
    w.u8(c.cycle);
    w.u16(c.offset);
  });
  w.u32(edges.length);
  const geo = new Writer();
  let geoCount = 0;
  edges.forEach((e) => {
    w.u32(e.a);
    w.u32(e.b);
    w.u8(e.cls);
    w.u8((e.oneway ? 1 : 0) | (e.tunnel ? 2 : 0) | (e.bridge ? 4 : 0));
    w.u16(Math.round(e.speed));
    w.f32(e.len);
    w.u32(geoCount);
    w.u16(e.pts.length);
    w.u8(e.district);
    w.u8(0);
    e.pts.forEach(([x, y]) => { geo.f32(x); geo.f32(y); });
    geoCount += e.pts.length;
  });
  w.u32(geoCount);
  const bin = Buffer.concat([w.done(), geo.done()]);
  writeFileSync(join(OUT, "graph.bin"), bin);
  console.log(`graph.bin: ${(bin.length / 1e6).toFixed(1)} MB`);
}

// ============================================================
// 2. WATER
// ============================================================
console.log("── water ──");
{
  const polys = []; // {outer:[[x,y]..], holes:[[[x,y]..]..]}
  const usedWayIds = new Set();
  const rels = loadJSON("water-rels.json").elements.filter((e) => e.type === "relation");
  for (const rel of rels) {
    for (const m of rel.members ?? []) if (m.type === "way" && m.ref) usedWayIds.add(m.ref);
    const outers = assembleRings((rel.members ?? []).filter((m) => m.role === "outer" || m.role === ""));
    const inners = assembleRings((rel.members ?? []).filter((m) => m.role === "inner"));
    for (const o of outers) {
      const outer = simplify(o.map(([lat, lon]) => [px(lon), py(lat)]), 1.2);
      if (outer.length < 3 || Math.abs(ringAreaXY(outer)) < 400) continue;
      const myHoles = [];
      for (const h of inners) {
        const hole = simplify(h.map(([lat, lon]) => [px(lon), py(lat)]), 1.2);
        if (hole.length >= 3 && pointInRing(hole[0][0], hole[0][1], outer)) myHoles.push(hole);
      }
      polys.push({ outer, holes: myHoles });
    }
  }
  const ways = loadJSON("water-ways.json").elements.filter((e) => e.type === "way");
  for (const way of ways) {
    if (usedWayIds.has(way.id) || !way.geometry || way.geometry.length < 4) continue;
    const first = way.geometry[0], last = way.geometry[way.geometry.length - 1];
    if (keyOf(first.lat, first.lon) !== keyOf(last.lat, last.lon)) continue;
    const outer = simplify(way.geometry.slice(0, -1).map((g) => [px(g.lon), py(g.lat)]), 1.0);
    if (outer.length < 3 || Math.abs(ringAreaXY(outer)) < 150) continue;
    polys.push({ outer, holes: [] });
  }

  const w = new Writer();
  w.u32(0x574d5452); // 'RTMW'
  const verts = [];
  const tris = [];
  for (const p of polys) {
    const flat = [];
    const holeIdx = [];
    for (const [x, y] of p.outer) flat.push(x, y);
    for (const h of p.holes) { holeIdx.push(flat.length / 2); for (const [x, y] of h) flat.push(x, y); }
    const idx = earcut(flat, holeIdx.length ? holeIdx : null, 2);
    const base = verts.length / 2;
    for (let i = 0; i < flat.length; i++) verts.push(flat[i]);
    for (const t of idx) tris.push(base + t);
  }
  w.u32(verts.length / 2);
  for (const v of verts) w.f32(v);
  w.u32(tris.length / 3);
  for (const t of tris) w.u32(t);
  const bin = w.done();
  writeFileSync(join(OUT, "water.bin"), bin);
  console.log(`water.bin: ${polys.length} polys, ${(verts.length / 2 / 1000).toFixed(0)}k verts, ${(bin.length / 1e6).toFixed(1)} MB`);
  var waterPolyCount = polys.length;
}

// ============================================================
// 3. RAIL
// ============================================================
console.log("── rail ──");
{
  const RAILKIND = { rail: 0, tram: 1, subway: 2, light_rail: 2 };
  const w = new Writer();
  w.u32(0x4c4d5452); // 'RTML'
  const body = new Writer();
  let count = 0;
  for (const el of loadJSON("rail.json").elements) {
    if (el.type !== "way" || !el.geometry) continue;
    const kind = RAILKIND[el.tags?.railway];
    if (kind === undefined) continue;
    if (el.tags?.tunnel && el.tags.tunnel !== "no") continue; // underground: invisible
    if (el.tags?.service) continue; // yards/sidings clutter
    const pts = simplify(el.geometry.map((g) => [px(g.lon), py(g.lat)]), 0.6);
    if (pts.length < 2) continue;
    body.u8(kind);
    body.u8(0);
    body.u16(Math.min(65535, pts.length));
    for (const [x, y] of pts.slice(0, 65535)) { body.f32(x); body.f32(y); }
    count++;
  }
  w.u32(count);
  const bin = Buffer.concat([w.done(), body.done()]);
  writeFileSync(join(OUT, "rail.bin"), bin);
  console.log(`rail.bin: ${count} ways, ${(bin.length / 1e6).toFixed(1)} MB`);
  var railCount = count;
}

// ============================================================
// 4. BUILDINGS (tiled, quantized, pre-triangulated roofs)
// ============================================================
console.log("── buildings ──");
let buildingCount = 0;
{
  const tileFiles = readdirSync(RAW).filter((f) => /^buildings-\d+-\d+\.json$/.test(f));
  if (tileFiles.length < 36) {
    console.warn(`only ${tileFiles.length}/36 building tiles present — rerun once fetch completes`);
  }
  const seen = new Set();
  const items = []; // {pts:[[x,y]...], h}

  function heightOf(tags, id) {
    const parse = (v) => { const m = String(v).match(/([\d.]+)/); return m ? parseFloat(m[1]) : NaN; };
    let h = NaN;
    if (tags?.height) h = parse(tags.height);
    if (Number.isNaN(h) && tags?.["building:levels"]) {
      const lv = parse(tags["building:levels"]);
      if (!Number.isNaN(lv)) h = lv * 3.1 + 1.5;
    }
    if (Number.isNaN(h)) h = 5 + (hash32(id >>> 0) % 60) / 10; // 5..11 m deterministic
    return Math.max(2.5, Math.min(190, h));
  }

  function addFootprint(ringLatLon, tags, id) {
    let pts = ringLatLon.map(([lat, lon]) => [px(lon), py(lat)]);
    pts = simplify(pts, 0.55);
    if (pts.length < 3) return;
    const area = Math.abs(ringAreaXY(pts));
    if (area < 22) return;
    if (ringAreaXY(pts) < 0) pts.reverse(); // CCW
    if (pts.length > 200) pts = simplify(pts, 2.0).slice(0, 200);
    items.push({ pts, h: heightOf(tags, id) });
  }

  // multipolygon relations first (outer rings only), remember member ways
  if (existsSync(join(RAW, "buildings-rels.json"))) {
    for (const rel of loadJSON("buildings-rels.json").elements) {
      if (rel.type !== "relation") continue;
      for (const m of rel.members ?? []) if (m.type === "way" && m.ref) seen.add(m.ref);
      const outers = assembleRings((rel.members ?? []).filter((m) => m.role === "outer" || m.role === ""));
      for (const o of outers) addFootprint(o, rel.tags, rel.id);
    }
  }
  for (const f of tileFiles) {
    for (const el of loadJSON(f).elements) {
      if (el.type !== "way" || seen.has(el.id) || !el.geometry || el.geometry.length < 4) continue;
      seen.add(el.id);
      const first = el.geometry[0], last = el.geometry[el.geometry.length - 1];
      if (keyOf(first.lat, first.lon) !== keyOf(last.lat, last.lon)) continue;
      addFootprint(el.geometry.slice(0, -1).map((g) => [g.lat, g.lon]), el.tags, el.id);
    }
  }
  buildingCount = items.length;

  // tile grid (1 km) for culling + i16 quantization (0.1 m)
  const TILE = 1000;
  const tiles = new Map();
  for (const it of items) {
    let cx = 0, cy = 0;
    for (const [x, y] of it.pts) { cx += x; cy += y; }
    cx /= it.pts.length; cy /= it.pts.length;
    const tx = Math.floor(cx / TILE), ty = Math.floor(cy / TILE);
    const k = `${tx},${ty}`;
    if (!tiles.has(k)) tiles.set(k, { tx, ty, items: [] });
    tiles.get(k).items.push(it);
  }

  const w = new Writer();
  w.u32(0x424d5452); // 'RTMB'
  w.u32(tiles.size);
  for (const { tx, ty, items: list } of tiles.values()) {
    const ox = tx * TILE, oy = ty * TILE;
    w.f32(ox); w.f32(oy);
    w.u32(list.length);
    for (const it of list) {
      const flat = [];
      for (const [x, y] of it.pts) flat.push(x - ox, y - oy);
      const idx = earcut(flat, null, 2);
      w.u16(Math.round(it.h * 10));
      w.u8(it.pts.length);
      w.u8(idx.length / 3);
      for (let i = 0; i < flat.length; i++) w.i16(Math.round(flat[i] * 10));
      for (const t of idx) w.u8(t);
    }
  }
  const bin = w.done();
  writeFileSync(join(OUT, "buildings.bin"), bin);
  console.log(`buildings.bin: ${buildingCount} buildings, ${tiles.size} tiles, ${(bin.length / 1e6).toFixed(1)} MB`);
}

// ============================================================
// 5. META
// ============================================================
{
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  for (let i = 0; i < nodesXY.length; i += 2) {
    minX = Math.min(minX, nodesXY[i]); maxX = Math.max(maxX, nodesXY[i]);
    minY = Math.min(minY, nodesXY[i + 1]); maxY = Math.max(maxY, nodesXY[i + 1]);
  }
  const meta = {
    version: 2,
    origin: ORIGIN,
    extent: { minX, minY, maxX, maxY },
    counts: {
      roadWays: displayCount,
      roadKm: Math.round(totalKm),
      graphNodes: nodesXY.length / 2,
      graphEdges: edges.length,
      signalsInventory: signalNodes.size,
      signalsOnNetwork: netSignals.length,
      signalClusters: clusters.length,
      junctions: clusters.filter((c) => !c.crossing).length,
      crossings: clusters.filter((c) => c.crossing).length,
      waterPolys: waterPolyCount,
      railWays: railCount,
      buildings: buildingCount,
    },
    districts: DISTRICTS.map((d) => ({ key: d.key, name: d.name, x: +d.x.toFixed(1), y: +d.y.toFixed(1) })),
  };
  writeFileSync(join(OUT, "meta.json"), JSON.stringify(meta, null, 1));
  console.log("meta.json written:", JSON.stringify(meta.counts));
}
