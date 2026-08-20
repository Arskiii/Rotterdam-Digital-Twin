// Messages between the main thread and the traffic simulation worker.

export interface InitMsg {
  type: "init";
  graphBuffer: ArrayBuffer;
  districtCount: number;
  districts: { name: string; x: number; y: number }[];
}

export interface ParamsMsg {
  type: "params";
  density?: number; // target active vehicles at demand peak
  simSpeed?: number; // physics multiplier
  cycleScale?: number; // signal cycle length multiplier 0.6..1.6
  signalProgram?: "actuated" | "coordinated" | "fixed";
  running?: boolean;
  congestionFeed?: boolean;
  autoIncidents?: boolean;
  timeOfDayMin?: number; // force sim clock, minutes 0..1440
  speedFactor?: number; // live-weather speed multiplier for motorized traffic (0.7..1)
}

export interface IncidentMsg {
  type: "incident";
  action: "random" | "clearAll";
}

export interface ScenarioMsg {
  type: "scenario";
  kind: "bridge" | "stadium" | "roadworks" | "freight" | "clear";
}

export interface NdwMsg {
  type: "ndw";
  stations: { edge: number; flow: number }[]; // real veh/h per matched edge
  todMin: number; // time of day of the capture (minutes, NL time)
  live?: boolean; // refresh from the live feed (subdued announcement)
}

// Real bascule-bridge openings (NDW situation feed): the listed bridges are
// open for shipping right now, their car edges are severed until the next
// update clears them.
export interface LiveBridgesMsg {
  type: "liveBridges";
  bridges: { name: string; edges: number[]; x?: number; y?: number }[];
}

// Real incidents from the NDW situation feed. kind: 0 accident, 1 obstruction,
// 2 jam (display only), 3 road closure. Accidents/obstructions slow their
// matched edge, closures sever it; everything clears on the next update.
export interface LiveIncidentsMsg {
  type: "liveIncidents";
  incidents: { edge: number; kind: number; x: number; y: number; name: string }[];
}

export type MainToWorker = InitMsg | ParamsMsg | IncidentMsg | ScenarioMsg | NdwMsg | LiveBridgesMsg | LiveIncidentsMsg;

export interface ReadyMsg {
  type: "ready";
  edgeCount: number;
  laneKm: number;
}

// Engine init progress (graph parse → adjacency → tables) so the boot bar
// keeps moving on slow devices instead of pinning until ready.
export interface InitProgressMsg {
  type: "initProgress";
  frac: number; // 0..1
}

export interface FrameMsg {
  type: "frame";
  // Float32Array [x, y, heading, k] — k = speed01 + (tunnel ? 2 : 0) + mode * 4
  // mode: 0 car, 1 bike, 2 pedestrian
  vehicles: ArrayBuffer;
  ids: ArrayBuffer; // Int32Array agent id per rendered agent (stable while alive)
  speeds: ArrayBuffer; // Float32Array m/s per rendered agent
  count: number;
  signals: ArrayBuffer; // Uint8Array per signal head: 0 red, 1 amber, 2 green, 3 off
  clockMin: number; // time of day, minutes
}

export interface DistrictStat {
  vehicles: number;
  speedKmh: number;
  congestion: number; // 0..1
  queued: number;
}

export interface MetricsMsg {
  type: "metrics";
  simTime: number;
  clockMin: number;
  active: number; // cars
  trucks: number;
  bikes: number;
  walkers: number;
  completed: number;
  throughputMin: number; // completed per minute (rolling)
  avgSpeedKmh: number;
  queued: number; // vehicles at standstill
  avgWaitSec: number; // mean stopped time per completed trip (rolling)
  congestionIndex: number; // network-wide 0..1
  greensNow: number;
  incidents: number;
  incidentPts: { x: number; y: number }[];
  districts: DistrictStat[];
  calibration?: {
    stations: number;
    simVehH: number; // simulated flow over the matched stations
    realVehH: number; // NDW flow normalized to the current sim time of day
    ratio: number; // sim / real (0 when not yet measurable)
    demandNorm: number; // demand(now) / demand(capture) — scales per-station expectations
    stationFlows: number[]; // smoothed sim veh/h per station, in NdwMsg order
  };
}

export interface CongestionMsg {
  type: "congestion";
  perEdge: ArrayBuffer; // Float32Array per undirected edge 0..1
}

export interface EventMsg {
  type: "event";
  level: "info" | "warn" | "crit" | "ok";
  text: string;
  // optional world anchor: gives the message log a fly-to link; `live` marks
  // events derived from a real-world feed and adds an external map link
  x?: number;
  y?: number;
  live?: boolean;
}

export type WorkerToMain = ReadyMsg | InitProgressMsg | FrameMsg | MetricsMsg | CongestionMsg | EventMsg;
