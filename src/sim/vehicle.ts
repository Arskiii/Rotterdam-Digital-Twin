import { chooseLaneForTurn, classifyTurn } from "./lanes";
import type { EdgeId, Network, NetworkEdge } from "./types";
import type { SignalController } from "./trafficLight";

let nextId = 0;

export interface Vehicle {
  id: number;
  edge: EdgeId;
  laneIdx: number; // 0 = rightmost lane on the current edge
  s: number; // distance along current edge in meters
  v: number; // speed in m/s
  length: number; // car length in meters
  // Routing: precomputed list of edges from spawn to exit.
  route: EdgeId[];
  routeIdx: number;
  spawnTime: number;
  totalWait: number; // accumulated seconds with v < WAIT_LOW
  stops: number; // number of times the vehicle came to a halt
  wasStopped: boolean; // hysteresis flag for the stops counter
  freeFlowTime: number; // sum(length / speedLimit) along route — denominator of delay ratio
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
// Hysteresis band for the stops counter: a car has to clearly resume motion
// (> WAIT_HIGH) before another stop (< WAIT_LOW) is counted, otherwise IDM
// jitter near 0.5 m/s would inflate the count.
const WAIT_LOW = 0.5;
const WAIT_HIGH = 2.0;

// Distance from the downstream intersection center back to the stop line.
// The intersection pad is ~9 m square, so 6 m keeps the front bumper safely
// outside the cross when stopped (renderer uses this to draw the line).
export const STOP_LINE_OFFSET = 6.0;

export function makeVehicle(
  route: EdgeId[],
  spawnTime: number,
  edgeStartV: number,
  freeFlowTime: number,
  laneIdx = 0,
): Vehicle {
  return {
    id: nextId++,
    edge: route[0],
    laneIdx,
    s: 0,
    v: edgeStartV,
    length: 4.5,
    route,
    routeIdx: 0,
    spawnTime,
    totalWait: 0,
    stops: 0,
    wasStopped: false,
    freeFlowTime,
    done: false,
  };
}

// Lane to use on `edge` given the upcoming turn at the END of `edge`. Looks two hops
// ahead in the route to know which way the vehicle will turn next; if there is no
// next-next edge (i.e. the current edge ends at an exit stub), no specific lane is
// preferred and we pick lane 0.
export function pickLaneOnEntry(
  net: Network,
  edge: NetworkEdge,
  route: EdgeId[],
  routeIdx: number,
): number {
  if (edge.laneCount <= 1) return 0;
  const nextEdgeId = route[routeIdx + 1];
  if (!nextEdgeId) return 0;
  const nextEdge = net.edges.get(nextEdgeId);
  if (!nextEdge) return 0;
  const turn = classifyTurn(edge, nextEdge);
  return chooseLaneForTurn(edge, turn);
}

// Find a route to a real exit. Randomize exploration order among equal-length options,
// but never count a dead end or a loop as a completed trip.
export function randomRouteFrom(net: Network, entryId: string, rng: () => number): EdgeId[] {
  const startEdges = [...net.edges.values()].filter((e) => e.from === entryId);
  if (startEdges.length === 0) return [];
  const queue = startEdges.map((edge) => edge.id);
  const startIds = new Set(queue);
  const parent = new Map<EdgeId, EdgeId | null>(queue.map((id) => [id, null]));
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    const edge = net.edges.get(id);
    if (!edge) continue;
    const node = net.nodes.get(edge.to);
    if (node?.kind === "exit") {
      const route: EdgeId[] = [];
      for (let current: EdgeId | null = id; current !== null; current = parent.get(current) ?? null) {
        route.push(current);
      }
      return route.reverse();
    }
    if (node?.kind !== "intersection") continue;
    const choices = edge.outgoing;
    const offset = Math.floor(rng() * choices.length);
    for (let j = 0; j < choices.length; j++) {
      const nextId = choices[(offset + j) % choices.length];
      const nextEdge = net.edges.get(nextId);
      if (parent.has(nextId) || !nextEdge) continue;
      // Boundary entry and exit stubs share a junction. Require at least one real
      // road segment before allowing an exit so cars cannot finish at spawn.
      if (startIds.has(id) && net.nodes.get(nextEdge.to)?.kind === "exit") continue;
      parent.set(nextId, id);
      queue.push(nextId);
    }
  }
  return [];
}

export interface CompletedStat {
  wait: number;
  stops: number;
  travelTime: number;
  freeFlowTime: number;
}

export interface SimStepOutput {
  completed: CompletedStat[];
}

