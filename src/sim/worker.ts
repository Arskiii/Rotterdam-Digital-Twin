// Traffic simulation engine — runs the whole city in a web worker.
//
// Multimodal: cars, bikes and pedestrians share one graph with per-edge mode
// masks. Cars/bikes: per-directed-edge FIFO lanes + IDM car-following and
// fixed-time signal controllers per clustered intersection. Pedestrians:
// free-flow walkers that cross with the signals (walk when cars face red).
// A* routing per mode over each mode's reachable core; time-of-day demand;
// incidents with rerouting.

import { parseGraph, MODE_CAR, type Graph } from "../data/loader";
import type { MainToWorker, MetricsMsg, DistrictStat } from "./protocol";

const post = (msg: unknown, transfer?: Transferable[]) =>
  (self as unknown as Worker).postMessage(msg, (transfer ?? []) as never);

// ---------------- state ----------------
let G: Graph;
let districtCount = 15;
let districtInfo: { name: string; x: number; y: number }[] = [];

function zoneName(x: number, y: number): string {
  let best = "";
  let bd = Infinity;
  for (const d of districtInfo) {
    const dd = (d.x - x) ** 2 + (d.y - y) ** 2;
    if (dd < bd) { bd = dd; best = d.name; }
  }
  return best.toUpperCase();
}

// directed edges: id = e*2 (a→b) | e*2+1 (b→a, only if two-way)
let M = 0; // directed edge count (E*2)
let dTarget: Int32Array;
let dSource: Int32Array;
let dLen: Float32Array;
let dSpeed: Float32Array; // car free-flow m/s
let dExists: Uint8Array;
let dBlocked: Uint8Array;
let outOff: Uint32Array;
let outList: Uint32Array;
let nodeSignal: Int32Array;
// FIFO queues: cars at [d], bikes at [M + d]
let qHead: Int32Array;
let qTail: Int32Array;
let edgeCong: Float32Array;
let edgeVSum: Float32Array;
let edgeVN: Uint16Array;

let sigState: Uint8Array;
let clusterFault: Float32Array;
// actuated controller state per cluster
let ctlPhase: Uint8Array; // 0 greenA · 1 greenB · 2 amber→B · 3 amber→A · 4 allRed→B · 5 allRed→A
let ctlTimer: Float32Array;
let ctlGap: Float32Array; // seconds since last demand on the green phase
let phaseDemand: Float32Array; // [cluster*2 + phase] accumulated waiting

// agents (SoA) — mode 3 = truck (car rules, heavier dynamics, shares car lanes)
const MAXV = 22000;
const MODES = 3; // spawn-table modes: 0 car, 1 bike, 2 walk
const V_LEN = [4.8, 2.0, 0.6, 9.5];
const IDM_A = [1.7, 1.4, 0, 0.9];
const IDM_B = [2.4, 2.0, 0, 1.6];
const IDM_T = [1.15, 0.9, 0, 1.5];
const IDM_S0 = [2.1, 1.4, 0, 3.0];
const TRUCK_SHARE = 0.05;
let vAlive: Uint8Array;
let vMode: Uint8Array;
let vEdge: Int32Array;
let vS: Float32Array;
let vV: Float32Array;
let vV0f: Float32Array;
let vAhead: Int32Array;
let vBehind: Int32Array;
let vWait: Float32Array;
let vRouteIdx: Int32Array;
const vRoutes: Int32Array[] = [];
let freeList: number[] = [];
const activeByMode = [0, 0, 0, 0]; // cars, bikes, walkers, trucks

// scenario machinery
interface ScenarioState {
  kind: string;
  until: number; // simTime
  blockedEdges: number[]; // directed
  speedEdges: { d: number; orig: number }[];
}
let scenario: ScenarioState | null = null;
let burst: { edges: Int32Array; walkEdges: Int32Array; carsLeft: number; walkLeft: number; truckChance: number } | null = null;

// NDW calibration: real veh/h per matched undirected edge
let ndwEdgeFlow: Map<number, number> | null = null;
let ndwTodMin = 0;
let ndwCounts: Map<number, number> | null = null; // sim vehicle-passes per matched edge
let ndwWindowStartSim = 0;
let ndwSimVehH = 0; // smoothed aggregate
let ndwStations = 0;
let ndwOrder: Int32Array | null = null; // station index → edge (NdwMsg order)
let ndwStationFlow: Float32Array | null = null; // smoothed sim veh/h per station

// params
let targetDensity = 5200;
let simSpeed = 1;
let cycleScale = 1;
let signalProgram: "actuated" | "coordinated" | "fixed" = "actuated";
// green-wave corridors (built at init from street names)
let corrId: Int32Array;
let corrOffset: Float32Array;
let corrPhase: Uint8Array;
let corridorCount = 0;
let running = true;
let congestionFeed = false;
let autoIncidents = true;

// clocks
let simTime = 0;
let clockMin = 8 * 60 + 12;
const CLOCK_RATE = 72;
let completed = 0;
let completedLog: { t: number; wait: number }[] = [];
const incidents: { dEdge: number; until: number; x: number; y: number }[] = [];
let weatherFactor = 1; // live-weather speed multiplier for motorized modes
const liveBridges = new Map<string, number[]>(); // open bascule bridge → blocked directed edges
// real NDW incidents: key edge:kind → affected directed edges with saved speeds
const liveIncidents = new Map<string, { blocked: number[]; slowed: { d: number; orig: number }[] }>();

// per-mode free-flow speed on a directed edge
function modeSpeed(d: number, mode: number): number {
  if (mode === 0) return dSpeed[d] * weatherFactor;
  if (mode === 3) return Math.min(23, dSpeed[d] * 0.88) * weatherFactor; // trucks capped ~83 km/h
  const cls = G.edges.cls[d >> 1];
  if (mode === 1) {
    if (cls === 8) return 5.6; // cycle track
    if (cls === 7) return 2.6; // pedestrian zone: crawl
    return 4.7;
  }
  return 1.38; // walk
}
const MODE_HEUR_SPEED = [27, 5.6, 1.6, 23];

