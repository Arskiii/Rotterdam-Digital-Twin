// Shared helpers for building-height accuracy: local projection, RD New
// (EPSG:28992) conversion, spatial index, and the height-resolution logic
// used by build-data.mjs (full rebuild) and apply-heights.mjs (in-place patch).

import { readFileSync, existsSync } from "node:fs";

// ---------------- local projection (must match build-data.mjs) ----------------
export const ORIGIN = { lat: 51.92, lon: 4.48 };
export const M_PER_LAT = 110574;
export const M_PER_LON = 111320 * Math.cos((ORIGIN.lat * Math.PI) / 180);
export const px = (lon) => (lon - ORIGIN.lon) * M_PER_LON;
export const py = (lat) => (lat - ORIGIN.lat) * M_PER_LAT;
export const invPx = (x) => x / M_PER_LON + ORIGIN.lon;
export const invPy = (y) => y / M_PER_LAT + ORIGIN.lat;

// Height model bounds. Zalmhaventoren tops out at 215 m — the old 190 m clamp
// flattened it; 260 m leaves headroom without letting bad tags explode.
export const MIN_H = 2.5;
export const MAX_H = 260;
export const clampH = (h) => Math.max(MIN_H, Math.min(MAX_H, h));

// ---------------- RD New (EPSG:28992) <-> WGS84 ----------------
// Standard polynomial approximation (Schreutelkamp & Strang van Hees), good to
// well under a meter inside the Netherlands — plenty for footprint matching.
const RD0 = { x: 155000, y: 463000, lat: 52.15517440, lon: 5.38720621 };

export function rdToWgs(x, y) {
  const dx = (x - RD0.x) * 1e-5;
  const dy = (y - RD0.y) * 1e-5;
  const latT = [
    [0, 1, 3235.65389], [2, 0, -32.58297], [0, 2, -0.24750], [2, 1, -0.84978],
    [0, 3, -0.06550], [2, 2, -0.01709], [1, 0, -0.00738], [4, 0, 0.00530],
    [2, 3, -0.00039], [4, 1, 0.00033], [1, 1, -0.00012],
  ];
  const lonT = [
    [1, 0, 5260.52916], [1, 1, 105.94684], [1, 2, 2.45656], [3, 0, -0.81885],
    [1, 3, 0.05594], [3, 1, -0.05607], [0, 1, 0.01199], [3, 2, -0.00256],
    [1, 4, 0.00128], [0, 2, 0.00022], [2, 0, -0.00022], [5, 0, 0.00026],
  ];
  let dLat = 0;
  for (const [p, q, c] of latT) dLat += c * dx ** p * dy ** q;
  let dLon = 0;
  for (const [p, q, c] of lonT) dLon += c * dx ** p * dy ** q;
  return { lat: RD0.lat + dLat / 3600, lon: RD0.lon + dLon / 3600 };
}

export function wgsToRd(lat, lon) {
  const dLat = 0.36 * (lat - RD0.lat);
  const dLon = 0.36 * (lon - RD0.lon);
  const xT = [
    [0, 1, 190094.945], [1, 1, -11832.228], [2, 1, -114.221], [0, 3, -32.391],
    [1, 0, -0.705], [3, 1, -2.340], [1, 3, -0.608], [0, 2, -0.008], [2, 3, 0.148],
  ];
  const yT = [
    [1, 0, 309056.544], [0, 2, 3638.893], [2, 0, 73.077], [1, 2, -157.984],
    [3, 0, 59.788], [0, 1, 0.433], [2, 2, -6.439], [1, 1, -0.032], [0, 4, 0.092], [1, 4, -0.054],
  ];
  let x = RD0.x;
  for (const [p, q, c] of xT) x += c * dLat ** p * dLon ** q;
  let y = RD0.y;
  for (const [p, q, c] of yT) y += c * dLat ** p * dLon ** q;
  return { x, y };
}

