#!/usr/bin/env node
// True roof geometry for the street view: download 3D BAG CityJSON tiles
// (LoD2.2, the LiDAR-reconstructed roof planes) and pack the RoofSurface
// geometry of every slanted-roof building into per-kilometer tiles that the
// renderer streams in around the camera.
//
//   node scripts/fetch-lod2.mjs          (npm run fetch-roofs)
//
// Output:
//   public/data/roofs/{tx}_{ty}.bin   ring-encoded roof surfaces, dm-quantized
//                                     against the same 1 km tile grid as
//                                     buildings.bin, each shell tagged with the
//                                     ordinal of the prism it replaces
//   public/data/roofs/index.json      available tiles + shell counts
//
// Only RoofSurface polygons are stored (simplified at 0.3 m tolerance); the
// renderer triangulates them and drops vertical skirt walls to the ground, so
// walls cost nothing — they are vertical in LoD2.2 anyway. Flat-roofed
// buildings keep their prisms, which are already the true shape.
//
// Downloads ~600 MB of CityJSON (cached in data/raw3dbag/lod2/, resumable);
// needs network access to data.3dbag.nl. Behind an HTTPS proxy run with
// NODE_USE_ENV_PROXY=1 (the npm script sets it).

import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync, rmSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { px, py, rdToWgs, wgsToRd, pointInRing, PointGrid } from "./lib-heights.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW = join(ROOT, "data", "raw3dbag", "lod2");
const OUT = join(ROOT, "public", "data", "roofs");
mkdirSync(RAW, { recursive: true });
mkdirSync(OUT, { recursive: true });

const BBOX = { s: 51.84, w: 4.34, n: 52.0, e: 4.62 }; // keep in sync with fetch-osm.mjs
const TILE = 1000; // meters, must match build-data.mjs
const SIMPLIFY_TOL = 0.3; // m, collinear-vertex removal within roof rings
const MIN_FACE_AREA = 1.2; // m², culls micro roof fragments
const RIDGE_GUARD = 25; // m, |shell top − stored prism height| beyond this = broken reconstruction

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = { "User-Agent": "rotterdam-intelligence-platform/1.0 (research; contact via github)" };

// ---------------- 1. discover CityJSON tiles over the bbox ----------------
async function discoverTiles() {
  const file = join(RAW, "..", "lod2-tiles.json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const sw = wgsToRd(BBOX.s, BBOX.w);
  const ne = wgsToRd(BBOX.n, BBOX.e);
  const bb = [Math.min(sw.x, ne.x), Math.min(sw.y, ne.y), Math.max(sw.x, ne.x), Math.max(sw.y, ne.y)];
  const tiles = [];
  for (let start = 0; ; start += 100) {
    const params = new URLSearchParams({
      service: "WFS", version: "2.0.0", request: "GetFeature", typeNames: "BAG3D:tiles",
      outputFormat: "application/json", srsName: "EPSG:28992",
      count: "100", startIndex: String(start),
      sortBy: "tile_id", // the tiles layer has no primary key; paging needs an explicit sort
      bbox: `${bb[0]},${bb[1]},${bb[2]},${bb[3]},EPSG:28992`,
    });
    const res = await fetch(`https://data.3dbag.nl/api/BAG3D/wfs?${params}`, { headers: UA, signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`tiles discovery HTTP ${res.status}`);
    const j = await res.json();
    for (const f of j.features ?? []) {
      const p = f.properties ?? {};
      if (p.tile_id && p.cj_download) tiles.push({ id: p.tile_id, url: p.cj_download, buildings: p.cj_nr_building ?? 0 });
    }
    if ((j.features?.length ?? 0) < 100) break;
  }
  writeFileSync(file, JSON.stringify(tiles));
  return tiles;
}

// ---------------- 2. download (cached, resumable) ----------------
async function download(tile) {
  const file = join(RAW, tile.id.replace(/\//g, "-") + ".city.json.gz");
  if (existsSync(file) && statSync(file).size > 500) return file;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(tile.url, { headers: UA, signal: AbortSignal.timeout(300_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      gunzipSync(buf); // integrity check before caching
      writeFileSync(file, buf);
      await sleep(250);
      return file;
    } catch (err) {
      console.warn(`  ! ${tile.id} attempt ${attempt + 1}: ${err.message ?? err}`);
      await sleep(2000 * (attempt + 1));
    }
  }
  throw new Error(`${tile.id}: download failed`);
}

// ---------------- geometry helpers ----------------
/** Remove ring vertices closer than tol to the chord of their neighbours (3D). */
function simplifyRing(pts, tol) {
  let out = pts;
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    const next = [];
    for (let i = 0; i < out.length; i++) {
      const a = out[(i - 1 + out.length) % out.length];
      const b = out[i];
      const c = out[(i + 1) % out.length];
      const ab = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const ap = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const len2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 || 1e-9;
      const t = Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / len2));
      const d = Math.hypot(ap[0] - t * ab[0], ap[1] - t * ab[1], ap[2] - t * ab[2]);
      if (d < tol && out.length - 1 >= 3 && !changed) { changed = true; continue; }
      next.push(b);
    }
    out = next;
  }
  return out;
}

function faceArea3(rings) {
  const r = rings[0];
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i], q = r[(i + 1) % r.length];
    nx += (p[1] - q[1]) * (p[2] + q[2]);
    ny += (p[2] - q[2]) * (p[0] + q[0]);
    nz += (p[0] - q[0]) * (p[1] + q[1]);
  }
  return Math.hypot(nx, ny, nz) / 2;
}

