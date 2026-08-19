// Loads and parses the binary city data produced by scripts/build-data.mjs.

export interface Meta {
  version: number;
  origin: { lat: number; lon: number };
  extent: { minX: number; minY: number; maxX: number; maxY: number };
  counts: {
    roadWays: number;
    roadKm: number;
    pathKm: number;
    graphNodes: number;
    graphEdges: number;
    signalsInventory: number;
    signalsOnNetwork: number;
    signalClusters: number;
    junctions: number;
    crossings: number;
    waterPolys: number;
    railWays: number;
    buildings: number;
    transitRoutes?: number;
  };
  districts: { key: string; name: string; x: number; y: number }[];
}

export interface PolylineSet {
  count: number;
  cls: Uint8Array;
  flags: Uint8Array;
  ptOffset: Uint32Array; // start (in points) into coords
  ptCount: Uint32Array;
  coords: Float32Array; // x,y pairs
}

// mode mask bits (edges.modeMask / inCore): 1 car, 2 bike, 4 walk
export const MODE_CAR = 1;
export const MODE_BIKE = 2;
export const MODE_WALK = 4;

export interface Graph {
  nodeCount: number;
  nodesXY: Float32Array;
  inCore: Uint8Array; // per-node reachable-core bits per mode
  signals: { count: number; nodeIdx: Uint32Array; cluster: Uint16Array; phase: Uint8Array; crossingOnly: Uint8Array };
  aux: { count: number; xy: Float32Array; cluster: Int16Array; phase: Uint8Array };
  clusters: { count: number; xy: Float32Array; crossing: Uint8Array; cycle: Uint8Array; offset: Uint16Array };
  edges: {
    count: number;
    a: Uint32Array;
    b: Uint32Array;
    cls: Uint8Array;
    flags: Uint8Array; // 1 oneway, 2 tunnel, 4 bridge
    speed: Uint16Array;
    len: Float32Array;
    geoOff: Uint32Array;
    geoCount: Uint16Array;
    district: Uint8Array;
    modeMask: Uint8Array;
    nameIdx: Uint16Array;
  };
  names: string[];
  geo: Float32Array;
}

export interface BuildingTile {
  ox: number;
  oy: number;
  count: number;
  // packed per building: heightDm u16, nVerts u8, nTris u8, verts i16 pairs (dm), tris u8
  heights: Uint16Array;
  nVerts: Uint8Array;
  nTris: Uint8Array;
  vertOff: Uint32Array;
  triOff: Uint32Array;
  verts: Int16Array;
  tris: Uint8Array;
  totalVerts: number;
  totalTris: number;
}

export interface NdwStation {
  x: number;
  y: number;
  edge: number;
  cls: number;
  flow: number; // veh/h at capture
  speed: number;
  lanes: number;
  name: string;
}

export interface NdwData {
  source: string;
  capturedAt: string;
  todMin: number;
  stations: NdwStation[];
}

export interface DistrictBoundary {
  name: string;
  labelX: number;
  labelY: number;
  rings: Float32Array[]; // x,y pairs per ring
}

export interface TransitRoute {
  kind: number; // 0 tram, 1 metro
  ref: string;
  pts: Float32Array; // x,y pairs
  tunnel: Uint8Array; // per point
  stops: Float32Array; // arc-length positions
}

export interface CityData {
  meta: Meta;
  roads: PolylineSet;
  rail: PolylineSet;
  graph: Graph;
  graphBuffer: ArrayBuffer; // raw copy for the sim worker
  water: { verts: Float32Array; tris: Uint32Array };
  buildings: BuildingTile[];
  transit: TransitRoute[];
  districtBounds: DistrictBoundary[];
  ndw: NdwData | null;
}

async function fetchBuf(url: string, onProgress: (frac: number) => void): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get("Content-Length") ?? 0);
  if (!res.body || !total) {
    const buf = await res.arrayBuffer();
    onProgress(1);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(Math.min(1, got / total));
  }
  const out = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out.buffer;
}