// ---------------- init ----------------
function init(buf: ArrayBuffer) {
  post({ type: "initProgress", frac: 0.08 });
  G = parseGraph(buf);
  post({ type: "initProgress", frac: 0.42 });
  const E = G.edges.count;
  const N = G.nodeCount;
  M = E * 2;

  dTarget = new Int32Array(M).fill(-1);
  dSource = new Int32Array(M).fill(-1);
  dLen = new Float32Array(M);
  dSpeed = new Float32Array(M);
  dExists = new Uint8Array(M);
  dBlocked = new Uint8Array(M);
  qHead = new Int32Array(M * 2).fill(-1);
  qTail = new Int32Array(M * 2).fill(-1);
  edgeCong = new Float32Array(E);
  edgeVSum = new Float32Array(E);
  edgeVN = new Uint16Array(E);

  const outDeg = new Uint32Array(N);
  for (let e = 0; e < E; e++) {
    const a = G.edges.a[e], b = G.edges.b[e];
    const oneway = (G.edges.flags[e] & 1) !== 0;
    outDeg[a]++;
    if (!oneway) outDeg[b]++;
  }
  outOff = new Uint32Array(N + 1);
  for (let i = 0; i < N; i++) outOff[i + 1] = outOff[i] + outDeg[i];
  outList = new Uint32Array(outOff[N]);
  const cursor = outOff.slice(0, N);
  for (let e = 0; e < E; e++) {
    const a = G.edges.a[e], b = G.edges.b[e];
    const oneway = (G.edges.flags[e] & 1) !== 0;
    const spd = (G.edges.speed[e] / 3.6) * 0.94;
    const fwd = e * 2;
    dSource[fwd] = a; dTarget[fwd] = b; dLen[fwd] = G.edges.len[e]; dSpeed[fwd] = spd; dExists[fwd] = 1;
    outList[cursor[a]++] = fwd;
    if (!oneway) {
      const bwd = e * 2 + 1;
      dSource[bwd] = b; dTarget[bwd] = a; dLen[bwd] = G.edges.len[e]; dSpeed[bwd] = spd; dExists[bwd] = 1;
      outList[cursor[b]++] = bwd;
    }
  }

  post({ type: "initProgress", frac: 0.6 });
  nodeSignal = new Int32Array(N).fill(-1);
  for (let s = 0; s < G.signals.count; s++) nodeSignal[G.signals.nodeIdx[s]] = s;

  sigState = new Uint8Array(G.signals.count + G.aux.count).fill(3);
  clusterFault = new Float32Array(G.clusters.count);
  ctlPhase = new Uint8Array(G.clusters.count);
  ctlTimer = new Float32Array(G.clusters.count);
  ctlGap = new Float32Array(G.clusters.count);
  phaseDemand = new Float32Array(G.clusters.count * 2);
  for (let c = 0; c < G.clusters.count; c++) ctlPhase[c] = hashPhase(c);

  vAlive = new Uint8Array(MAXV);
  vMode = new Uint8Array(MAXV);
  vEdge = new Int32Array(MAXV);
  vS = new Float32Array(MAXV);
  vV = new Float32Array(MAXV);
  vV0f = new Float32Array(MAXV);
  vAhead = new Int32Array(MAXV).fill(-1);
  vBehind = new Int32Array(MAXV).fill(-1);
  vWait = new Float32Array(MAXV);
  vRouteIdx = new Int32Array(MAXV);
  for (let i = 0; i < MAXV; i++) vRoutes.push(new Int32Array(0));
  freeList = [];
  for (let i = MAXV - 1; i >= 0; i--) freeList.push(i);

  post({ type: "initProgress", frac: 0.74 });
  buildSpawnTables();
  post({ type: "initProgress", frac: 0.9 });
  buildCorridors();
  post({ type: "initProgress", frac: 0.97 });

  let laneKm = 0;
  for (let d = 0; d < M; d++) if (dExists[d] && G.edges.modeMask[d >> 1] & MODE_CAR) laneKm += dLen[d] / 1000;
  post({ type: "ready", edgeCount: E, laneKm: Math.round(laneKm) });
}

// ---------------- weighted spawn sampling (per mode) ----------------
const spawnEdges: Int32Array[] = [];
const spawnCum: Float64Array[] = [];
function buildSpawnTables() {
  const CAR_W = [3.2, 2.6, 2.2, 1.7, 1.3, 0.7, 0, 0, 0, 0];
  const BIKE_W = [0, 0, 0, 0.7, 1.4, 1.6, 0.7, 1.0, 3.2, 0.9];
  const WALK_W = [0, 0, 0, 0.15, 0.25, 0.8, 0.5, 3.0, 0.3, 2.4];
  const minLen = [30, 20, 10];
  for (let mode = 0; mode < MODES; mode++) {
    const bit = 1 << mode;
    const W = mode === 0 ? CAR_W : mode === 1 ? BIKE_W : WALK_W;
    const list: number[] = [];
    const w: number[] = [];
    for (let d = 0; d < M; d++) {
      if (!dExists[d]) continue;
      const e = d >> 1;
      if (!(G.edges.modeMask[e] & bit)) continue;
      if (!(G.inCore[G.edges.a[e]] & bit) || !(G.inCore[G.edges.b[e]] & bit)) continue;
      if (dLen[d] < minLen[mode]) continue;
      const weight = W[G.edges.cls[e]];
      if (weight <= 0) continue;
      list.push(d);
      w.push(weight * Math.min(mode === 0 ? 400 : 220, dLen[d]));
    }
    spawnEdges[mode] = Int32Array.from(list);
    spawnCum[mode] = new Float64Array(w.length);
    let acc = 0;
    for (let i = 0; i < w.length; i++) { acc += w[i]; spawnCum[mode][i] = acc; }
  }
  console.log(`spawn tables: car ${spawnEdges[0].length}, bike ${spawnEdges[1].length}, walk ${spawnEdges[2].length}`);
}
function sampleSpawnEdge(mode: number): number {
  const cum = spawnCum[mode];
  if (!cum.length) return -1;
  const r = Math.random() * cum[cum.length - 1];
  let lo = 0, hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < r) lo = mid + 1;
    else hi = mid;
  }
  return spawnEdges[mode][lo];
}

// ---------------- A* routing ----------------
const ROUTE_LIMIT = 26000;
let astarDist: Float32Array;
let astarFrom: Int32Array;
let astarSeen: Int32Array;
let astarStamp = 0;
let heapN: Int32Array;
let heapD: Float32Array;

function route(fromEdge: number, toEdge: number, mode: number): Int32Array | null {
  if (!astarDist) {
    astarDist = new Float32Array(G.nodeCount);
    astarFrom = new Int32Array(G.nodeCount);
    astarSeen = new Int32Array(G.nodeCount);
    heapN = new Int32Array(1 << 16);
    heapD = new Float32Array(1 << 16);
  }
  const bit = 1 << mode;
  const start = dTarget[fromEdge];
  const goal = dSource[toEdge];
  if (start === goal) return Int32Array.of(fromEdge, toEdge);
  const gx = G.nodesXY[goal * 2], gy = G.nodesXY[goal * 2 + 1];
  astarStamp++;
  let hn = 0;
  const push = (node: number, d: number) => {
    let i = hn++;
    if (hn >= heapN.length) { hn--; return; }
    heapN[i] = node; heapD[i] = d;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapD[p] <= heapD[i]) break;
      const tn = heapN[p]; heapN[p] = heapN[i]; heapN[i] = tn;
      const td = heapD[p]; heapD[p] = heapD[i]; heapD[i] = td;
      i = p;
    }
  };
  const pop = (): number => {
    const top = heapN[0];
    hn--;
    heapN[0] = heapN[hn]; heapD[0] = heapD[hn];
    let i = 0;
    for (;;) {
      const l = i * 2 + 1, r = l + 1;
      let m = i;
      if (l < hn && heapD[l] < heapD[m]) m = l;
      if (r < hn && heapD[r] < heapD[m]) m = r;
      if (m === i) break;
      const tn = heapN[m]; heapN[m] = heapN[i]; heapN[i] = tn;
      const td = heapD[m]; heapD[m] = heapD[i]; heapD[i] = td;
      i = m;
    }
    return top;
  };
  const hSpd = MODE_HEUR_SPEED[mode];
  const hFn = (n: number) => {
    const dx = G.nodesXY[n * 2] - gx, dy = G.nodesXY[n * 2 + 1] - gy;
    return Math.hypot(dx, dy) / hSpd;
  };
  astarSeen[start] = astarStamp;
  astarDist[start] = 0;
  astarFrom[start] = -1;
  push(start, hFn(start));
  const sigPenalty = mode === 2 ? 4 : 9;
  let expansions = 0;
  while (hn > 0 && expansions++ < ROUTE_LIMIT) {
    const node = pop();
    if (node === goal) {
      const dEdges: number[] = [toEdge];
      let cur = goal;
      while (cur !== start) {
        const via = astarFrom[cur];
        if (via < 0) break;
        dEdges.push(via);
        cur = dSource[via];
      }
      dEdges.push(fromEdge);
      dEdges.reverse();
      return Int32Array.from(dEdges);
    }
    const dHere = astarDist[node];
    for (let i = outOff[node]; i < outOff[node + 1]; i++) {
      const d = outList[i];
      if (!(G.edges.modeMask[d >> 1] & bit)) continue;
      if (mode === 0 && dBlocked[d]) continue;
      const nx = dTarget[d];
      const cost = dLen[d] / modeSpeed(d, mode) + (nodeSignal[nx] >= 0 ? sigPenalty : 0) + 1.2;
      const nd = dHere + cost;
      if (astarSeen[nx] !== astarStamp || nd < astarDist[nx]) {
        astarSeen[nx] = astarStamp;
        astarDist[nx] = nd;
        astarFrom[nx] = d;
        push(nx, nd + hFn(nx));
      }
    }
  }
  return null;
}

