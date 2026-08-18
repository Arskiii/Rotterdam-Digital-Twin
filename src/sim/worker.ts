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

// agents (SoA)
const MAXV = 22000;
const MODES = 3; // 0 car, 1 bike, 2 walk
const V_LEN = [4.8, 2.0, 0.6];
const IDM_A = [1.7, 1.4, 0];
const IDM_B = [2.4, 2.0, 0];
const IDM_T = [1.15, 0.9, 0];
const IDM_S0 = [2.1, 1.4, 0];
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
const activeByMode = [0, 0, 0];

// params
let targetDensity = 5200;
let simSpeed = 1;
let cycleScale = 1;
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

// per-mode free-flow speed on a directed edge
function modeSpeed(d: number, mode: number): number {
  if (mode === 0) return dSpeed[d];
  const cls = G.edges.cls[d >> 1];
  if (mode === 1) {
    if (cls === 8) return 5.6; // cycle track
    if (cls === 7) return 2.6; // pedestrian zone: crawl
    return 4.7;
  }
  return 1.38; // walk
}
const MODE_HEUR_SPEED = [27, 5.6, 1.6];

// ---------------- init ----------------
function init(buf: ArrayBuffer) {
  G = parseGraph(buf);
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

  nodeSignal = new Int32Array(N).fill(-1);
  for (let s = 0; s < G.signals.count; s++) nodeSignal[G.signals.nodeIdx[s]] = s;

  sigState = new Uint8Array(G.signals.count + G.aux.count).fill(3);
  clusterFault = new Float32Array(G.clusters.count);

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

  buildSpawnTables();

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

// ---------------- queues ----------------
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

function spawn(mode: number) {
  if (freeList.length === 0) return;
  for (let tries = 0; tries < 4; tries++) {
    const a = sampleSpawnEdge(mode);
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
    vMode[id] = mode;
    vEdge[id] = a;
    vS[id] = Math.min(8, dLen[a] * 0.3);
    vV[id] = Math.min(modeSpeed(a, mode), mode === 2 ? 1.4 : 8);
    vV0f[id] = mode === 2 ? 0.85 + Math.random() * 0.4 : 0.88 + Math.random() * 0.27;
    vWait[id] = 0;
    vAlive[id] = 1;
    if (mode !== 2) {
      const tail = qTail[qBase(mode) + a];
      if (tail >= 0 && vS[tail] < vS[id] + V_LEN[mode] + 2) {
        vAlive[id] = 0;
        freeList.push(id);
        return;
      }
      enqueue(id, a);
    } else {
      vAhead[id] = -1;
      vBehind[id] = -1;
    }
    activeByMode[mode]++;
    return;
  }
}

function despawn(id: number, finished: boolean) {
  if (vMode[id] !== 2) removeFromQueue(id);
  vAlive[id] = 0;
  freeList.push(id);
  activeByMode[vMode[id]]--;
  if (finished && vMode[id] === 0) {
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

function updateSignals() {
  const C = G.clusters;
  const cacheHolder = C as unknown as { _a?: number[] };
  cacheHolder._a ??= [];
  const cache = cacheHolder._a;
  for (let c = 0; c < C.count; c++) {
    const cyc = Math.max(24, C.cycle[c] * cycleScale);
    const t = (simTime + C.offset[c]) % cyc;
    const faulted = clusterFault[c] > simTime;
    let stateA: number, stateB: number;
    if (faulted) {
      stateA = stateB = 0;
    } else if (C.crossing[c]) {
      const red = t < 11;
      stateA = stateB = red ? 0 : t < 13 ? 1 : 2;
    } else {
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
    if (remain < 34 && mode === 0) {
      const turnV = 7.5;
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
        if (mode === 0 && dBlocked[next]) mustStop = true;
        else {
          const tail = qTail[qBase(mode) + next];
          if (tail >= 0) {
            const g2 = remain + vS[tail] - V_LEN[mode];
            if (g2 < gap) { gap = g2; dv = v - vV[tail]; }
          }
        }
      }
      if (mustStop) { gap = Math.min(gap, stopGap); dv = v; }
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
      if (canGo && next >= 0 && !(mode === 0 && dBlocked[next]) && room) {
        removeFromQueue(id);
        vEdge[id] = next;
        vRouteIdx[id] = rIdx + 1;
        ns = Math.max(0, ns - len);
        vS[id] = Math.min(ns, Math.max(0.5, tail >= 0 ? vS[tail] - V_LEN[mode] - 1.2 : dLen[next]));
        enqueue(id, next);
        vV[id] = nv;
        continue;
      } else if (mode === 0 && next >= 0 && dBlocked[next] && vV[id] < 1) {
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
    if (mode === 0) {
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

// ---------------- metrics ----------------
let lastMetrics = 0;
let lastCong = 0;
const distAgg = { veh: new Float32Array(32), spd: new Float32Array(32), q: new Float32Array(32), cong: new Float32Array(32), n: new Float32Array(32) };

function sendMetrics() {
  const dists: DistrictStat[] = [];
  distAgg.veh.fill(0); distAgg.spd.fill(0); distAgg.q.fill(0); distAgg.cong.fill(0); distAgg.n.fill(0);
  let vSum = 0, queued = 0;
  for (let id = 0; id < MAXV; id++) {
    if (!vAlive[id] || vMode[id] !== 0) continue;
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
  const carActive = activeByMode[0];
  const msg: MetricsMsg = {
    type: "metrics",
    simTime,
    clockMin,
    active: carActive,
    bikes: activeByMode[1],
    walkers: activeByMode[2],
    completed,
    throughputMin: thr,
    avgSpeedKmh: carActive > 0 ? (vSum / carActive) * 3.6 : 0,
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

  while (dt > 0) {
    const h = Math.min(0.055, dt);
    simTime += h;
    updateSignals();
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
    const deficit = targets[mode] - activeByMode[mode];
    const spawns = Math.min(mode === 0 ? 7 : 5, Math.max(0, Math.ceil(deficit * 0.02)));
    for (let i = 0; i < spawns; i++) spawn(mode);
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
    const lane = mode === 0 ? 1.65 : mode === 1 ? 2.9 : 0.9;
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
  if (congestionFeed && now - lastCong > 2000) {
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
    if (msg.running !== undefined) { running = msg.running; lastTick = performance.now(); }
    if (msg.congestionFeed !== undefined) congestionFeed = msg.congestionFeed;
    if (msg.autoIncidents !== undefined) autoIncidents = msg.autoIncidents;
    if (msg.timeOfDayMin !== undefined) clockMin = msg.timeOfDayMin;
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
