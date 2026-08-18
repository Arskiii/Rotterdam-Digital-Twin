// Traffic simulation engine — runs the whole city in a web worker.
//
// Model: per-directed-edge FIFO lanes, IDM car-following, fixed-time signal
// controllers per clustered intersection, A* routing over the strongly
// connected core, time-of-day demand, random incidents with rerouting.

import { parseGraph, type Graph } from "../data/loader";
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
let dTarget: Int32Array; // target node
let dSource: Int32Array;
let dLen: Float32Array;
let dSpeed: Float32Array; // free-flow m/s
let dExists: Uint8Array;
let dBlocked: Uint8Array; // incident
// adjacency CSR over directed edges by source node
let outOff: Uint32Array;
let outList: Uint32Array;
// per-node signal index (net signals sit on their own graph nodes)
let nodeSignal: Int32Array;
// queues: per directed edge intrusive FIFO
let qHead: Int32Array;
let qTail: Int32Array;
// per-edge congestion EMA (undirected)
let edgeCong: Float32Array;
let edgeVSum: Float32Array;
let edgeVN: Uint16Array;

// signal state per head (net + aux), plus per-cluster phase
let sigState: Uint8Array;
let clusterFault: Float32Array; // >simTime ⇒ faulted (all red)

// vehicles (SoA)
const MAXV = 14000;
const V_LEN = 4.8;
let vAlive: Uint8Array;
let vEdge: Int32Array; // directed edge
let vS: Float32Array;
let vV: Float32Array;
let vV0f: Float32Array; // personality factor
let vAhead: Int32Array;
let vBehind: Int32Array;
let vWait: Float32Array; // accumulated stopped time
let vRouteIdx: Int32Array;
const vRoutes: Int32Array[] = [];
let freeList: number[] = [];
let activeCount = 0;

// params
let targetDensity = 5200;
let simSpeed = 1;
let cycleScale = 1;
let running = true;
let congestionFeed = false;
let autoIncidents = true;

// clocks
let simTime = 0; // seconds
let clockMin = 8 * 60 + 12; // start 08:12 — morning peak
const CLOCK_RATE = 72; // day passes in 20 real minutes
let completed = 0;
let completedLog: { t: number; wait: number }[] = [];
const incidents: { dEdge: number; until: number; x: number; y: number }[] = [];

// IDM
const IDM_A = 1.7;
const IDM_B = 2.4;
const IDM_T = 1.15;
const IDM_S0 = 2.1;

// ---------------- init ----------------
function init(buf: ArrayBuffer) {
  G = parseGraph(buf);
  const E = G.edges.count;
  const N = G.nodeCount;

  dTarget = new Int32Array(E * 2).fill(-1);
  dSource = new Int32Array(E * 2).fill(-1);
  dLen = new Float32Array(E * 2);
  dSpeed = new Float32Array(E * 2);
  dExists = new Uint8Array(E * 2);
  dBlocked = new Uint8Array(E * 2);
  qHead = new Int32Array(E * 2).fill(-1);
  qTail = new Int32Array(E * 2).fill(-1);
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

  // spawn weights per directed edge by class
  buildSpawnTable();

  let laneKm = 0;
  for (let d = 0; d < E * 2; d++) if (dExists[d]) laneKm += dLen[d] / 1000;
  post({ type: "ready", edgeCount: E, laneKm: Math.round(laneKm) });
}

// weighted spawn sampling
let spawnEdges: Int32Array;
let spawnCum: Float64Array;
function buildSpawnTable() {
  const CLASS_W = [3.2, 2.6, 2.2, 1.7, 1.3, 0.7];
  const list: number[] = [];
  const w: number[] = [];
  for (let d = 0; d < dTarget.length; d++) {
    if (!dExists[d]) continue;
    const e = d >> 1;
    if (!G.inCore[G.edges.a[e]] || !G.inCore[G.edges.b[e]]) continue;
    if (dLen[d] < 30) continue;
    list.push(d);
    w.push(CLASS_W[G.edges.cls[e]] * Math.min(400, dLen[d]));
  }
  spawnEdges = Int32Array.from(list);
  spawnCum = new Float64Array(w.length);
  let acc = 0;
  for (let i = 0; i < w.length; i++) { acc += w[i]; spawnCum[i] = acc; }
}
function sampleSpawnEdge(): number {
  const r = Math.random() * spawnCum[spawnCum.length - 1];
  let lo = 0, hi = spawnCum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (spawnCum[mid] < r) lo = mid + 1;
    else hi = mid;
  }
  return spawnEdges[lo];
}