// ---------------- queues (trucks share the car lanes) ----------------
const qBase = (mode: number) => (mode === 1 ? M : 0);
function enqueue(veh: number, d: number) {
  const q = qBase(vMode[veh]) + d;
  vAhead[veh] = qTail[q];
  vBehind[veh] = -1;
  if (qTail[q] >= 0) vBehind[qTail[q]] = veh;
  else qHead[q] = veh;
  qTail[q] = veh;
}
function removeFromQueue(id: number) {
  const q = qBase(vMode[id]) + vEdge[id];
  const ah = vAhead[id], bh = vBehind[id];
  if (ah >= 0) vBehind[ah] = bh;
  else qHead[q] = bh;
  if (bh >= 0) vAhead[bh] = ah;
  else qTail[q] = ah;
  vAhead[id] = -1;
  vBehind[id] = -1;
}

// trip radius per mode: [minM, maxM, localShare]
const TRIP_SHAPE = [
  [800, 6000, 0.65],
  [400, 3600, 0.95],
  [140, 1300, 1.0],
];

function spawn(mode: number, originEdge = -1, truckChance = TRUCK_SHARE) {
  if (freeList.length === 0) return;
  for (let tries = 0; tries < 4; tries++) {
    const a = originEdge >= 0 ? originEdge : sampleSpawnEdge(mode);
    if (a < 0) return;
    let b = sampleSpawnEdge(mode);
    const [minR, maxR, localShare] = TRIP_SHAPE[mode];
    if (Math.random() < localShare) {
      const ax = G.nodesXY[dSource[a] * 2], ay = G.nodesXY[dSource[a] * 2 + 1];
      for (let k = 0; k < 10; k++) {
        const cand = sampleSpawnEdge(mode);
        const cx = G.nodesXY[dSource[cand] * 2], cy = G.nodesXY[dSource[cand] * 2 + 1];
        const dd = Math.hypot(cx - ax, cy - ay);
        if (dd > minR && dd < maxR) { b = cand; break; }
      }
    }
    if (b < 0 || (a >> 1) === (b >> 1)) continue;
    const r = route(a, b, mode);
    if (!r || r.length < 3) continue;
    const id = freeList.pop()!;
    vRoutes[id] = r;
    vRouteIdx[id] = 0;
    vMode[id] = mode === 0 && Math.random() < truckChance ? 3 : mode;
    const m = vMode[id];
    vEdge[id] = a;
    vS[id] = Math.min(8, dLen[a] * 0.3);
    vV[id] = Math.min(modeSpeed(a, m), m === 2 ? 1.4 : 8);
    vV0f[id] = m === 2 ? 0.85 + Math.random() * 0.4 : m === 3 ? 0.78 + Math.random() * 0.14 : 0.88 + Math.random() * 0.27;
    vWait[id] = 0;
    vAlive[id] = 1;
    if (m !== 2) {
      const tail = qTail[qBase(m) + a];
      if (tail >= 0 && vS[tail] < vS[id] + V_LEN[m] + 2) {
        vAlive[id] = 0;
        freeList.push(id);
        return;
      }
      enqueue(id, a);
    } else {
      vAhead[id] = -1;
      vBehind[id] = -1;
    }
    activeByMode[m]++;
    return;
  }
}

function despawn(id: number, finished: boolean) {
  if (vMode[id] !== 2) removeFromQueue(id);
  vAlive[id] = 0;
  freeList.push(id);
  activeByMode[vMode[id]]--;
  if (finished && (vMode[id] === 0 || vMode[id] === 3)) {
    completed++;
    completedLog.push({ t: simTime, wait: vWait[id] });
  }
}

// signal state at the target node of directed edge d: 0 red, 1 amber, 2 green, 3 none
function signalAt(d: number): number {
  const sig = nodeSignal[dTarget[d]];
  if (sig < 0) return 3;
  return sigState[sig];
}

function hashPhase(c: number): number {
  return (c * 2654435761) % 2 === 0 ? 0 : 1;
}

// Group signalized junctions into green-wave corridors: clusters that share a
// primary/secondary/tertiary street name, ordered along the street's bearing,
// with offsets timed for ~45 km/h progression.
function buildCorridors() {
  const C = G.clusters;
  const S = G.signals;
  corrId = new Int32Array(C.count).fill(-1);
  corrOffset = new Float32Array(C.count);
  corrPhase = new Uint8Array(C.count);

  const signalNodes = new Map<number, number[]>(); // graph node → signal indices
  for (let s = 0; s < S.count; s++) {
    const n = S.nodeIdx[s];
    if (!signalNodes.has(n)) signalNodes.set(n, []);
    signalNodes.get(n)!.push(s);
  }

  // per cluster: name → {len, votes[2], sumX, sumY} over arterial edges at signal nodes
  const clusterNames = new Map<number, Map<number, { len: number; votes: [number, number] }>>();
  const nameLen = new Map<number, number>();
  const nameDir = new Map<number, { dx: number; dy: number; len: number }>();
  const nameClusters = new Map<number, Set<number>>();

  for (let e = 0; e < G.edges.count; e++) {
    const cls = G.edges.cls[e];
    if (cls < 2 || cls > 4) continue;
    const nameIdx = G.edges.nameIdx[e];
    const len = G.edges.len[e];
    nameLen.set(nameIdx, (nameLen.get(nameIdx) ?? 0) + len);
    // dominant orientation (mod 180°) weighted by length
    const off = G.edges.geoOff[e];
    const n = G.edges.geoCount[e];
    let dx = G.geo[(off + n - 1) * 2] - G.geo[off * 2];
    let dy = G.geo[(off + n - 1) * 2 + 1] - G.geo[off * 2 + 1];
    if (dx < 0) { dx = -dx; dy = -dy; }
    const d = nameDir.get(nameIdx) ?? { dx: 0, dy: 0, len: 0 };
    d.dx += dx; d.dy += dy; d.len += len;
    nameDir.set(nameIdx, d);

    for (const node of [G.edges.a[e], G.edges.b[e]]) {
      const sigs = signalNodes.get(node);
      if (!sigs) continue;
      for (const s of sigs) {
        const cl = S.cluster[s];
        if (!clusterNames.has(cl)) clusterNames.set(cl, new Map());
        const m = clusterNames.get(cl)!;
        if (!m.has(nameIdx)) m.set(nameIdx, { len: 0, votes: [0, 0] });
        const rec = m.get(nameIdx)!;
        rec.len += len;
        rec.votes[S.phase[s]] += len;
        if (!nameClusters.has(nameIdx)) nameClusters.set(nameIdx, new Set());
        nameClusters.get(nameIdx)!.add(cl);
      }
    }
  }

  const candidates = [...nameClusters.entries()]
    .filter(([, set]) => set.size >= 3)
    .sort((a, b) => (nameLen.get(b[0]) ?? 0) - (nameLen.get(a[0]) ?? 0));

  const PROGRESSION = 12.5; // m/s ≈ 45 km/h
  for (const [nameIdx, set] of candidates) {
    const free = [...set].filter((cl) => corrId[cl] === -1 && !C.crossing[cl]);
    if (free.length < 3) continue;
    const dir = nameDir.get(nameIdx)!;
    const dl = Math.hypot(dir.dx, dir.dy) || 1;
    const ux = dir.dx / dl, uy = dir.dy / dl;
    const projs = free.map((cl) => C.xy[cl * 2] * ux + C.xy[cl * 2 + 1] * uy);
    const minP = Math.min(...projs);
    free.forEach((cl, i) => {
      corrId[cl] = corridorCount;
      corrOffset[cl] = (projs[i] - minP) / PROGRESSION;
      const rec = clusterNames.get(cl)?.get(nameIdx);
      corrPhase[cl] = rec && rec.votes[1] > rec.votes[0] ? 1 : 0;
    });
    corridorCount++;
  }
  let inCorridors = 0;
  for (let c = 0; c < C.count; c++) if (corrId[c] >= 0) inCorridors++;
  console.log(`green-wave corridors: ${corridorCount} (${inCorridors} junctions coordinated)`);
}

