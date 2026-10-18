import { Vector2 } from "three/src/math/Vector2.js";
import type { Network, NetworkEdge, NetworkNode, TurnDir } from "../sim/types";

type Pair = [number, number];
export interface NetworkSnapshot {
  nodes: Array<{ id: string; position: Pair; kind: NetworkNode["kind"]; isJunction?: boolean;
    signalGroupId?: string; phaseOf?: Array<[string, number]> }>;
  edges: Array<{ id: string; name?: string; from: string; to: string; speedLimit: number;
    laneCount: number; laneTurns: TurnDir[][]; laneOffsets: Pair[]; outgoing: string[] }>;
  entries: string[];
  exits: string[];
}

/** Retain graph insertion order: route choice and seeded runs depend on it. */
export function packNetwork(net: Network): NetworkSnapshot {
  return {
    nodes: [...net.nodes.values()].map((n) => ({ id: n.id, position: [n.position.x, n.position.y],
      kind: n.kind, isJunction: n.isJunction, signalGroupId: n.signalGroupId,
      phaseOf: n.phaseOf ? [...n.phaseOf] : undefined })),
    edges: [...net.edges.values()].map((e) => ({ id: e.id, name: e.name, from: e.from, to: e.to,
      speedLimit: e.speedLimit, laneCount: e.laneCount, laneTurns: e.laneTurns.map((turns) => [...turns]),
      laneOffsets: e.laneOffsets.map((v) => [v.x, v.y]), outgoing: [...e.outgoing] })),
    entries: [...net.entries], exits: [...net.exits],
  };
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
export function validId(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 240;
}
function check(value: unknown): asserts value {
  if (!value) throw new Error("Invalid saved road network.");
}
function list(v: unknown, max: number): unknown[] {
  check(Array.isArray(v) && v.length <= max);
  return v;
}
function vector(v: unknown, limit = 100_000): Vector2 {
  check(Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= limit));
  return new Vector2(v[0], v[1]);
}
function ids(v: unknown, max: number): string[] {
  const values = list(v, max);
  check(values.every(validId) && new Set(values).size === values.length);
  return values;
}

/** JSON files/storage are untrusted. Validate references before exposing a graph. */
export function unpackNetwork(value: unknown): Network {
  check(isRecord(value));
  const nodes = new Map<string, NetworkNode>();
  const edges = new Map<string, NetworkEdge>();
  for (const row of list(value.nodes, 5000)) {
    check(isRecord(row) && validId(row.id) && !nodes.has(row.id));
    check(row.kind === "intersection" || row.kind === "entry" || row.kind === "exit");
    check(row.isJunction === undefined || typeof row.isJunction === "boolean");
    check(row.signalGroupId === undefined || validId(row.signalGroupId));
    const phaseOf = row.phaseOf === undefined ? undefined : new Map<string, number>();
    for (const phase of row.phaseOf === undefined ? [] : list(row.phaseOf, 64)) {
      check(Array.isArray(phase) && phase.length === 2 && validId(phase[0]) &&
        Number.isInteger(phase[1]) && phase[1] >= 0 && phase[1] < 4 && !phaseOf!.has(phase[0]));
      phaseOf!.set(phase[0], phase[1]);
    }
    nodes.set(row.id, { id: row.id, kind: row.kind, position: vector(row.position),
      isJunction: row.isJunction, signalGroupId: row.signalGroupId, phaseOf });
  }
  for (const row of list(value.edges, 10000)) {
    check(isRecord(row) && validId(row.id) && !edges.has(row.id) && validId(row.from) && validId(row.to));
    check(row.from !== row.to && row.id === `${row.from}->${row.to}` && nodes.has(row.from) && nodes.has(row.to));
    check(row.name === undefined || (typeof row.name === "string" && row.name.length <= 100));
    check(typeof row.speedLimit === "number" && Number.isFinite(row.speedLimit) && row.speedLimit > 0 && row.speedLimit <= 100);
    check(typeof row.laneCount === "number" && Number.isInteger(row.laneCount) && row.laneCount >= 1 && row.laneCount <= 8);
    const turns = list(row.laneTurns, 8);
    const offsets = list(row.laneOffsets, 8);
    check(turns.length === row.laneCount && offsets.length === row.laneCount);
    const laneTurns = turns.map((values) => {
      check(Array.isArray(values) && values.length > 0 && values.length <= 3 &&
        values.every((t) => t === "left" || t === "through" || t === "right") && new Set(values).size === values.length);
      return new Set<TurnDir>(values);
    });
    const start = nodes.get(row.from)!.position.clone();
    const end = nodes.get(row.to)!.position.clone();
    const delta = end.clone().sub(start);
    const length = delta.length();
    check(length >= 0.5 && length <= 10000);
    edges.set(row.id, { id: row.id, name: row.name, from: row.from, to: row.to,
      start, end, length, dir: delta.normalize(), speedLimit: row.speedLimit, laneCount: row.laneCount,
      laneTurns, laneOffsets: offsets.map((v) => vector(v, 40)), outgoing: ids(row.outgoing, 64) });
  }
  check(nodes.size > 0 && edges.size > 0);
  for (const node of nodes.values()) {
    for (const edgeId of node.phaseOf?.keys() ?? []) check(edges.get(edgeId)?.to === node.id);
  }
  for (const edge of edges.values()) {
    for (const next of edge.outgoing) check(edges.get(next)?.from === edge.to);
  }
  const entries = ids(value.entries, nodes.size);
  const exits = ids(value.exits, nodes.size);
  check(entries.length > 0 && exits.length > 0 && entries.every((id) => nodes.get(id)?.kind === "entry") &&
    exits.every((id) => nodes.get(id)?.kind === "exit"));
  return { nodes, edges, entries, exits };
}

export async function fingerprint(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, "0")).join("");
}
