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
  signalProgram?: "actuated" | "fixed";
  running?: boolean;
  congestionFeed?: boolean;
  autoIncidents?: boolean;
  timeOfDayMin?: number; // force sim clock, minutes 0..1440
}

export interface IncidentMsg {
  type: "incident";
  action: "random" | "clearAll";
}

export type MainToWorker = InitMsg | ParamsMsg | IncidentMsg;

export interface ReadyMsg {
  type: "ready";
  edgeCount: number;
  laneKm: number;
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
}

export interface CongestionMsg {
  type: "congestion";
  perEdge: ArrayBuffer; // Float32Array per undirected edge 0..1
}

export interface EventMsg {
  type: "event";
  level: "info" | "warn" | "crit" | "ok";
  text: string;
}

export type WorkerToMain = ReadyMsg | FrameMsg | MetricsMsg | CongestionMsg | EventMsg;