// Dutch-style vehicle actuation: hold green while the served phase has demand
// (up to maxGreen); switch when the cross phase is waiting and the green phase
// has gapped out. Rest alternating slowly when the junction is empty.
function stepActuated(c: number, dt: number) {
  const AMBER = 3.2;
  const ALLRED = 1.4;
  const MIN_GREEN = 6;
  const MAX_GREEN = 36 * cycleScale;
  const GAP_OUT = 2.6;
  const IDLE_SWAP = 24;

  const dA = phaseDemand[c * 2];
  const dB = phaseDemand[c * 2 + 1];
  ctlTimer[c] += dt;
  const ph = ctlPhase[c];
  if (ph === 0 || ph === 1) {
    const own = ph === 0 ? dA : dB;
    const cross = ph === 0 ? dB : dA;
    if (own > 0.05) ctlGap[c] = 0;
    else ctlGap[c] += dt;
    const gapped = ctlGap[c] > GAP_OUT;
    const wants =
      (cross > 0.05 && ctlTimer[c] > MIN_GREEN && (gapped || ctlTimer[c] > MAX_GREEN)) ||
      (cross <= 0.05 && own <= 0.05 && ctlTimer[c] > IDLE_SWAP);
    if (wants) {
      ctlPhase[c] = ph === 0 ? 2 : 3;
      ctlTimer[c] = 0;
    }
  } else if (ph === 2 || ph === 3) {
    if (ctlTimer[c] > AMBER) {
      ctlPhase[c] = ph === 2 ? 4 : 5;
      ctlTimer[c] = 0;
    }
  } else {
    if (ctlTimer[c] > ALLRED) {
      const next = ph === 4 ? 1 : 0;
      ctlPhase[c] = next;
      ctlTimer[c] = 0;
      ctlGap[c] = 0;
      phaseDemand[c * 2 + next] = 0; // queue will discharge
    }
  }
}

function updateSignals(dt: number) {
  const C = G.clusters;
  const cacheHolder = C as unknown as { _a?: number[] };
  cacheHolder._a ??= [];
  const cache = cacheHolder._a;
  for (let c = 0; c < C.count; c++) {
    const faulted = clusterFault[c] > simTime;
    let stateA: number, stateB: number;
    if (faulted) {
      stateA = stateB = 0;
    } else if (C.crossing[c]) {
      const cyc = Math.max(24, C.cycle[c] * cycleScale);
      const t = (simTime + C.offset[c]) % cyc;
      const red = t < 11;
      stateA = stateB = red ? 0 : t < 13 ? 1 : 2;
    } else if (signalProgram === "coordinated" && corrId[c] >= 0) {
      // fixed cycle with distance-based offset → platoons ride the green wave
      const CYC = Math.max(40, 64 * cycleScale);
      const amber = 3.2;
      const allRed = 1.4;
      const t = (((simTime - corrOffset[c]) % CYC) + CYC) % CYC;
      const gC = CYC * 0.55 - amber - allRed;
      const gX = CYC * 0.45 - amber - allRed;
      let stateC: number, stateX: number;
      if (t < gC) { stateC = 2; stateX = 0; }
      else if (t < gC + amber) { stateC = 1; stateX = 0; }
      else if (t < gC + amber + allRed) { stateC = 0; stateX = 0; }
      else if (t < gC + amber + allRed + gX) { stateC = 0; stateX = 2; }
      else if (t < gC + amber + allRed + gX + amber) { stateC = 0; stateX = 1; }
      else { stateC = 0; stateX = 0; }
      stateA = corrPhase[c] === 0 ? stateC : stateX;
      stateB = corrPhase[c] === 0 ? stateX : stateC;
    } else if (signalProgram !== "fixed") {
      stepActuated(c, dt);
      const ph = ctlPhase[c];
      stateA = ph === 0 ? 2 : ph === 2 ? 1 : 0;
      stateB = ph === 1 ? 2 : ph === 3 ? 1 : 0;
    } else {
      const cyc = Math.max(24, C.cycle[c] * cycleScale);
      const t = (simTime + C.offset[c]) % cyc;
      const amber = 3.2;
      const allRed = 1.4;
      const half = cyc / 2;
      const gA = half - amber - allRed;
      const tA = t < half ? t : -1;
      const tB = t >= half ? t - half : -1;
      stateA = tA < 0 ? 0 : tA < gA ? 2 : tA < gA + amber ? 1 : 0;
      stateB = tB < 0 ? 0 : tB < gA ? 2 : tB < gA + amber ? 1 : 0;
    }
    cache[c * 2] = stateA;
    cache[c * 2 + 1] = stateB;
  }
  // demand cools off slowly so stale pressure doesn't stick
  for (let i = 0; i < phaseDemand.length; i++) phaseDemand[i] *= 0.995;
  for (let s = 0; s < G.signals.count; s++) {
    sigState[s] = cache[G.signals.cluster[s] * 2 + G.signals.phase[s]];
  }
  for (let i = 0; i < G.aux.count; i++) {
    const c = G.aux.cluster[i];
    sigState[G.signals.count + i] = c < 0 ? 2 : cache[c * 2 + G.aux.phase[i]];
  }
}

