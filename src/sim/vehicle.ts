import type { EdgeId, Network } from "./types";
import type { TrafficLightController } from "./trafficLight";

let nextId = 0;

export interface Vehicle {
  id: number;
  edge: EdgeId;
  s: number; // distance along current edge in meters
  v: number; // speed in m/s
  length: number; // car length in meters
  // Routing: precomputed list of edges from spawn to exit.
  route: EdgeId[];
  routeIdx: number;
  spawnTime: number;
  totalWait: number; // accumulated seconds with v < waitThreshold
  done: boolean;
}

// Intelligent Driver Model parameters — see Treiber 2000.
const IDM = {
  v0Default: 13.9, // desired speed (m/s)
  T: 1.4, // safe time headway (s)
  a: 1.6, // max accel (m/s^2)
  b: 2.2, // comfortable decel (m/s^2)
  s0: 2.0, // minimum spacing (m)
  delta: 4,
};

const STOP_DECEL = 4.0; // m/s^2 used when approaching a red light
const WAIT_SPEED_THRESHOLD = 0.5; // m/s — below this, the car is "waiting"

export function makeVehicle(route: EdgeId[], spawnTime: number, edgeStartV: number): Vehicle {
  return {
    id: nextId++,
    edge: route[0],
    s: 0,
    v: edgeStartV,
    length: 4.5,
    route,
    routeIdx: 0,
    spawnTime,
    totalWait: 0,
    done: false,
  };
}

// Builds a random route from an entry node, taking random turns at each intersection,
// terminating at the first exit reachable.
export function randomRouteFrom(net: Network, entryId: string, rng: () => number): EdgeId[] {
  const route: EdgeId[] = [];
  // The entry node has exactly one outgoing edge (to its intersection).
  const startEdges = [...net.edges.values()].filter((e) => e.from === entryId);
  if (startEdges.length === 0) return route;
  let edge = startEdges[0];
  route.push(edge.id);

  const maxHops = 64;
  for (let i = 0; i < maxHops; i++) {
    const next = net.nodes.get(edge.to)!;
    if (next.kind === "exit") return route;
    if (next.kind === "entry") return route; // shouldn't happen but safe
    // At intersection, prefer outgoing edges that don't lead immediately to an exit
    // unless we've travelled enough — actually for v1, randomly choose any outgoing.
    if (edge.outgoing.length === 0) return route;
    const chosenId = edge.outgoing[Math.floor(rng() * edge.outgoing.length)];
    edge = net.edges.get(chosenId)!;
    route.push(edge.id);
  }
  return route;
}

export interface SimStepOutput {
  completed: number;
  totalWaitOfCompleted: number;
}

// Advances all vehicles by `dt` seconds. Updates positions, handles light gating, removes completed.
// `lightsByEdge` lets the renderer share state with the controller without double computation.
export function stepVehicles(
  vehicles: Vehicle[],
  net: Network,
  lights: TrafficLightController,
  simTime: number,
  dt: number,
): SimStepOutput {
  // Sort vehicles by edge then by s descending so the leader is first — needed for IDM.
  const byEdge = new Map<EdgeId, Vehicle[]>();
  for (const v of vehicles) {
    if (v.done) continue;
    let arr = byEdge.get(v.edge);
    if (!arr) {
      arr = [];
      byEdge.set(v.edge, arr);
    }
    arr.push(v);
  }
  for (const arr of byEdge.values()) arr.sort((a, b) => b.s - a.s);

  let completed = 0;
  let totalWaitOfCompleted = 0;

  for (const [edgeId, arr] of byEdge) {
    const edge = net.edges.get(edgeId)!;
    for (let i = 0; i < arr.length; i++) {
      const veh = arr[i];
      const leader = i > 0 ? arr[i - 1] : null;

      // Distance to the obstacle ahead: either the leader's bumper, or the stop line if the
      // light at the end of the edge is red/yellow and the next node is an intersection.
      let gap = Infinity;
      let leaderV = veh.v;
      if (leader) {
        gap = leader.s - leader.length - veh.s;
        leaderV = leader.v;
      }

      const distToEnd = edge.length - veh.s;
      const downstream = net.nodes.get(edge.to)!;
      let stopGap = Infinity;
      if (downstream.kind === "intersection") {
        const color = lights.colorFor(simTime, edge.to, edge.id);
        if (color === "red") {
          stopGap = distToEnd;
        } else if (color === "yellow") {
          // Treat yellow as "stop if you can comfortably". Only stop if more than ~2s away.
          const timeToStop = veh.v / STOP_DECEL;
          if (distToEnd > veh.v * timeToStop) stopGap = distToEnd;
        }
      }
      const obstacleGap = Math.min(gap, stopGap);
      const obstacleV = stopGap < gap ? 0 : leaderV;

      // IDM acceleration.
      const v0 = edge.speedLimit || IDM.v0Default;
      const dv = veh.v - obstacleV;
      const sStar =
        IDM.s0 + Math.max(0, veh.v * IDM.T + (veh.v * dv) / (2 * Math.sqrt(IDM.a * IDM.b)));
      const safeGap = Math.max(0.1, obstacleGap);
      const accel =
        IDM.a *
        (1 - Math.pow(veh.v / v0, IDM.delta) - Math.pow(sStar / safeGap, 2));
      const aClamped = Math.max(-IDM.b * 2, Math.min(IDM.a, accel));

      veh.v = Math.max(0, veh.v + aClamped * dt);
      veh.s = veh.s + veh.v * dt;
      if (veh.v < WAIT_SPEED_THRESHOLD) veh.totalWait += dt;

      // Edge transition: hop to next edge in route or finish.
      while (veh.s >= edge.length && !veh.done) {
        const overflow = veh.s - edge.length;
        veh.routeIdx++;
        if (veh.routeIdx >= veh.route.length) {
          veh.done = true;
          completed++;
          totalWaitOfCompleted += veh.totalWait;
          break;
        }
        veh.edge = veh.route[veh.routeIdx];
        veh.s = overflow;
        // Rebind `edge` so a long dt that crosses two short stubs still terminates correctly.
        const nextEdge = net.edges.get(veh.edge)!;
        if (overflow < nextEdge.length) break;
      }
    }
  }

  return { completed, totalWaitOfCompleted };
}
