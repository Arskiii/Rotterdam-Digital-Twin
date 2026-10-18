// OSM XML → Network adapter for v0.3.
//
// We parse an .osm file (OpenStreetMap export) in the browser via DOMParser, project its
// lat/lon to local meters with a simple equirectangular projection centered on the bbox,
// and emit a Network that the existing simulation engine drives without modification.
//
// Modeling choices for v0.3 first cut:
//   - "Driveable" highways only — footways, cycleways, steps, etc. are skipped.
//   - Every node along a way becomes a NetworkNode. Junctions (used by ≥2 ways) get
//     phase assignments and become signaled intersections; pass-through waypoints have
//     empty phaseOf, which makes the existing TrafficLightController return "green" and
//     the renderer skip the intersection pad — so curved streets render correctly.
//   - Entry/exit stubs are added at every way endpoint within BOUNDARY_MARGIN_M of the
//     bbox edge, mirroring the perimeter-stub pattern from the v0.2 grid.
//   - Phase 0 = approaches whose direction is more N-S; phase 1 = more E-W. A pragmatic
//     two-phase split that mostly matches reality on the rough grid of central Rotterdam.

import { Vector2 } from "three/src/math/Vector2.js";
import { computeLaneOffsets, defaultLaneTurns } from "../sim/lanes";
import type { EdgeId, Network, NetworkEdge, NetworkNode, NodeId, TurnDir } from "../sim/types";

// Highway tag values we consider driveable for cars. We deliberately exclude `service`
// (driveways, parking-lot alleys, building access) — they add a lot of micro-junctions
// without contributing to the real street network you'd think of as Rotterdam traffic.
const DRIVEABLE = new Set([
  "motorway",
  "motorway_link",
  "trunk",
  "trunk_link",
  "primary",
  "primary_link",
  "secondary",
  "secondary_link",
  "tertiary",
  "tertiary_link",
  "unclassified",
  "residential",
  "living_street",
]);

const DEFAULT_SPEED_MS = 13.9; // 50 km/h Dutch urban
const STUB_OFFSET_M = 25; // distance from boundary node out to its entry/exit stub
const BOUNDARY_MARGIN_M = 30; // a way endpoint within this distance of the bbox edge becomes an entry/exit
const MIN_EDGE_LENGTH_M = 0.5; // drop degenerate zero-length edges
// "Trust OSM" mode: a node is signaled iff OSM tags it with `highway=traffic_signals`,
// and it lives at the exact lat/lon OSM gives. No clustering, no proximity matching,
// no centroid relocation. This means complex intersections that OSM models as multiple
// junction nodes will visually appear as multiple signaled stop points — that's how
// OSM describes them, and we no longer try to second-guess.

interface OsmNode {
  id: string;
  lat: number;
  lon: number;
  tags: Map<string, string>;
}

interface OsmWay {
  id: string;
  refs: string[];
  tags: Map<string, string>;
}

interface OsmData {
  bounds: { minlat: number; minlon: number; maxlat: number; maxlon: number };
  nodes: Map<string, OsmNode>;
  ways: OsmWay[];
}

export interface OsmBuildSummary {
  network: Network;
  bbox: { widthM: number; heightM: number };
  origin: { lat: number; lon: number };
  buildings: Array<{ id: string; points: Array<{ x: number; z: number }>; heightM: number; heightEstimated: boolean }>;
  transitStops: Array<{ id: string; x: number; z: number; name: string; kind: string }>;
  junctionCount: number;
  signalCount: number;
  signalsTagged: number;   // total `highway=traffic_signals` nodes in the OSM file
  signalsMatched: number;  // tagged nodes that found a junction within the match radius
  edgeCount: number;
  entryCount: number;
}

function parseSpeedKmh(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(mph)?(?:\b|$)/i);
  if (!m) return undefined;
  const kmh = Number(m[1]) * (m[2] ? 1.609344 : 1);
  return kmh > 0 && kmh <= 130 ? kmh / 3.6 : undefined;
}

function parseLanes(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const n = parseInt(s, 10);
  return isNaN(n) || n < 1 ? undefined : Math.min(n, 8);
}