function idmAccel(mode: number, v: number, v0: number, gap: number, dv: number): number {
  const sStar = IDM_S0[mode] + Math.max(0, v * IDM_T[mode] + (v * dv) / (2 * Math.sqrt(IDM_A[mode] * IDM_B[mode])));
  const free = Math.pow(v / Math.max(0.5, v0), 4);
  return IDM_A[mode] * (1 - free - (sStar / Math.max(0.5, gap)) ** 2);
}

function stepWalker(id: number, dt: number) {
  const d = vEdge[id];
  const len = dLen[d];
  const v0 = 1.38 * vV0f[id];
  let v = vV[id];
  let s = vS[id] + v * dt;
  v += (v0 - v) * Math.min(1, dt * 2.5);

  if (s >= len - 0.4) {
    const sig = signalAt(d);
    // pedestrians cross while cars are held (red); wait on car-green
    const mayCross = sig === 3 || sig === 0;
    const rIdx = vRouteIdx[id];
    const routeArr = vRoutes[id];
    if (rIdx >= routeArr.length - 1) {
      despawn(id, true);
      return;
    }
    if (mayCross) {
      vEdge[id] = routeArr[rIdx + 1];
      vRouteIdx[id] = rIdx + 1;
      vS[id] = Math.max(0.1, s - len);
      vV[id] = v;
      return;
    }
    s = len - 0.4;
    v = 0;
    vWait[id] += dt;
  }
  vS[id] = s;
  vV[id] = v;
}

function stepVehicles(dt: number) {
  for (let id = 0; id < MAXV; id++) {
    if (!vAlive[id]) continue;
    const mode = vMode[id];
    if (mode === 2) {
      stepWalker(id, dt);
      continue;
    }
    const d = vEdge[id];
    const len = dLen[d];
    const e = d >> 1;
    let v0 = modeSpeed(d, mode) * vV0f[id];
    const s = vS[id];
    const v = vV[id];

    const remain = len - s;
    if (remain < 34 && (mode === 0 || mode === 3)) {
      const turnV = mode === 3 ? 5.5 : 7.5;
      v0 = Math.min(v0, turnV + (remain / 34) * (v0 - turnV) * 0.5 + turnV);
    }

    let gap = 1e9;
    let dv = 0;
    const ahead = vAhead[id];
    if (ahead >= 0) {
      gap = vS[ahead] - s - V_LEN[mode];
      dv = v - vV[ahead];
    } else {
      const sig = signalAt(d);
      const stopGap = remain - 3.2;
      let mustStop = false;
      if (sig === 0) mustStop = true;
      else if (sig === 1 && stopGap > v * 1.6) mustStop = true;
      const rIdx = vRouteIdx[id];
      const routeArr = vRoutes[id];
      const isLast = rIdx >= routeArr.length - 1;
      const next = isLast ? -1 : routeArr[rIdx + 1];
      if (!mustStop && next >= 0) {
        if ((mode === 0 || mode === 3) && dBlocked[next]) mustStop = true;
        else {
          const tail = qTail[qBase(mode) + next];
          if (tail >= 0) {
            const g2 = remain + vS[tail] - V_LEN[mode];
            if (g2 < gap) { gap = g2; dv = v - vV[tail]; }
          }
        }
      }
      if (mustStop) {
        gap = Math.min(gap, stopGap);
        dv = v;
        // register demand with the actuated controller (cars near the stop line)
        if ((mode === 0 || mode === 3) && sig === 0 && remain < 40 && v < 3) {
          const si = nodeSignal[dTarget[d]];
          if (si >= 0) phaseDemand[G.signals.cluster[si] * 2 + G.signals.phase[si]] += dt;
        }
      }
    }

    let a = idmAccel(mode, v, v0, gap, dv);
    a = Math.max(-7.5, Math.min(IDM_A[mode], a));
    let nv = Math.max(0, v + a * dt);
    let ns = s + nv * dt;

    if (nv < 0.35) {
      vWait[id] += dt;
    }

    if (ns >= len - 0.01 && vAhead[id] < 0) {
      const sig = signalAt(d);
      const rIdx = vRouteIdx[id];
      const routeArr = vRoutes[id];
      if (rIdx >= routeArr.length - 1) {
        despawn(id, true);
        continue;
      }
      const next = routeArr[rIdx + 1];
      const canGo = sig === 2 || sig === 3 || (sig === 1 && vV[id] > 3);
      const tail = next >= 0 ? qTail[qBase(mode) + next] : -1;
      const room = tail < 0 || vS[tail] > V_LEN[mode] + 1.5;
      if (canGo && next >= 0 && !((mode === 0 || mode === 3) && dBlocked[next]) && room) {
        removeFromQueue(id);
        // NDW calibration counter: motorized vehicles entering a measured edge
        if (ndwCounts && (mode === 0 || mode === 3)) {
          const ue = next >> 1;
          const c = ndwCounts.get(ue);
          if (c !== undefined) ndwCounts.set(ue, c + 1);
        }
        vEdge[id] = next;
        vRouteIdx[id] = rIdx + 1;
        ns = Math.max(0, ns - len);
        vS[id] = Math.min(ns, Math.max(0.5, tail >= 0 ? vS[tail] - V_LEN[mode] - 1.2 : dLen[next]));
        enqueue(id, next);
        vV[id] = nv;
        continue;
      } else if ((mode === 0 || mode === 3) && next >= 0 && dBlocked[next] && vV[id] < 1) {
        const dest = routeArr[routeArr.length - 1];
        const r = route(d, dest, 0);
        if (r && r.length >= 2) {
          vRoutes[id] = r;
          vRouteIdx[id] = 0;
        } else {
          despawn(id, false);
          continue;
        }
      }
      ns = len - 0.01;
      nv = 0;
    }

    vS[id] = ns;
    vV[id] = nv;
    if (mode === 0 || mode === 3) {
      edgeVSum[e] += nv / Math.max(1, dSpeed[d]);
      edgeVN[e] = Math.min(65000, edgeVN[e] + 1);
    }
  }
}

// demand curves: fraction of peak by time of day
function demand(min: number): number {
  const h = min / 60;
  const morning = Math.exp(-((h - 8.4) ** 2) / (2 * 1.15 ** 2));
  const evening = Math.exp(-((h - 17.4) ** 2) / (2 * 1.5 ** 2));
  const midday = 0.44 * Math.exp(-((h - 13) ** 2) / (2 * 2.6 ** 2));
  const night = 0.085;
  return Math.min(1, night + morning * 0.98 + evening * 1.0 + midday);
}

// ---------------- incidents & faults ----------------
let nextAutoIncident = 220;
let nextFault = 400;
function maybeInject() {
  if (!autoIncidents) return;
  if (simTime > nextAutoIncident) {
    nextAutoIncident = simTime + 240 + Math.random() * 420;
    injectIncident();
  }
  if (simTime > nextFault) {
    nextFault = simTime + 300 + Math.random() * 600;
    const c = Math.floor(Math.random() * G.clusters.count);
    clusterFault[c] = simTime + 45 + Math.random() * 60;
    post({
      type: "event",
      level: "warn",
      text: `SIGNAL CLUSTER ${String(c).padStart(3, "0")} FAULT (${zoneName(G.clusters.xy[c * 2], G.clusters.xy[c * 2 + 1])}) — ALL-RED FALLBACK`,
    });
  }
  for (let i = incidents.length - 1; i >= 0; i--) {
    if (simTime > incidents[i].until) {
      const inc = incidents[i];
      dBlocked[inc.dEdge] = 0;
      if (dExists[inc.dEdge ^ 1]) dBlocked[inc.dEdge ^ 1] = 0;
      incidents.splice(i, 1);
      post({ type: "event", level: "ok", text: `INCIDENT CLEARED — SEGMENT REOPENED` });
    }
  }
}