// ---------------- geometry ----------------
export function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function ringAreaXY(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export function centroidOf(pts) {
  let cx = 0, cy = 0;
  for (const [x, y] of pts) { cx += x; cy += y; }
  return [cx / pts.length, cy / pts.length];
}

// ---------------- point grid index ----------------
export class PointGrid {
  constructor(cell = 50) {
    this.cell = cell;
    this.map = new Map();
    this.pts = []; // [x, y, h]
  }
  key(x, y) { return `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`; }
  add(x, y, h) {
    const i = this.pts.length;
    this.pts.push([x, y, h]);
    const k = this.key(x, y);
    let lst = this.map.get(k);
    if (!lst) this.map.set(k, (lst = []));
    lst.push(i);
  }
  /** Indices of points within the cells overlapping [minX..maxX, minY..maxY]. */
  query(minX, minY, maxX, maxY) {
    const out = [];
    const x0 = Math.floor(minX / this.cell), x1 = Math.floor(maxX / this.cell);
    const y0 = Math.floor(minY / this.cell), y1 = Math.floor(maxY / this.cell);
    for (let gx = x0; gx <= x1; gx++)
      for (let gy = y0; gy <= y1; gy++) {
        const lst = this.map.get(`${gx},${gy}`);
        if (lst) out.push(...lst);
      }
    return out;
  }
}

/**
 * Measured-height lookup for a footprint polygon (projected meters).
 * Strategy: collect measured points inside the polygon; a single OSM outline
 * can span several BAG panden (podium + tower), so take a high percentile to
 * keep the visible mass right. With no interior hit, fall back to the nearest
 * point within `near` meters of the centroid.
 */
export function heightForFootprint(grid, pts, cx, cy, near = 8) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const inside = [];
  for (const i of grid.query(minX, minY, maxX, maxY)) {
    const [x, y, h] = grid.pts[i];
    if (x >= minX && x <= maxX && y >= minY && y <= maxY && pointInRing(x, y, pts)) inside.push(h);
  }
  if (inside.length) {
    inside.sort((a, b) => a - b);
    return inside[Math.min(inside.length - 1, Math.floor(inside.length * 0.8))];
  }
  let best = null, bd = near * near;
  for (const i of grid.query(cx - near, cy - near, cx + near, cy + near)) {
    const [x, y, h] = grid.pts[i];
    const d = (x - cx) ** 2 + (y - cy) ** 2;
    if (d < bd) { bd = d; best = h; }
  }
  return best;
}

// ---------------- measured heights file (data/heights-3dbag.json) ----------------
/** Load the fetch-heights.mjs output into a PointGrid, or null when absent. */
export function loadMeasuredGrid(path) {
  if (!existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(data.entries)) throw new Error(`${path}: no entries array`);
  const grid = new PointGrid(40);
  for (const [x, y, h] of data.entries) {
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(h) && h > 0) grid.add(x, y, h);
  }
  return { grid, meta: { source: data.source, fetchedAt: data.fetchedAt, count: grid.pts.length } };
}

// ---------------- published landmark heights ----------------
/** Load scripts/landmark-heights.json → [{name, x, y, h}] in projected meters. */
export function loadLandmarks(path) {
  const list = JSON.parse(readFileSync(path, "utf8"));
  return list.map((l) => ({ name: l.name, h: l.h, x: px(l.lon), y: py(l.lat) }));
}

/**
 * Match each landmark to one footprint and override clearly-wrong heights.
 * items: [{pts, cx, cy, area, h, measured}] (projected meters, h meters).
 *
 * Matching, most reliable signal first — tower footprints are ≥ 250 m², which
 * keeps sheds and street furniture from stealing a match:
 *   1. self-identification: a footprint nearby whose stored height already
 *      agrees (±15 m) with the published height IS the landmark (OSM-tagged);
 *   2. the largest qualifying footprint containing the landmark point;
 *   3. the nearest qualifying footprint within 80 m.
 * Measured (3D BAG) heights are never overridden; others only when off by
 * > 15 m, so correct OSM tags stay untouched.
 */
export function applyLandmarks(items, landmarks, grid /* query() → item indices */) {
  const MIN_AREA = 250;
  const report = [];
  for (const lm of landmarks) {
    const cand = [];
    for (const i of grid.query(lm.x - 90, lm.y - 90, lm.x + 90, lm.y + 90)) {
      const it = items[i];
      const d = Math.hypot(it.cx - lm.x, it.cy - lm.y);
      if (d > 90 || it.area < MIN_AREA) continue;
      cand.push({ i, d, contains: pointInRing(lm.x, lm.y, it.pts) });
    }
    let best = null;
    for (const c of cand) {
      if (Math.abs(items[c.i].h - lm.h) <= 15 && (!best || c.d < best.d)) best = c;
    }
    if (!best) {
      for (const c of cand) {
        if (!c.contains) continue;
        if (!best || items[c.i].area > items[best.i].area) best = c;
      }
    }
    if (!best) {
      for (const c of cand) {
        if (c.d <= 80 && (!best || c.d < best.d)) best = c;
      }
    }
    if (!best) {
      report.push({ name: lm.name, matched: false });
      continue;
    }
    const it = items[best.i];
    // Landmarks correct unmeasured heights off by >15 m. For measured (LiDAR)
    // heights they act as an anchor on the named towers only: percentiles
    // diluted by a podium (Maastoren), setbacks (World Port Center), scans
    // predating completion (Zalmhaventoren) or crane returns read wrong, so
    // published height wins when LiDAR deviates by more than 15%.
    const changed = it.measured
      ? it.h < 0.85 * lm.h || it.h > 1.15 * lm.h
      : Math.abs(it.h - lm.h) > 15;
    report.push({
      name: lm.name, matched: true, dist: best.d, area: Math.round(it.area),
      before: it.h, after: changed ? lm.h : it.h, changed,
    });
    if (changed) { it.h = lm.h; it.landmark = true; }
  }
  return report;
}