// OSM `turn:lanes` is pipe-separated, one entry per lane, ordered LEFT-TO-RIGHT in the
// direction of travel. Each entry can be a semicolon-separated set of turn types
// (`left;through`). We reverse the list so the resulting array's index 0 is the
// rightmost lane — matching our internal lane convention.
function parseTurnLanes(
  spec: string | undefined,
  laneCount: number,
): Set<TurnDir>[] | undefined {
  if (!spec) return undefined;
  const parts = spec.split("|");
  if (parts.length !== laneCount) return undefined;
  const result: Set<TurnDir>[] = [];
  for (const p of parts) {
    const set = new Set<TurnDir>();
    for (const tok of p.split(";")) {
      const t = tok.trim().toLowerCase();
      if (t === "left" || t === "slight_left" || t === "sharp_left" || t === "merge_to_left") {
        set.add("left");
      } else if (t === "right" || t === "slight_right" || t === "sharp_right" || t === "merge_to_right") {
        set.add("right");
      } else if (t === "through" || t === "" || t === "none") {
        set.add("through");
      } else if (t === "reverse") {
        // Skip — we don't model U-turns.
      }
    }
    if (set.size === 0) set.add("through");
    result.push(set);
  }
  // OSM order is left-to-right; our index 0 is rightmost, so reverse.
  return result.reverse();
}

interface LaneAssignment {
  forwardLanes: number;
  backwardLanes: number;
  forwardTurns: Set<TurnDir>[];
  backwardTurns: Set<TurnDir>[];
}

// Resolves the lane-count + turn-assignment for a way, falling back through OSM tag
// conventions. `oneway=yes` means all lanes go forward; otherwise lanes split across
// directions (preferring explicit `lanes:forward` / `:backward` if present).
function resolveLanes(tags: Map<string, string>): LaneAssignment {
  const reverseOneway = tags.get("oneway") === "-1";
  const oneway = tags.get("oneway") === "yes" || reverseOneway ||
    (tags.get("junction") === "roundabout" && tags.get("oneway") !== "no");
  const total = parseLanes(tags.get("lanes"));
  const fwd = parseLanes(tags.get("lanes:forward"));
  const bwd = parseLanes(tags.get("lanes:backward"));

  let forwardLanes: number;
  let backwardLanes: number;
  if (oneway) {
    forwardLanes = reverseOneway ? 0 : total ?? fwd ?? 1;
    backwardLanes = reverseOneway ? total ?? bwd ?? 1 : 0;
  } else if (fwd !== undefined || bwd !== undefined) {
    forwardLanes = fwd ?? Math.max(1, (total ?? 2) - (bwd ?? 0));
    backwardLanes = bwd ?? Math.max(1, (total ?? 2) - (fwd ?? 0));
  } else if (total !== undefined) {
    forwardLanes = Math.max(1, Math.floor(total / 2));
    backwardLanes = Math.max(1, total - forwardLanes);
  } else {
    forwardLanes = 1;
    backwardLanes = 1;
  }

  const forwardTurnsSpec = tags.get("turn:lanes:forward") ??
    (oneway && !reverseOneway ? tags.get("turn:lanes") : undefined);
  const backwardTurnsSpec = tags.get("turn:lanes:backward") ??
    (reverseOneway ? tags.get("turn:lanes") : undefined);
  const forwardTurns = forwardLanes > 0
    ? parseTurnLanes(forwardTurnsSpec, forwardLanes) ?? defaultLaneTurns(forwardLanes)
    : [];
  const backwardTurns =
    backwardLanes > 0
      ? parseTurnLanes(backwardTurnsSpec, backwardLanes) ?? defaultLaneTurns(backwardLanes)
      : [];

  return { forwardLanes, backwardLanes, forwardTurns, backwardTurns };
}

function parseOsmXml(xml: string): OsmData {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new Error("Failed to parse OSM XML");
  }
  const boundsEl = doc.getElementsByTagName("bounds")[0];
  if (!boundsEl) throw new Error("OSM file missing <bounds>");
  const bounds = {
    minlat: parseFloat(boundsEl.getAttribute("minlat")!),
    minlon: parseFloat(boundsEl.getAttribute("minlon")!),
    maxlat: parseFloat(boundsEl.getAttribute("maxlat")!),
    maxlon: parseFloat(boundsEl.getAttribute("maxlon")!),
  };
  if (Object.values(bounds).some((n) => !Number.isFinite(n)) ||
      bounds.minlat >= bounds.maxlat || bounds.minlon >= bounds.maxlon ||
      bounds.minlat < -90 || bounds.maxlat > 90 ||
      bounds.minlon < -180 || bounds.maxlon > 180) {
    throw new Error("OSM file has invalid bounds");
  }

  const nodes = new Map<string, OsmNode>();
  for (const el of Array.from(doc.getElementsByTagName("node"))) {
    const tags = new Map<string, string>();
    for (const t of Array.from(el.getElementsByTagName("tag"))) {
      tags.set(t.getAttribute("k")!, t.getAttribute("v")!);
    }
    const id = el.getAttribute("id")!;
    const latText = el.getAttribute("lat");
    const lonText = el.getAttribute("lon");
    if (!id || latText === null || lonText === null) continue;
    const lat = Number(latText);
    const lon = Number(lonText);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    nodes.set(id, {
      id,
      lat,
      lon,
      tags,
    });
  }

  const ways: OsmWay[] = [];
  for (const el of Array.from(doc.getElementsByTagName("way"))) {
    const refs: string[] = [];
    for (const nd of Array.from(el.getElementsByTagName("nd"))) {
      refs.push(nd.getAttribute("ref")!);
    }
    const tags = new Map<string, string>();
    for (const t of Array.from(el.getElementsByTagName("tag"))) {
      tags.set(t.getAttribute("k")!, t.getAttribute("v")!);
    }
    ways.push({ id: el.getAttribute("id")!, refs, tags });
  }

  return { bounds, nodes, ways };
}