// ---------------- 3. load prisms (buildings.bin) for matching ----------------
function loadPrisms() {
  const buf = readFileSync(join(ROOT, "public", "data", "buildings.bin"));
  let pos = 0;
  const u8 = () => buf.readUInt8(pos++);
  const u16 = () => { const v = buf.readUInt16LE(pos); pos += 2; return v; };
  const u32 = () => { const v = buf.readUInt32LE(pos); pos += 4; return v; };
  const f32 = () => { const v = buf.readFloatLE(pos); pos += 4; return v; };
  const i16 = () => { const v = buf.readInt16LE(pos); pos += 2; return v; };
  if (u32() !== 0x424d5452) throw new Error("bad buildings.bin magic");
  const tileCount = u32();
  const prisms = [];
  const grid = new PointGrid(60);
  for (let t = 0; t < tileCount; t++) {
    const ox = f32(), oy = f32();
    const count = u32();
    const tx = Math.round(ox / TILE), ty = Math.round(oy / TILE);
    for (let i = 0; i < count; i++) {
      const h = u16() / 10;
      const nv = u8(), nt = u8();
      const pts = [];
      let cx = 0, cy = 0;
      for (let k = 0; k < nv; k++) {
        const x = ox + i16() / 10, y = oy + i16() / 10;
        cx += x; cy += y;
        pts.push([x, y]);
      }
      pos += nt * 3;
      const idx = prisms.length;
      prisms.push({ tx, ty, ordinal: i, h, pts, cx: cx / nv, cy: cy / nv });
      grid.add(cx / nv, cy / nv, idx);
    }
  }
  return { prisms, grid };
}

function matchPrism(prisms, grid, x, y) {
  let contain = null, nearest = null, nd = 36; // 6 m²
  for (const gi of grid.query(x - 40, y - 40, x + 40, y + 40)) {
    const p = prisms[grid.pts[gi][2]];
    const d = (p.cx - x) ** 2 + (p.cy - y) ** 2;
    if (d < 1600 && pointInRing(x, y, p.pts)) {
      if (!contain || d < contain.d) contain = { p, d };
    }
    if (d < nd) { nd = d; nearest = p; }
  }
  return contain?.p ?? nearest;
}

// ---------------- 4. extract shells from one CityJSON tile ----------------
function extractShells(json, prisms, grid, shellsByTile, stats) {
  const { scale, translate } = json.transform;
  const V = json.vertices;
  const toLocal = (vi) => {
    const rx = V[vi][0] * scale[0] + translate[0];
    const ry = V[vi][1] * scale[1] + translate[1];
    const z = V[vi][2] * scale[2] + translate[2];
    const w = rdToWgs(rx, ry);
    return [px(w.lon), py(w.lat), z];
  };
  const attrsOf = {};
  for (const [id, co] of Object.entries(json.CityObjects)) {
    if (co.type === "Building") attrsOf[id] = co.attributes ?? {};
  }
  for (const co of Object.values(json.CityObjects)) {
    if (co.type !== "BuildingPart") continue;
    const a = attrsOf[co.parents?.[0]];
    if (!a) continue;
    if (a.b3_dak_type !== "slanted" || a.b3_pw_onvoldoende) { stats.flat++; continue; }
    const g = (co.geometry ?? []).find((g) => g.lod === "2.2");
    if (!g) continue;
    const shell = g.type === "Solid" ? g.boundaries[0] : g.boundaries;
    const vals = g.type === "Solid" ? g.semantics?.values?.[0] : g.semantics?.values;
    if (!shell || !vals) continue;
    const ground = Number.isFinite(a.b3_h_maaiveld) ? a.b3_h_maaiveld : null;

    let faces = [];
    let minZ = Infinity;
    shell.forEach((face, fi) => {
      if (g.semantics.surfaces[vals[fi]]?.type !== "RoofSurface") return;
      let rings = face.map((ring) => simplifyRing(ring.map(toLocal), SIMPLIFY_TOL)).filter((r) => r.length >= 3);
      if (!rings.length || faceArea3(rings) < MIN_FACE_AREA) return;
      for (const r of rings) for (const p of r) if (p[2] < minZ) minZ = p[2];
      faces.push(rings);
    });
    if (!faces.length) { stats.noRoof++; continue; }
    const base = ground ?? minZ;

    // unique dm-quantized vertices, z above ground
    const vidx = new Map();
    const verts = [];
    let maxZ = 0;
    const faceIdx = faces.map((rings) =>
      rings.map((ring) =>
        ring.map(([x, y, z]) => {
          const zz = Math.max(0, z - base);
          if (zz > maxZ) maxZ = zz;
          const key = `${Math.round(x * 10)},${Math.round(y * 10)},${Math.round(zz * 10)}`;
          let i = vidx.get(key);
          if (i === undefined) {
            i = verts.length;
            vidx.set(key, i);
            verts.push([Math.round(x * 10), Math.round(y * 10), Math.round(zz * 10)]);
          }
          return i;
        })
      )
    );
    if (verts.length > 255 || faceIdx.length > 255) { stats.tooBig++; continue; }

    // centroid → prism this shell replaces
    let cx = 0, cy = 0;
    for (const v of verts) { cx += v[0] / 10; cy += v[1] / 10; }
    cx /= verts.length; cy /= verts.length;
    const prism = matchPrism(prisms, grid, cx, cy);
    if (!prism) { stats.noPrism++; continue; }
    if (Math.abs(maxZ - prism.h) > RIDGE_GUARD) { stats.ridgeGuard++; continue; }

    const key = `${prism.tx}_${prism.ty}`;
    let lst = shellsByTile.get(key);
    if (!lst) shellsByTile.set(key, (lst = []));
    lst.push({ ordinal: prism.ordinal, ox: prism.tx * TILE, oy: prism.ty * TILE, verts, faceIdx });
    stats.shells++;
  }
}