function injectIncident() {
  for (let tries = 0; tries < 30; tries++) {
    const d = sampleSpawnEdge(0);
    if (d < 0) return;
    const e = d >> 1;
    if (G.edges.cls[e] > 3 || dBlocked[d]) continue;
    dBlocked[d] = 1;
    if (dExists[d ^ 1]) dBlocked[d ^ 1] = 1;
    const off = G.edges.geoOff[e];
    const x = G.geo[off * 2], y = G.geo[off * 2 + 1];
    incidents.push({ dEdge: d, until: simTime + 120 + Math.random() * 200, x, y });
    post({
      type: "event",
      level: "crit",
      text: `TRAFFIC INCIDENT IN ${zoneName(x, y)} — SEGMENT CLOSED, TRACKS REROUTING`,
    });
    return;
  }
}

// ---------------- scenario library ----------------
function edgesByName(name: string): number[] {
  const target = name.toLowerCase();
  let nameIdx = -1;
  for (let i = 0; i < G.names.length; i++) {
    if (G.names[i].toLowerCase() === target) { nameIdx = i; break; }
  }
  if (nameIdx < 0) return [];
  const out: number[] = [];
  for (let e = 0; e < G.edges.count; e++) {
    if (G.edges.nameIdx[e] === nameIdx && G.edges.modeMask[e] & MODE_CAR) out.push(e);
  }
  return out;
}

function spawnEdgesNear(mode: number, x: number, y: number, radius: number): Int32Array {
  const out: number[] = [];
  const r2 = radius * radius;
  const table = spawnEdges[mode];
  for (let i = 0; i < table.length; i++) {
    const d = table[i];
    const n = dSource[d];
    const dx = G.nodesXY[n * 2] - x;
    const dy = G.nodesXY[n * 2 + 1] - y;
    if (dx * dx + dy * dy < r2) out.push(d);
  }
  return Int32Array.from(out);
}

function clearScenario(announce: boolean) {
  if (!scenario) return;
  for (const d of scenario.blockedEdges) dBlocked[d] = 0;
  for (const { d, orig } of scenario.speedEdges) dSpeed[d] = orig;
  scenario = null;
  burst = null;
  if (announce) post({ type: "event", level: "ok", text: "SCENARIO CLEARED BY OPERATOR — NETWORK RESTORED" });
}

function startScenario(kind: string) {
  clearScenario(false);
  if (kind === "bridge") {
    const es = edgesByName("Erasmusbrug");
    if (!es.length) {
      post({ type: "event", level: "warn", text: "SCENARIO ABORT — TARGET SPAN NOT FOUND IN GRID" });
      return;
    }
    const blocked: number[] = [];
    for (const e of es) {
      dBlocked[e * 2] = 1;
      blocked.push(e * 2);
      if (dExists[e * 2 + 1]) { dBlocked[e * 2 + 1] = 1; blocked.push(e * 2 + 1); }
    }
    scenario = { kind, until: simTime + 260, blockedEdges: blocked, speedEdges: [] };
    post({ type: "event", level: "crit", text: "ERASMUSBRUG DECK RAISED — SPAN CLOSED, ALL TRACKS REROUTING VIA WILLEMSBRUG / MAASTUNNEL" });
  } else if (kind === "roadworks") {
    const es = edgesByName("'s-Gravendijkwal");
    if (!es.length) {
      post({ type: "event", level: "warn", text: "SCENARIO ABORT — WORKS CORRIDOR NOT FOUND IN GRID" });
      return;
    }
    const speedEdges: { d: number; orig: number }[] = [];
    for (const e of es) {
      for (const d of [e * 2, e * 2 + 1]) {
        if (!dExists[d]) continue;
        speedEdges.push({ d, orig: dSpeed[d] });
        dSpeed[d] = dSpeed[d] * 0.32;
      }
    }
    scenario = { kind, until: simTime + 600, blockedEdges: [], speedEdges };
    post({ type: "event", level: "warn", text: "ROADWORKS ON 'S-GRAVENDIJKWAL — CAPACITY CUT TO ONE LANE, EXPECT SPILLBACK" });
  } else if (kind === "stadium") {
    const edges = spawnEdgesNear(0, 2960, -2886, 950);
    const walkEdges = spawnEdgesNear(2, 2960, -2886, 950);
    burst = { edges, walkEdges, carsLeft: 700, walkLeft: 1500, truckChance: 0.02 };
    scenario = { kind, until: simTime + 420, blockedEdges: [], speedEdges: [] };
    post({ type: "event", level: "warn", text: "DE KUIP MATCH EGRESS — 2,200 TRACKS SURGING FROM STADIONPARK" });
  } else if (kind === "freight") {
    const edges = spawnEdgesNear(0, -4258, -3317, 1300);
    burst = { edges, walkEdges: Int32Array.of(), carsLeft: 520, walkLeft: 0, truckChance: 0.8 };
    scenario = { kind, until: simTime + 420, blockedEdges: [], speedEdges: [] };
    post({ type: "event", level: "warn", text: "WAALHAVEN FREIGHT SURGE — HEAVY CONVOY RELEASING ONTO THE RING" });
  }
}

// ---------------- metrics ----------------
let lastMetrics = 0;
let lastCong = 0;
const distAgg = { veh: new Float32Array(32), spd: new Float32Array(32), q: new Float32Array(32), cong: new Float32Array(32), n: new Float32Array(32) };