// ---------------- A* routing ----------------
const ROUTE_LIMIT = 26000;
let astarDist: Float32Array;
let astarFrom: Int32Array;
let astarSeen: Int32Array;
let astarStamp = 0;
let heapN: Int32Array;
let heapD: Float32Array;

function route(fromEdge: number, toEdge: number): Int32Array | null {
  if (!astarDist) {
    astarDist = new Float32Array(G.nodeCount);
    astarFrom = new Int32Array(G.nodeCount);
    astarSeen = new Int32Array(G.nodeCount);
    heapN = new Int32Array(1 << 16);
    heapD = new Float32Array(1 << 16);
  }
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
  const hFn = (n: number) => {
    const dx = G.nodesXY[n * 2] - gx, dy = G.nodesXY[n * 2 + 1] - gy;
    return Math.hypot(dx, dy) / 27; // admissible: max speed ~97 km/h
  };
  astarSeen[start] = astarStamp;
  astarDist[start] = 0;
  astarFrom[start] = -1;
  push(start, hFn(start));
  let expansions = 0;
  while (hn > 0 && expansions++ < ROUTE_LIMIT) {
    const node = pop();
    if (node === goal) {
      // reconstruct
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
      if (dBlocked[d]) continue;
      const nx = dTarget[d];
      const cost = dLen[d] / dSpeed[d] + (nodeSignal[dTarget[d]] >= 0 ? 9 : 0) + 1.2;
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

// ---------------- vehicles ----------------
function enqueue(veh: number, d: number) {
  vAhead[veh] = qTail[d];
  vBehind[veh] = -1;
  if (qTail[d] >= 0) vBehind[qTail[d]] = veh;
  else qHead[d] = veh;
  qTail[d] = veh;
}
function dequeueHead(d: number) {
  const h = qHead[d];
  if (h < 0) return;
  const nb = vBehind[h];
  qHead[d] = nb;
  if (nb >= 0) vAhead[nb] = -1;
  else qTail[d] = -1;
  vAhead[h] = -1;
  vBehind[h] = -1;
}

function spawn() {
  if (freeList.length === 0) return;
  for (let tries = 0; tries < 4; tries++) {
    const a = sampleSpawnEdge();
    // 65% local trips (0.8–6 km), 35% anywhere in the metro
    let b = sampleSpawnEdge();
    if (Math.random() < 0.65) {
      const ax = G.nodesXY[dSource[a] * 2], ay = G.nodesXY[dSource[a] * 2 + 1];
      for (let k = 0; k < 10; k++) {
        const cand = sampleSpawnEdge();
        const cx = G.nodesXY[dSource[cand] * 2], cy = G.nodesXY[dSource[cand] * 2 + 1];
        const dd = Math.hypot(cx - ax, cy - ay);
        if (dd > 800 && dd < 6000) { b = cand; break; }
      }
    }
    if ((a >> 1) === (b >> 1)) continue;
    const r = route(a, b);
    if (!r || r.length < 3) continue;
    const id = freeList.pop()!;
    vRoutes[id] = r;
    vRouteIdx[id] = 0;
    vEdge[id] = a;
    vS[id] = Math.min(8, dLen[a] * 0.3);
    vV[id] = Math.min(dSpeed[a], 8);
    vV0f[id] = 0.88 + Math.random() * 0.27;
    vWait[id] = 0;
    vAlive[id] = 1;
    // only enter if the tail of that edge is far enough in
    const tail = qTail[a];
    if (tail >= 0 && vS[tail] < vS[id] + V_LEN + 2) {
      vAlive[id] = 0;
      freeList.push(id);
      return;
    }
    enqueue(id, a);
    activeCount++;
    return;
  }
}

function despawn(id: number, finished: boolean) {
  const d = vEdge[id];
  const ah = vAhead[id], bh = vBehind[id];
  if (ah >= 0) vBehind[ah] = bh;
  else qHead[d] = bh;
  if (bh >= 0) vAhead[bh] = ah;
  else qTail[d] = ah;
  vAhead[id] = -1;
  vBehind[id] = -1;
  vAlive[id] = 0;
  freeList.push(id);
  activeCount--;
  if (finished) {
    completed++;
    completedLog.push({ t: simTime, wait: vWait[id] });
  }
}

// signal state for the head of directed edge d (state at its target node)
// returns 0 red, 1 amber, 2 green, 3 none
function signalAt(d: number): number {
  const sig = nodeSignal[dTarget[d]];
  if (sig < 0) return 3;
  return sigState[sig];
}

function updateSignals() {
  const C = G.clusters;
  for (let c = 0; c < C.count; c++) {
    const cyc = Math.max(24, C.cycle[c] * cycleScale);
    const t = (simTime + C.offset[c]) % cyc;
    const faulted = clusterFault[c] > simTime;
    let stateA: number, stateB: number;
    if (faulted) {
      stateA = stateB = 0;
    } else if (C.crossing[c]) {
      // pedestrian crossing: mostly green, short red window
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
    (C as unknown as { _a?: number[] })._a ??= [];
    const cache = (C as unknown as { _a: number[] })._a;
    cache[c * 2] = stateA;
    cache[c * 2 + 1] = stateB;
  }
  const cache = (G.clusters as unknown as { _a: number[] })._a;
  for (let s = 0; s < G.signals.count; s++) {
    sigState[s] = cache[G.signals.cluster[s] * 2 + G.signals.phase[s]];
  }
  for (let i = 0; i < G.aux.count; i++) {
    const c = G.aux.cluster[i];
    sigState[G.signals.count + i] = c < 0 ? 2 : cache[c * 2 + G.aux.phase[i]];
  }
}

function idmAccel(v: number, v0: number, gap: number, dv: number): number {
  const sStar = IDM_S0 + Math.max(0, v * IDM_T + (v * dv) / (2 * Math.sqrt(IDM_A * IDM_B)));
  const free = Math.pow(v / Math.max(0.5, v0), 4);
  return IDM_A * (1 - free - (sStar / Math.max(0.5, gap)) ** 2);
}

function stepVehicles(dt: number) {
  for (let id = 0; id < MAXV; id++) {
    if (!vAlive[id]) continue;
    const d = vEdge[id];
    const len = dLen[d];
    const e = d >> 1;
    let v0 = dSpeed[d] * vV0f[id];
    const s = vS[id];
    const v = vV[id];

    // approach slowdown for the turn at the end of the edge
    const remain = len - s;
    if (remain < 34) {
      const turnV = 7.5;
      v0 = Math.min(v0, turnV + (remain / 34) * (v0 - turnV) * 0.5 + turnV);
    }

    // find constraint: leader on same edge, else edge end (signal/queue on next)
    let gap = 1e9;
    let dv = 0;
    const ahead = vAhead[id];
    if (ahead >= 0) {
      gap = vS[ahead] - s - V_LEN;
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
        if (dBlocked[next]) mustStop = true;
        else {
          const tail = qTail[next];
          if (tail >= 0) {
            const g2 = remain + vS[tail] - V_LEN;
            if (g2 < gap) { gap = g2; dv = v - vV[tail]; }
          }
        }
      }
      if (mustStop) { gap = Math.min(gap, stopGap); dv = v; }
    }

    let a = idmAccel(v, v0, gap, dv);
    a = Math.max(-7.5, Math.min(IDM_A, a));
    let nv = Math.max(0, v + a * dt);
    let ns = s + nv * dt;

    if (nv < 0.35) {
      vWait[id] += dt;
      nv = Math.max(0, nv);
    }

    // advance to next edge
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
      const tail = next >= 0 ? qTail[next] : -1;
      const room = tail < 0 || vS[tail] > V_LEN + 1.5;
      if (canGo && next >= 0 && !dBlocked[next] && room) {
        dequeueHead(d);
        vEdge[id] = next;
        vRouteIdx[id] = rIdx + 1;
        ns = Math.max(0, ns - len);
        vS[id] = Math.min(ns, Math.max(0.5, (tail >= 0 ? vS[tail] - V_LEN - 1.2 : dLen[next])));
        enqueue(id, next);
        vV[id] = nv;
        continue;
      } else if (next >= 0 && dBlocked[next] && vV[id] < 1) {
        // reroute around incident
        const dest = routeArr[routeArr.length - 1];
        const r = route(d, dest);
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
    // congestion accumulation on undirected edge
    edgeVSum[e] += nv / Math.max(1, dSpeed[d]);
    edgeVN[e] = Math.min(65000, edgeVN[e] + 1);
  }
}

// demand curve: fraction of peak by time of day
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
    const d = sampleSpawnEdge();
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
    if (!vAlive[id]) continue;
    const e = vEdge[id] >> 1;
    const di = G.edges.district[e];
    distAgg.veh[di]++;
    distAgg.spd[di] += vV[id];
    vSum += vV[id];
    if (vV[id] < 0.5) { queued++; distAgg.q[di]++; }
  }
  for (let e = 0; e < G.edges.count; e++) {
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
  // rolling completed window
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
  const msg: MetricsMsg = {
    type: "metrics",
    simTime,
    clockMin,
    active: activeCount,
    completed,
    throughputMin: thr,
    avgSpeedKmh: activeCount > 0 ? (vSum / activeCount) * 3.6 : 0,
    queued,
    avgWaitSec: avgWait,
    congestionIndex: congN ? congSum / congN : 0,
    greensNow: greens,
    incidents: incidents.length,
    districts: dists,
  };
  post(msg);
}

// ---------------- main loop ----------------
let lastTick = performance.now();
function tick() {
  const now = performance.now();
  let real = Math.min(0.12, (now - lastTick) / 1000);
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

  // congestion EMA decay + fold-in
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

  // spawning toward target
  const want = Math.round(targetDensity * demand(clockMin));
  const deficit = want - activeCount;
  const spawns = Math.min(7, Math.max(0, Math.ceil(deficit * 0.02)));
  for (let i = 0; i < spawns; i++) spawn();
  // over-target: let trips complete naturally

  maybeInject();

  // frame out
  const vbuf = new Float32Array(activeCount * 4);
  let vi = 0;
  for (let id = 0; id < MAXV && vi < activeCount; id++) {
    if (!vAlive[id]) continue;
    const d = vEdge[id];
    const e = d >> 1;
    const backward = (d & 1) === 1;
    const off = G.edges.geoOff[e];
    const n = G.edges.geoCount[e];
    // find position along polyline
    let target = backward ? dLen[d] - vS[id] : vS[id];
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
    // lane offset to the right of travel
    const hl = Math.hypot(hx, hy) || 1;
    const ox = (hy / hl) * 1.65;
    const oy = (-hx / hl) * 1.65;
    const tunnel = (G.edges.flags[e] & 2) !== 0;
    vbuf[vi * 4] = x + ox;
    vbuf[vi * 4 + 1] = y + oy;
    vbuf[vi * 4 + 2] = Math.atan2(hy, hx);
    vbuf[vi * 4 + 3] = Math.min(1, vV[id] / Math.max(3, dSpeed[d])) + (tunnel ? 2 : 0);
    vi++;
  }
  const sbuf = sigState.slice();
  post({ type: "frame", vehicles: vbuf.buffer, count: vi, signals: sbuf.buffer, clockMin }, [vbuf.buffer, sbuf.buffer]);

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