// ---------------- 5. main ----------------
async function main() {
  let tiles = await discoverTiles();
  console.log(`3D BAG CityJSON tiles over bbox: ${tiles.length} (${tiles.reduce((a, t) => a + t.buildings, 0)} buildings)`);
  const limit = parseInt(process.env.LOD2_LIMIT ?? "0", 10);
  if (limit > 0) {
    tiles = tiles.slice(0, limit);
    console.log(`LOD2_LIMIT=${limit}: processing first ${tiles.length} tiles only (smoke test)`);
  }

  const { prisms, grid } = loadPrisms();
  console.log(`prisms loaded for matching: ${prisms.length}`);

  const shellsByTile = new Map();
  const stats = { shells: 0, flat: 0, noRoof: 0, tooBig: 0, noPrism: 0, ridgeGuard: 0 };
  let done = 0;
  for (const tile of tiles) {
    const file = await download(tile);
    const json = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8"));
    extractShells(json, prisms, grid, shellsByTile, stats);
    done++;
    if (done % 20 === 0 || done === tiles.length) {
      console.log(`  ${done}/${tiles.length} tiles — ${stats.shells} roof shells so far`);
    }
  }
  console.log(`extraction: ${JSON.stringify(stats)}`);

  // ---- write per-km tile bins ----
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const index = {};
  let bytes = 0;
  for (const [key, shells] of shellsByTile) {
    shells.sort((a, b) => a.ordinal - b.ordinal);
    let size = 6;
    for (const s of shells) {
      size += 2 + 1 + s.verts.length * 6 + 1;
      for (const f of s.faceIdx) { size += 1; for (const r of f) size += 1 + r.length; }
    }
    const buf = Buffer.alloc(size);
    let pos = 0;
    buf.writeUInt32LE(0x46525452, pos); pos += 4; // 'RTRF'
    buf.writeUInt16LE(shells.length, pos); pos += 2;
    for (const s of shells) {
      buf.writeUInt16LE(s.ordinal, pos); pos += 2;
      buf.writeUInt8(s.verts.length, pos); pos += 1;
      for (const [x, y, z] of s.verts) {
        buf.writeInt16LE(Math.max(-32768, Math.min(32767, x - s.ox * 10)), pos); pos += 2;
        buf.writeInt16LE(Math.max(-32768, Math.min(32767, y - s.oy * 10)), pos); pos += 2;
        buf.writeUInt16LE(Math.min(65535, z), pos); pos += 2;
      }
      buf.writeUInt8(s.faceIdx.length, pos); pos += 1;
      for (const f of s.faceIdx) {
        buf.writeUInt8(f.length, pos); pos += 1;
        for (const r of f) {
          buf.writeUInt8(r.length, pos); pos += 1;
          for (const vi of r) { buf.writeUInt8(vi, pos); pos += 1; }
        }
      }
    }
    writeFileSync(join(OUT, `${key}.bin`), buf);
    index[key] = shells.length;
    bytes += buf.length;
  }
  writeFileSync(join(OUT, "index.json"), JSON.stringify({
    source: "3D BAG LoD2.2 RoofSurface (https://3dbag.nl, TU Delft), CC BY 4.0",
    builtAt: new Date().toISOString(),
    tile: TILE,
    shells: stats.shells,
    tiles: index,
  }));
  console.log(`roofs/: ${Object.keys(index).length} tiles, ${stats.shells} shells, ${(bytes / 1e6).toFixed(1)} MB`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