function sendMetrics() {
  const dists: DistrictStat[] = [];
  distAgg.veh.fill(0); distAgg.spd.fill(0); distAgg.q.fill(0); distAgg.cong.fill(0); distAgg.n.fill(0);
  let vSum = 0, queued = 0;
  let roadAgents = 0;
  for (let id = 0; id < MAXV; id++) {
    if (!vAlive[id] || (vMode[id] !== 0 && vMode[id] !== 3)) continue;
    roadAgents++;
    const e = vEdge[id] >> 1;
    const di = G.edges.district[e];
    distAgg.veh[di]++;
    distAgg.spd[di] += vV[id];
    vSum += vV[id];
    if (vV[id] < 0.5) { queued++; distAgg.q[di]++; }
  }
  for (let e = 0; e < G.edges.count; e++) {
    if (!(G.edges.modeMask[e] & MODE_CAR)) continue;
    const di = G.edges.district[e];
    distAgg.cong[di] += edgeCong[e];
    distAgg.n[di]++;
  }
  for (let i = 0; i < districtCount; i++) {
    const nv = distAgg.veh[i];
    dists.push({
      vehicles: nv,
      speedKmh: nv > 0 ? (distAgg.spd[i] / nv) * 3.6 : 0,
      congestion: distAgg.n[i] > 0 ? distAgg.cong[i] / distAgg.n[i] : 0,
      queued: distAgg.q[i],
    });
  }
  const horizon = simTime - 60;
  completedLog = completedLog.filter((c) => c.t > horizon);
  const thr = completedLog.length;
  const avgWait = completedLog.length ? completedLog.reduce((a, c) => a + c.wait, 0) / completedLog.length : 0;
  let greens = 0;
  for (let s = 0; s < sigState.length; s++) if (sigState[s] === 2) greens++;
  let congSum = 0;
  let congN = 0;
  for (let e = 0; e < G.edges.count; e++) {
    if (G.edges.cls[e] <= 4) { congSum += edgeCong[e]; congN++; }
  }
  // NDW calibration: compare simulated flow on measured edges against the
  // real counts, normalized to the current sim time of day via the demand curve
  let calibration: MetricsMsg["calibration"];
  if (ndwEdgeFlow && ndwCounts && ndwOrder && ndwStationFlow) {
    const elapsed = simTime - ndwWindowStartSim;
    if (elapsed >= 60) {
      let passes = 0;
      for (const v of ndwCounts.values()) passes += v;
      const vehH = (passes * 3600) / elapsed;
      ndwSimVehH = ndwSimVehH === 0 ? vehH : ndwSimVehH * 0.6 + vehH * 0.4;
      for (let i = 0; i < ndwOrder.length; i++) {
        const c = ndwCounts.get(ndwOrder[i]) ?? 0;
        const sVehH = (c * 3600) / elapsed;
        ndwStationFlow[i] = ndwStationFlow[i] === 0 ? sVehH : ndwStationFlow[i] * 0.6 + sVehH * 0.4;
      }
      for (const k of ndwCounts.keys()) ndwCounts.set(k, 0);
      ndwWindowStartSim = simTime;
    }
    let realTotal = 0;
    for (const f of ndwEdgeFlow.values()) realTotal += f;
    const demandNorm = demand(clockMin) / Math.max(0.05, demand(ndwTodMin));
    const realNow = realTotal * demandNorm;
    calibration = {
      stations: ndwStations,
      simVehH: Math.round(ndwSimVehH),
      realVehH: Math.round(realNow),
      ratio: realNow > 0 && ndwSimVehH > 0 ? ndwSimVehH / realNow : 0,
      demandNorm,
      stationFlows: Array.from(ndwStationFlow),
    };
  }

  const msg: MetricsMsg = {
    type: "metrics",
    simTime,
    clockMin,
    calibration,
    active: activeByMode[0],
    trucks: activeByMode[3],
    bikes: activeByMode[1],
    walkers: activeByMode[2],
    completed,
    throughputMin: thr,
    avgSpeedKmh: roadAgents > 0 ? (vSum / roadAgents) * 3.6 : 0,
    queued,
    avgWaitSec: avgWait,
    congestionIndex: congN ? congSum / congN : 0,
    greensNow: greens,
    incidents: incidents.length,
    incidentPts: incidents.map((i) => ({ x: i.x, y: i.y })),
    districts: dists,
  };
  post(msg);
}

// ---------------- main loop ----------------
let lastTick = performance.now();
function tick() {
  const now = performance.now();
  const real = Math.min(0.12, (now - lastTick) / 1000);
  lastTick = now;
  if (!running) return;

  let dt = real * simSpeed;
  clockMin = (clockMin + (real * CLOCK_RATE * simSpeed) / 60) % 1440;

  // larger substeps at high physics rates keep 12k+ agents affordable
  const maxStep = simSpeed >= 4 ? 0.1 : 0.055;
  while (dt > 0) {
    const h = Math.min(maxStep, dt);
    simTime += h;
    updateSignals(h);
    stepVehicles(h);
    dt -= h;
  }

  for (let e = 0; e < G.edges.count; e++) {
    if (edgeVN[e] > 0) {
      const ratio = edgeVSum[e] / edgeVN[e];
      const cong = 1 - Math.min(1, ratio * 1.25);
      edgeCong[e] = edgeCong[e] * 0.99 + cong * 0.01;
      edgeVSum[e] = 0;
      edgeVN[e] = 0;
    } else {
      edgeCong[e] *= 0.9995;
    }
  }

  // spawning toward per-mode targets
  const dm = demand(clockMin);
  const targets = [
    Math.round(targetDensity * dm),
    Math.round(targetDensity * 0.42 * dm),
    Math.round(targetDensity * 0.34 * (0.35 + 0.65 * dm)),
  ];
  for (let mode = 0; mode < MODES; mode++) {
    const have = mode === 0 ? activeByMode[0] + activeByMode[3] : activeByMode[mode];
    const deficit = targets[mode] - have;
    const spawns = Math.min(mode === 0 ? 7 : 5, Math.max(0, Math.ceil(deficit * 0.02)));
    for (let i = 0; i < spawns; i++) spawn(mode);
  }

  // scenario burst spawns (stadium egress / freight surge)
  if (burst) {
    for (let i = 0; i < 8 && burst.carsLeft > 0; i++) {
      if (burst.edges.length === 0) break;
      spawn(0, burst.edges[Math.floor(Math.random() * burst.edges.length)], burst.truckChance);
      burst.carsLeft--;
    }
    for (let i = 0; i < 12 && burst.walkLeft > 0; i++) {
      if (burst.walkEdges.length === 0) break;
      spawn(2, burst.walkEdges[Math.floor(Math.random() * burst.walkEdges.length)]);
      burst.walkLeft--;
    }
    if (burst.carsLeft <= 0 && burst.walkLeft <= 0) burst = null;
  }
  if (scenario && simTime > scenario.until) {
    const kind = scenario.kind;
    clearScenario(false);
    post({ type: "event", level: "ok", text: `SCENARIO ${kind.toUpperCase()} CONCLUDED — NETWORK RESTORED` });
  }

  maybeInject();

  // frame out
  const total = activeByMode[0] + activeByMode[1] + activeByMode[2];
  const vbuf = new Float32Array(total * 4);
  const ibuf = new Int32Array(total);
  const spbuf = new Float32Array(total);
  let vi = 0;
  for (let id = 0; id < MAXV && vi < total; id++) {
    if (!vAlive[id]) continue;
    const d = vEdge[id];
    const e = d >> 1;
    const backward = (d & 1) === 1;
    const off = G.edges.geoOff[e];
    const n = G.edges.geoCount[e];
    const target = backward ? dLen[d] - vS[id] : vS[id];
    let x = G.geo[off * 2], y = G.geo[off * 2 + 1];
    let hx = 1, hy = 0;
    let acc = 0;
    for (let k = 0; k < n - 1; k++) {
      const x1 = G.geo[(off + k) * 2], y1 = G.geo[(off + k) * 2 + 1];
      const x2 = G.geo[(off + k + 1) * 2], y2 = G.geo[(off + k + 1) * 2 + 1];
      const segLen = Math.hypot(x2 - x1, y2 - y1);
      if (acc + segLen >= target || k === n - 2) {
        const t = segLen > 0 ? Math.max(0, Math.min(1, (target - acc) / segLen)) : 0;
        x = x1 + (x2 - x1) * t;
        y = y1 + (y2 - y1) * t;
        hx = x2 - x1; hy = y2 - y1;
        break;
      }
      acc += segLen;
    }
    if (backward) { hx = -hx; hy = -hy; }
    const mode = vMode[id];
    const hl = Math.hypot(hx, hy) || 1;
    // lane offset right of travel: cars centered in lane, bikes at the curb,
    // pedestrians on the sidewalk side
    const lane = mode === 0 || mode === 3 ? 1.65 : mode === 1 ? 2.9 : 0.9;
    const ox = (hy / hl) * lane;
    const oy = (-hx / hl) * lane;
    const tunnel = (G.edges.flags[e] & 2) !== 0;
    vbuf[vi * 4] = x + ox;
    vbuf[vi * 4 + 1] = y + oy;
    vbuf[vi * 4 + 2] = Math.atan2(hy, hx);
    vbuf[vi * 4 + 3] = Math.min(1, vV[id] / Math.max(mode === 2 ? 1.6 : 3, modeSpeed(d, mode))) + (tunnel ? 2 : 0) + mode * 4;
    ibuf[vi] = id;
    spbuf[vi] = vV[id];
    vi++;
  }
  const sbuf = sigState.slice();
  post(
    { type: "frame", vehicles: vbuf.buffer, ids: ibuf.buffer, speeds: spbuf.buffer, count: vi, signals: sbuf.buffer, clockMin },
    [vbuf.buffer, ibuf.buffer, spbuf.buffer, sbuf.buffer]
  );

  if (now - lastMetrics > 1500) {
    lastMetrics = now;
    sendMetrics();
  }
  // fast cadence while the overlay is visible; slow heartbeat always (feeds
  // the history recorder on the main thread)
  if (now - lastCong > (congestionFeed ? 2000 : 10000)) {
    lastCong = now;
    const c = edgeCong.slice();
    post({ type: "congestion", perEdge: c.buffer }, [c.buffer]);
  }
}