// Advances all vehicles by `dt` seconds. Updates positions, handles light gating, removes completed.
// `lightsByEdge` lets the renderer share state with the controller without double computation.
export function stepVehicles(
  vehicles: Vehicle[],
  net: Network,
  lights: SignalController,
  simTime: number,
  dt: number,
): SimStepOutput {
  // Sort vehicles by (edge, lane) then by s descending so the leader within each lane is
  // first — needed for IDM. The key is "<edgeId>#<laneIdx>" so two cars in different
  // lanes of the same edge no longer car-follow each other; this is what unblocks
  // straight-through traffic when a left-turner is stopped at the front of the left lane.
  const byEdgeLane = new Map<string, Vehicle[]>();
  const initialState = new Map<number, { s: number; v: number }>();
  for (const v of vehicles) {
    if (v.done) continue;
    initialState.set(v.id, { s: v.s, v: v.v });
    const key = `${v.edge}#${v.laneIdx}`;
    let arr = byEdgeLane.get(key);
    if (!arr) {
      arr = [];
      byEdgeLane.set(key, arr);
    }
    arr.push(v);
  }
  for (const arr of byEdgeLane.values()) arr.sort((a, b) => b.s - a.s);

  const completed: CompletedStat[] = [];
  // Vehicles entering the same lane from different approaches must reserve space,
  // even when neither was on that lane at the beginning of this step.
  const enteredLanes = new Map<string, Vehicle[]>();

  for (const [, arr] of byEdgeLane) {
    if (arr.length === 0) continue;
    const edge = net.edges.get(arr[0].edge)!;
    for (let i = 0; i < arr.length; i++) {
      const veh = arr[i];
      const vehicleDt = Math.min(dt, Math.max(0, simTime - veh.spawnTime));
      if (vehicleDt === 0) continue;
      const leader = i > 0 ? arr[i - 1] : null;

      // Distance to the obstacle ahead: either the leader's bumper, or the stop line if the
      // light at the end of the edge is red/yellow and the next node is an intersection.
      let gap = Infinity;
      let leaderV = veh.v;
      if (leader) {
        // A leader may already have moved to the next edge during this loop. Its
        // new offset cannot be compared with a follower still on the old edge.
        const state = initialState.get(leader.id)!;
        gap = state.s - leader.length - veh.s;
        leaderV = state.v;
      }

      let stopGap = Infinity;
      let distanceToStart = -veh.s;
      const lookahead = Math.max(100, veh.v * veh.v / (2 * STOP_DECEL) + IDM.s0);
      // OSM streets often consist of many short geometry segments. Look through
      // those segments so a downstream queue or signal is visible before entry.
      for (let routeIdx = veh.routeIdx; routeIdx < veh.route.length; routeIdx++) {
        const ahead = net.edges.get(veh.route[routeIdx]);
        if (!ahead || distanceToStart > lookahead) break;
        if (routeIdx > veh.routeIdx) {
          const lane = pickLaneOnEntry(net, ahead, veh.route, routeIdx);
          const occupants = byEdgeLane.get(`${ahead.id}#${lane}`);
          const tail = occupants?.at(-1);
          if (tail && tail.id !== veh.id) {
            const state = initialState.get(tail.id)!;
            const downstreamGap = distanceToStart + state.s - tail.length;
            if (downstreamGap < gap) {
              gap = downstreamGap;
              leaderV = state.v;
            }
          }
        }
        const downstream = net.nodes.get(ahead.to);
        const stopLine = Math.max(0, ahead.length - STOP_LINE_OFFSET);
        const distanceToStop = distanceToStart + stopLine;
        // A vehicle that has already crossed the stop line must clear the junction.
        if (downstream?.kind === "intersection" && distanceToStop >= 0) {
          const color = lights.colorFor(simTime, ahead.to, ahead.id);
          const brakingDistance = veh.v * veh.v / (2 * STOP_DECEL);
          if (color === "red" || (color === "yellow" && distanceToStop >= brakingDistance)) {
            stopGap = Math.min(stopGap, distanceToStop);
          }
        }
        distanceToStart += ahead.length;
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

      veh.v = Math.max(0, veh.v + aClamped * vehicleDt);
      const movement = veh.v * vehicleDt;
      // Bounded braking alone cannot prevent penetration when an obstacle is very
      // close. Enforce a positional bound as well, without moving cars backwards.
      if (movement > Math.max(0, obstacleGap)) {
        veh.s += Math.max(0, obstacleGap);
        veh.v = 0;
      } else {
        veh.s += movement;
      }

      // Edge transition: hop to next edge in route or finish. On entry to the new edge
      // we pick a lane that supports the upcoming turn — left-turners head for the left
      // lane, right-turners for the right, so they don't block straight-through traffic.
      let transitionEdge = edge;
      while (veh.s >= transitionEdge.length && !veh.done) {
        const overflow = veh.s - transitionEdge.length;
        const nextRouteIdx = veh.routeIdx + 1;
        if (nextRouteIdx >= veh.route.length) {
          veh.routeIdx = nextRouteIdx;
          veh.done = true;
          break;
        }
        const nextEdge = net.edges.get(veh.route[nextRouteIdx])!;
        const nextLane = pickLaneOnEntry(net, nextEdge, veh.route, nextRouteIdx);
        const laneKey = `${nextEdge.id}#${nextLane}`;
        const arrivals = enteredLanes.get(laneKey) ?? [];
        if (arrivals.some((other) => !other.done && other.edge === nextEdge.id &&
            other.s - other.length - IDM.s0 < overflow)) {
          veh.s = Math.max(0, transitionEdge.length - 0.001);
          veh.v = 0;
          break;
        }
        veh.routeIdx = nextRouteIdx;
        veh.edge = nextEdge.id;
        veh.s = overflow;
        veh.laneIdx = nextLane;
        arrivals.push(veh);
        enteredLanes.set(laneKey, arrivals);
        transitionEdge = nextEdge;
      }
      if (veh.v < WAIT_LOW) {
        veh.totalWait += vehicleDt;
        if (!veh.wasStopped) {
          veh.stops++;
          veh.wasStopped = true;
        }
      } else if (veh.v > WAIT_HIGH) {
        veh.wasStopped = false;
      }
      if (veh.done) {
        completed.push({
          wait: veh.totalWait,
          stops: veh.stops,
          travelTime: simTime - veh.spawnTime,
          freeFlowTime: veh.freeFlowTime,
        });
      }
    }
  }

  return { completed };
}