export function buildOsmNetwork(xml: string): OsmBuildSummary {
  const data = parseOsmXml(xml);

  const driveable = data.ways.filter((w) => {
    const h = w.tags.get("highway");
    return h !== undefined && DRIVEABLE.has(h);
  });

  // Equirectangular projection centered on the bbox center — accurate enough for ≤1 km tiles.
  const cLat = (data.bounds.minlat + data.bounds.maxlat) / 2;
  const cLon = (data.bounds.minlon + data.bounds.maxlon) / 2;
  const M_PER_DEG_LAT = 111320;
  const M_PER_DEG_LON = 111320 * Math.cos((cLat * Math.PI) / 180);
  const project = (lat: number, lon: number) => ({
    x: (lon - cLon) * M_PER_DEG_LON,
    z: -(lat - cLat) * M_PER_DEG_LAT, // Three.js: +z = south
  });

  const buildings: OsmBuildSummary["buildings"] = [];
  for (const way of data.ways) {
    if (!way.tags.has("building") || way.tags.get("building") === "no" ||
        way.refs.length < 4 || way.refs[0] !== way.refs[way.refs.length - 1]) continue;
    const points = way.refs.slice(0, -1).map((id) => data.nodes.get(id)).filter((n): n is OsmNode => !!n)
      .map((n) => project(n.lat, n.lon));
    if (points.length < 3 || points.length > 200 || points.length !== way.refs.length - 1) continue;
    const taggedHeight = Number.parseFloat(way.tags.get("height") ?? "");
    const levels = Number.parseFloat(way.tags.get("building:levels") ?? "");
    const hasTaggedHeight = Number.isFinite(taggedHeight) && taggedHeight > 1 && taggedHeight < 300;
    const hasLevels = Number.isFinite(levels) && levels > 0 && levels < 100;
    const heightM = hasTaggedHeight ? taggedHeight : hasLevels ? levels * 3 : 12;
    buildings.push({ id: way.id, points, heightM, heightEstimated: !hasTaggedHeight && !hasLevels });
  }
  const transitStops: OsmBuildSummary["transitStops"] = [];
  for (const node of data.nodes.values()) {
    const kind = node.tags.get("highway") === "bus_stop" ? "Bus stop" :
      node.tags.get("railway") === "tram_stop" ? "Tram stop" :
      node.tags.get("railway") === "station" ? "Station" : "";
    if (!kind) continue;
    const point = project(node.lat, node.lon);
    transitStops.push({ id: node.id, ...point, name: node.tags.get("name") ?? kind, kind });
  }

  const sw = project(data.bounds.minlat, data.bounds.minlon);
  const ne = project(data.bounds.maxlat, data.bounds.maxlon);
  const xMin = Math.min(sw.x, ne.x);
  const xMax = Math.max(sw.x, ne.x);
  const zMin = Math.min(sw.z, ne.z);
  const zMax = Math.max(sw.z, ne.z);

  // Count node usage in driveable ways and collect way endpoints for boundary detection.
  const nodeUsage = new Map<string, number>();
  const wayEndpoints = new Set<string>();
  for (const w of driveable) {
    const refs = w.refs.filter((r) => data.nodes.has(r));
    for (const r of refs) nodeUsage.set(r, (nodeUsage.get(r) ?? 0) + 1);
    if (refs.length > 0) {
      wayEndpoints.add(refs[0]);
      wayEndpoints.add(refs[refs.length - 1]);
    }
  }

  // Real junctions in the driveable graph — used by ≥2 driveable ways. No clustering
  // or relocation: the node sits where OSM puts it.
  const junctionSet = new Set<string>();
  for (const [nid, count] of nodeUsage) {
    if (count >= 2) junctionSet.add(nid);
  }

  // Signal nodes: OSM-tagged `highway=traffic_signals`. These become the signaled stop
  // points in our network — exactly where OSM says, no proximity matching to junctions.
  // Pedestrian-crossing signals on cycleways/footways are filtered out below by checking
  // that the node is touched by a driveable way.
  const signalNodeOsmIds = new Set<string>();
  for (const [nid, n] of data.nodes) {
    if (n.tags.get("highway") === "traffic_signals" && nodeUsage.has(nid)) {
      signalNodeOsmIds.add(nid);
    }
  }

  const nodes = new Map<NodeId, NetworkNode>();
  const edges = new Map<EdgeId, NetworkEdge>();
  const entries: NodeId[] = [];
  const exits: NodeId[] = [];

  // Materialize a Network node for every OSM node touched by a driveable way, at its
  // exact projected lat/lon position. Real junctions (≥2 driveable ways meet) get
  // isJunction=true so the renderer draws an intersection pad even when uncontrolled;
  // pass-through waypoints used to model curved geometry stay isJunction=false.
  for (const nid of nodeUsage.keys()) {
    if (nodes.has(nid)) continue;
    const o = data.nodes.get(nid);
    if (!o) continue;
    const pos = project(o.lat, o.lon);
    nodes.set(nid, {
      id: nid,
      position: new Vector2(pos.x, pos.z),
      kind: "intersection",
      phaseOf: new Map(),
      isJunction: junctionSet.has(nid),
    });
  }

  function addEdge(
    fromId: NodeId,
    toId: NodeId,
    speedLimit: number,
    laneCount: number,
    laneTurns: Set<TurnDir>[],
    isOneWay: boolean,
    name?: string,
  ) {
    const from = nodes.get(fromId);
    const to = nodes.get(toId);
    if (!from || !to) return;
    const start = from.position.clone();
    const end = to.position.clone();
    const delta = end.clone().sub(start);
    const length = delta.length();
    if (length < MIN_EDGE_LENGTH_M) return;
    const dir = delta.clone().normalize();
    // Two-way roads: each direction's lanes start at the corridor centreline and extend
    // outward to the right (centerOffset = 0). One-way roads: the whole lane group
    // straddles the corridor centreline so the road renders centred on its own
    // geometry (centerOffset = -laneCount * laneWidth / 2 so lane centres are symmetric
    // around 0).
    const centerOffset = isOneWay ? -(laneCount * 3.5) / 2 : 0;
    const laneOffsets = computeLaneOffsets(dir, laneCount, centerOffset);
    const id = `${fromId}->${toId}`;
    if (edges.has(id)) return; // dedupe (e.g. way overlap)
    edges.set(id, {
      id,
      name,
      from: fromId,
      to: toId,
      length,
      start,
      end,
      dir,
      speedLimit,
      laneCount,
      laneTurns,
      laneOffsets,
      outgoing: [],
    });
  }

  // Build straight-line edges between every consecutive pair of nodes along each way.
  // Intermediate waypoints whose bend angle is < 5° get dropped — each kink in the
  // original OSM polyline becomes a visible seam between adjacent ribbons at oblique
  // camera angles. Junctions and signal nodes are always preserved (a signal must keep
  // its exact position so cars stop at the correct point).
  const COLLINEAR_THRESHOLD_RAD = 0.087; // ~5°
  for (const way of driveable) {
    const refs = way.refs.filter((r) => nodes.has(r));
    if (refs.length < 2) continue;
    const oneway = way.tags.get("oneway") === "yes" || way.tags.get("oneway") === "-1" ||
      (way.tags.get("junction") === "roundabout" && way.tags.get("oneway") !== "no");
    const speed = parseSpeedKmh(way.tags.get("maxspeed")) ?? DEFAULT_SPEED_MS;
    const { forwardLanes, backwardLanes, forwardTurns, backwardTurns } = resolveLanes(
      way.tags,
    );

    const simplified: string[] = [refs[0]];
    for (let i = 1; i + 1 < refs.length; i++) {
      const r = refs[i];
      if (junctionSet.has(r) || signalNodeOsmIds.has(r)) {
        simplified.push(r);
        continue;
      }
      const prev = nodes.get(simplified[simplified.length - 1])!.position;
      const curr = nodes.get(r)!.position;
      const next = nodes.get(refs[i + 1])!.position;
      const a1 = Math.atan2(curr.y - prev.y, curr.x - prev.x);
      const a2 = Math.atan2(next.y - curr.y, next.x - curr.x);
      let diff = a2 - a1;
      while (diff > Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;
      if (Math.abs(diff) > COLLINEAR_THRESHOLD_RAD) simplified.push(r);
    }
    simplified.push(refs[refs.length - 1]);

    for (let i = 0; i + 1 < simplified.length; i++) {
      const a = simplified[i];
      const b = simplified[i + 1];
      if (a === b) continue;
      const name = way.tags.get("name")?.trim().slice(0, 100);
      if (forwardLanes > 0) addEdge(a, b, speed, forwardLanes, forwardTurns, oneway, name);
      if (backwardLanes > 0) addEdge(b, a, speed, backwardLanes, backwardTurns, oneway, name);
    }
  }

  // Boundary nodes: way endpoints sitting near the bbox edge — these become entries/exits.
  for (const nid of wayEndpoints) {
    const node = nodes.get(nid);
    if (!node) continue;
    const distLeft = node.position.x - xMin;
    const distRight = xMax - node.position.x;
    const distTop = node.position.y - zMin;
    const distBottom = zMax - node.position.y;
    const minDist = Math.min(distLeft, distRight, distTop, distBottom);
    if (minDist > BOUNDARY_MARGIN_M) continue;

    let offX = 0;
    let offZ = 0;
    if (minDist === distLeft) offX = -STUB_OFFSET_M;
    else if (minDist === distRight) offX = STUB_OFFSET_M;
    else if (minDist === distTop) offZ = -STUB_OFFSET_M;
    else offZ = STUB_OFFSET_M;

    const stubPos = new Vector2(node.position.x + offX, node.position.y + offZ);
    const eId = `entry_${nid}`;
    const xId = `exit_${nid}`;
    nodes.set(eId, { id: eId, position: stubPos.clone(), kind: "entry" });
    nodes.set(xId, { id: xId, position: stubPos.clone(), kind: "exit" });
    // Boundary stubs are simple single-lane connectors — cars enter or leave through
    // them without picking a turn lane.
    const stubTurns = defaultLaneTurns(1);
    addEdge(eId, nid, DEFAULT_SPEED_MS, 1, stubTurns, true);
    addEdge(nid, xId, DEFAULT_SPEED_MS, 1, stubTurns, true);
    entries.push(eId);
    exits.push(xId);
  }

  // Phase assignment: every OSM `highway=traffic_signals` node in the driveable network
  // becomes a stop point. Each of its inbound edges is binned into phase 0 (more N-S)
  // or phase 1 (more E-W) by direction angle. We don't try to merge multiple OSM
  // signals that describe one real-world intersection — they sit where OSM puts them
  // and each operates as its own signal head.
  let signalsMatched = 0;
  for (const sid of signalNodeOsmIds) {
    const node = nodes.get(sid);
    if (!node) continue;
    let assigned = 0;
    for (const e of edges.values()) {
      if (e.to !== sid) continue;
      const phase: 0 | 1 = Math.abs(e.dir.x) > Math.abs(e.dir.y) ? 1 : 0;
      node.phaseOf!.set(e.id, phase);
      assigned++;
    }
    if (assigned > 0) signalsMatched++;
  }

  // Populate `outgoing` for routing — same rule as the grid: any reachable downstream edge
  // except the one that would be a U-turn back along the same corridor.
  const edgesByFrom = new Map<NodeId, NetworkEdge[]>();
  for (const edge of edges.values()) {
    const from = edgesByFrom.get(edge.from) ?? [];
    from.push(edge);
    edgesByFrom.set(edge.from, from);
  }
  for (const edge of edges.values()) {
    const downstream = nodes.get(edge.to);
    if (!downstream || downstream.kind !== "intersection") continue;
    for (const candidate of edgesByFrom.get(downstream.id) ?? []) {
      if (candidate.to === edge.from) continue;
      edge.outgoing.push(candidate.id);
    }
  }

  // Headline counts for the HUD: total real junctions in the OSM data vs. how many of
  // them carry a signal in our model.
  let signalCount = 0;
  for (const n of nodes.values()) {
    if (n.kind !== "intersection") continue;
    if (n.phaseOf && n.phaseOf.size > 0) signalCount++;
  }

  return {
    network: { nodes, edges, entries, exits },
    bbox: { widthM: xMax - xMin, heightM: zMax - zMin },
    origin: { lat: cLat, lon: cLon },
    buildings,
    transitStops,
    junctionCount: junctionSet.size,
    signalCount,
    signalsTagged: signalNodeOsmIds.size,
    signalsMatched,
    edgeCount: edges.size,
    entryCount: entries.length,
  };
}