self.onmessage = (ev: MessageEvent<MainToWorker>) => {
  const msg = ev.data;
  if (msg.type === "init") {
    districtCount = msg.districtCount;
    districtInfo = msg.districts ?? [];
    init(msg.graphBuffer);
    setInterval(tick, 33);
  } else if (msg.type === "params") {
    if (msg.density !== undefined) targetDensity = msg.density;
    if (msg.simSpeed !== undefined) simSpeed = msg.simSpeed;
    if (msg.cycleScale !== undefined) cycleScale = msg.cycleScale;
    if (msg.signalProgram !== undefined) signalProgram = msg.signalProgram;
    if (msg.running !== undefined) { running = msg.running; lastTick = performance.now(); }
    if (msg.congestionFeed !== undefined) congestionFeed = msg.congestionFeed;
    if (msg.autoIncidents !== undefined) autoIncidents = msg.autoIncidents;
    if (msg.timeOfDayMin !== undefined) clockMin = msg.timeOfDayMin;
    if (msg.speedFactor !== undefined) weatherFactor = Math.min(1, Math.max(0.7, msg.speedFactor));
  } else if (msg.type === "liveBridges") {
    const next = new Map<string, number[]>();
    for (const b of msg.bridges) {
      const ds: number[] = [];
      for (const e of b.edges) {
        if (e < 0 || e >= G.edges.count) continue;
        ds.push(e * 2);
        if (dExists[e * 2 + 1]) ds.push(e * 2 + 1);
      }
      if (ds.length) next.set(b.name, ds);
    }
    for (const [name, ds] of liveBridges) {
      if (next.has(name)) continue;
      for (const d of ds) dBlocked[d] = 0;
      post({ type: "event", level: "ok", text: `${name.toUpperCase()} DECK DOWN — SPAN REOPENED TO ROAD TRAFFIC` });
    }
    for (const [name, ds] of next) {
      if (liveBridges.has(name)) continue;
      for (const d of ds) dBlocked[d] = 1;
      post({ type: "event", level: "crit", text: `${name.toUpperCase()} OPEN FOR SHIPPING (LIVE NDW) — SPAN CLOSED, TRACKS REROUTING` });
    }
    liveBridges.clear();
    for (const [name, ds] of next) liveBridges.set(name, ds);
  } else if (msg.type === "liveIncidents") {
    const KINDLBL = ["TRAFFIC ACCIDENT", "OBSTRUCTION", "CONGESTION", "ROAD CLOSURE", "ROADWORKS"];
    const SLOW = [0.35, 0.55, 1, 1, 0.6]; // capacity left per kind (3 severs instead)
    const next = new Set<string>();
    for (const inc of msg.incidents) {
      if (inc.kind === 2 || inc.edge < 0 || inc.edge >= G.edges.count) continue; // jams are display-only
      const key = `${inc.edge}:${inc.kind}`;
      next.add(key);
      if (liveIncidents.has(key)) continue;
      const entry: { blocked: number[]; slowed: { d: number; orig: number }[] } = { blocked: [], slowed: [] };
      for (const d of [inc.edge * 2, inc.edge * 2 + 1]) {
        if (!dExists[d]) continue;
        if (inc.kind === 3) {
          dBlocked[d] = 1;
          entry.blocked.push(d);
        } else {
          entry.slowed.push({ d, orig: dSpeed[d] });
          dSpeed[d] = dSpeed[d] * (SLOW[inc.kind] ?? 0.6);
        }
      }
      liveIncidents.set(key, entry);
      const where = inc.name && inc.name !== "MOTORWAY SEGMENT" ? inc.name.toUpperCase() : zoneName(inc.x, inc.y);
      post({
        type: "event",
        level: inc.kind === 0 ? "crit" : "warn",
        text: `${KINDLBL[inc.kind] ?? "INCIDENT"} (LIVE NDW) — ${where}${inc.kind === 3 ? ", SEGMENT SEVERED" : inc.kind === 4 ? ", LANES CLOSED" : ", CAPACITY REDUCED"}`,
      });
    }
    for (const [key, entry] of liveIncidents) {
      if (next.has(key)) continue;
      for (const d of entry.blocked) dBlocked[d] = 0;
      for (const { d, orig } of entry.slowed) dSpeed[d] = orig;
      liveIncidents.delete(key);
      post({ type: "event", level: "ok", text: "LIVE INCIDENT CLEARED — SEGMENT RESTORED" });
    }
  } else if (msg.type === "ndw") {
    ndwEdgeFlow = new Map();
    ndwCounts = new Map();
    ndwOrder = new Int32Array(msg.stations.length).fill(-1);
    ndwStationFlow = new Float32Array(msg.stations.length);
    msg.stations.forEach((s, i) => {
      if (s.edge >= 0 && s.edge < G.edges.count) {
        ndwEdgeFlow!.set(s.edge, s.flow);
        ndwCounts!.set(s.edge, 0);
        ndwOrder![i] = s.edge;
      }
    });
    ndwStations = ndwEdgeFlow.size;
    ndwTodMin = msg.todMin;
    ndwWindowStartSim = simTime;
    ndwSimVehH = 0;
    post({
      type: "event",
      level: msg.live ? "info" : "ok",
      text: msg.live
        ? `LIVE NDW REFRESH — ${ndwStations} STATIONS UPDATED FROM THE MINUTELY FEED`
        : `NDW SENSOR NET ONLINE — ${ndwStations} STATIONS FEEDING THE CALIBRATION LOOP`,
    });
  } else if (msg.type === "scenario") {
    if (msg.kind === "clear") clearScenario(true);
    else startScenario(msg.kind);
  } else if (msg.type === "incident") {
    if (msg.action === "random") injectIncident();
    else {
      for (const inc of incidents) {
        dBlocked[inc.dEdge] = 0;
        if (dExists[inc.dEdge ^ 1]) dBlocked[inc.dEdge ^ 1] = 0;
      }
      incidents.length = 0;
      post({ type: "event", level: "ok", text: "ALL INCIDENTS CLEARED BY OPERATOR" });
    }
  }
};

export {};