class Reader {
  dv: DataView;
  pos = 0;
  constructor(buf: ArrayBuffer) {
    this.dv = new DataView(buf);
  }
  u8() { return this.dv.getUint8(this.pos++); }
  u16() { const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  i16() { const v = this.dv.getInt16(this.pos, true); this.pos += 2; return v; }
  u32() { const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  f32() { const v = this.dv.getFloat32(this.pos, true); this.pos += 4; return v; }
}

function parsePolylines(buf: ArrayBuffer, magic: number): PolylineSet {
  const r = new Reader(buf);
  if (r.u32() !== magic) throw new Error("bad polyline magic");
  const count = r.u32();
  const cls = new Uint8Array(count);
  const flags = new Uint8Array(count);
  const ptOffset = new Uint32Array(count);
  const ptCount = new Uint32Array(count);
  let totalPts = 0;
  // first pass to count points requires walking; do single pass into growable array
  const coordsArr: number[] = [];
  for (let i = 0; i < count; i++) {
    cls[i] = r.u8();
    flags[i] = r.u8();
    const n = r.u16();
    ptOffset[i] = totalPts;
    ptCount[i] = n;
    for (let k = 0; k < n; k++) {
      coordsArr.push(r.f32(), r.f32());
    }
    totalPts += n;
  }
  return { count, cls, flags, ptOffset, ptCount, coords: Float32Array.from(coordsArr) };
}

export function parseGraph(buf: ArrayBuffer): Graph {
  const r = new Reader(buf);
  if (r.u32() !== 0x474d5452) throw new Error("bad graph magic");
  const version = r.u32();
  if (version !== 4) throw new Error("graph version mismatch — rerun: npm run build-data");
  const nodeCount = r.u32();
  const nodesXY = new Float32Array(nodeCount * 2);
  const inCore = new Uint8Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    nodesXY[i * 2] = r.f32();
    nodesXY[i * 2 + 1] = r.f32();
    inCore[i] = r.u8();
  }
  const sigCount = r.u32();
  const signals = {
    count: sigCount,
    nodeIdx: new Uint32Array(sigCount),
    cluster: new Uint16Array(sigCount),
    phase: new Uint8Array(sigCount),
    crossingOnly: new Uint8Array(sigCount),
  };
  for (let i = 0; i < sigCount; i++) {
    signals.nodeIdx[i] = r.u32();
    signals.cluster[i] = r.u16();
    signals.phase[i] = r.u8();
    signals.crossingOnly[i] = r.u8();
  }
  const auxCount = r.u32();
  const aux = {
    count: auxCount,
    xy: new Float32Array(auxCount * 2),
    cluster: new Int16Array(auxCount),
    phase: new Uint8Array(auxCount),
  };
  for (let i = 0; i < auxCount; i++) {
    aux.xy[i * 2] = r.f32();
    aux.xy[i * 2 + 1] = r.f32();
    aux.cluster[i] = r.i16();
    aux.phase[i] = r.u8();
    r.u8();
  }
  const cCount = r.u32();
  const clusters = {
    count: cCount,
    xy: new Float32Array(cCount * 2),
    crossing: new Uint8Array(cCount),
    cycle: new Uint8Array(cCount),
    offset: new Uint16Array(cCount),
  };
  for (let i = 0; i < cCount; i++) {
    clusters.xy[i * 2] = r.f32();
    clusters.xy[i * 2 + 1] = r.f32();
    clusters.crossing[i] = r.u8();
    clusters.cycle[i] = r.u8();
    clusters.offset[i] = r.u16();
  }
  const eCount = r.u32();
  const edges = {
    count: eCount,
    a: new Uint32Array(eCount),
    b: new Uint32Array(eCount),
    cls: new Uint8Array(eCount),
    flags: new Uint8Array(eCount),
    speed: new Uint16Array(eCount),
    len: new Float32Array(eCount),
    geoOff: new Uint32Array(eCount),
    geoCount: new Uint16Array(eCount),
    district: new Uint8Array(eCount),
    modeMask: new Uint8Array(eCount),
    nameIdx: new Uint16Array(eCount),
  };
  for (let i = 0; i < eCount; i++) {
    edges.a[i] = r.u32();
    edges.b[i] = r.u32();
    edges.cls[i] = r.u8();
    edges.flags[i] = r.u8();
    edges.speed[i] = r.u16();
    edges.len[i] = r.f32();
    edges.geoOff[i] = r.u32();
    edges.geoCount[i] = r.u16();
    edges.district[i] = r.u8();
    edges.modeMask[i] = r.u8();
    edges.nameIdx[i] = r.u16();
  }
  const nameCount = r.u16();
  const names: string[] = [];
  const dec = new TextDecoder();
  for (let i = 0; i < nameCount; i++) {
    const len = r.u8();
    names.push(dec.decode(new Uint8Array(buf, r.pos, len)));
    r.pos += len;
  }
  const geoCount = r.u32();
  const geo = new Float32Array(buf.slice(r.pos, r.pos + geoCount * 8));
  return { nodeCount, nodesXY, inCore, signals, aux, clusters, edges, names, geo };
}

function parseWater(buf: ArrayBuffer) {
  const r = new Reader(buf);
  if (r.u32() !== 0x574d5452) throw new Error("bad water magic");
  const nVerts = r.u32();
  const verts = new Float32Array(buf.slice(r.pos, r.pos + nVerts * 8));
  r.pos += nVerts * 8;
  const nTris = r.u32();
  const tris = new Uint32Array(buf.slice(r.pos, r.pos + nTris * 12));
  return { verts, tris };
}

function parseBuildings(buf: ArrayBuffer): BuildingTile[] {
  const r = new Reader(buf);
  if (r.u32() !== 0x424d5452) throw new Error("bad buildings magic");
  const tileCount = r.u32();
  const tiles: BuildingTile[] = [];
  for (let t = 0; t < tileCount; t++) {
    const ox = r.f32();
    const oy = r.f32();
    const count = r.u32();
    const heights = new Uint16Array(count);
    const nVerts = new Uint8Array(count);
    const nTris = new Uint8Array(count);
    const vertOff = new Uint32Array(count);
    const triOff = new Uint32Array(count);
    let vTot = 0, tTot = 0;
    const vertsArr: number[] = [];
    const trisArr: number[] = [];
    for (let i = 0; i < count; i++) {
      heights[i] = r.u16();
      const nv = r.u8();
      const nt = r.u8();
      nVerts[i] = nv;
      nTris[i] = nt;
      vertOff[i] = vTot;
      triOff[i] = tTot;
      for (let k = 0; k < nv * 2; k++) vertsArr.push(r.i16());
      for (let k = 0; k < nt * 3; k++) trisArr.push(r.u8());
      vTot += nv;
      tTot += nt;
    }
    tiles.push({
      ox, oy, count, heights, nVerts, nTris, vertOff, triOff,
      verts: Int16Array.from(vertsArr),
      tris: Uint8Array.from(trisArr),
      totalVerts: vTot,
      totalTris: tTot,
    });
  }
  return tiles;
}

function parseTransit(buf: ArrayBuffer): TransitRoute[] {
  const r = new Reader(buf);
  if (r.u32() !== 0x544d5452) throw new Error("bad transit magic");
  const count = r.u32();
  const routes: TransitRoute[] = [];
  for (let i = 0; i < count; i++) {
    const kind = r.u8();
    const refLen = r.u8();
    let ref = "";
    for (let k = 0; k < refLen; k++) ref += String.fromCharCode(r.u8());
    const n = r.u16();
    const nStops = r.u16();
    const pts = new Float32Array(n * 2);
    for (let k = 0; k < n * 2; k++) pts[k] = r.f32();
    const tunnel = new Uint8Array(n);
    for (let k = 0; k < n; k++) tunnel[k] = r.u8();
    const stops = new Float32Array(nStops);
    for (let k = 0; k < nStops; k++) stops[k] = r.f32();
    routes.push({ kind, ref, pts, tunnel, stops });
  }
  return routes;
}

function parseDistrictBounds(buf: ArrayBuffer): DistrictBoundary[] {
  const r = new Reader(buf);
  if (r.u32() !== 0x444d5452) throw new Error("bad districts magic");
  const count = r.u16();
  const dec = new TextDecoder();
  const out: DistrictBoundary[] = [];
  for (let i = 0; i < count; i++) {
    const nameLen = r.u8();
    const name = dec.decode(new Uint8Array(buf, r.pos, nameLen));
    r.pos += nameLen;
    const labelX = r.f32();
    const labelY = r.f32();
    const ringCount = r.u16();
    const rings: Float32Array[] = [];
    for (let k = 0; k < ringCount; k++) {
      const n = r.u16();
      const pts = new Float32Array(n * 2);
      for (let p = 0; p < n * 2; p++) pts[p] = r.f32();
      rings.push(pts);
    }
    out.push({ name, labelX, labelY, rings });
  }
  return out;
}

export type ProgressFn = (stage: "grid" | "signals" | "structures" | "sim", frac: number) => void;

export async function loadCity(base: string, onProgress: ProgressFn): Promise<CityData> {
  const metaRes = await fetch(`${base}meta.json`);
  if (!metaRes.ok) throw new Error("meta.json missing — run: npm run fetch-data && npm run build-data");
  const meta: Meta = await metaRes.json();

  const [roadsBuf, graphBuf, waterBuf, railBuf, bldBuf] = await Promise.all([
    fetchBuf(`${base}roads.bin`, (f) => onProgress("grid", f * 0.5)),
    fetchBuf(`${base}graph.bin`, (f) => onProgress("signals", f * 0.6)),
    fetchBuf(`${base}water.bin`, (f) => onProgress("grid", 0.5 + f * 0.2)),
    fetchBuf(`${base}rail.bin`, (f) => onProgress("grid", 0.7 + f * 0.1)),
    fetchBuf(`${base}buildings.bin`, (f) => onProgress("structures", f * 0.55)),
  ]);

  // transit & district boundaries are optional — older mirrors may lack them
  let transit: TransitRoute[] = [];
  try {
    const res = await fetch(`${base}transit.bin`);
    if (res.ok) transit = parseTransit(await res.arrayBuffer());
  } catch {
    /* run without transit */
  }
  let districtBounds: DistrictBoundary[] = [];
  try {
    const res = await fetch(`${base}districts.bin`);
    if (res.ok) districtBounds = parseDistrictBounds(await res.arrayBuffer());
  } catch {
    /* run without boundaries */
  }
  let ndw: NdwData | null = null;
  try {
    const res = await fetch(`${base}ndw.json`);
    if (res.ok) ndw = (await res.json()) as NdwData;
  } catch {
    /* run without calibration */
  }

  const roads = parsePolylines(roadsBuf, 0x524d5452);
  onProgress("grid", 0.9);
  const graph = parseGraph(graphBuf);
  onProgress("signals", 0.85);
  const water = parseWater(waterBuf);
  onProgress("grid", 1);
  const rail = parsePolylines(railBuf, 0x4c4d5452);
  const buildings = parseBuildings(bldBuf);
  onProgress("structures", 0.7);

  return { meta, roads, rail, graph, graphBuffer: graphBuf, water, buildings, transit, districtBounds, ndw };
}
