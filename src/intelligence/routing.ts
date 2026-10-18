import { parseGraph, MODE_CAR, type Graph } from "../data/loader";

export interface Destination { name: string; lat: number; lon: number; source: string }
export const HOSPITALS: Destination[] = [
  { name: "Erasmus MC", lat: 51.91093, lon: 4.46805, source: "https://www.erasmusmc.nl/nl-nl/contact-en-route" },
  { name: "Maasstad Ziekenhuis", lat: 51.879431, lon: 4.535410, source: "https://www.maasstadziekenhuis.nl/contact-routes-en-voorzieningen/contact" },
  { name: "Ikazia Ziekenhuis", lat: 51.886345, lon: 4.493408, source: "https://www.ikazia.nl/algemene-informatie/adres-route-en-parkeren" },
  { name: "Franciscus Gasthuis", lat: 51.942213, lon: 4.462354, source: "https://www.franciscus.nl/" },
];

class Heap {
  private nodes: number[] = [];
  private weights: number[] = [];
  get length() { return this.nodes.length; }
  push(node: number, weight: number) {
    let i = this.nodes.length;
    this.nodes.push(node); this.weights.push(weight);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.weights[p] <= weight) break;
      this.nodes[i] = this.nodes[p]; this.weights[i] = this.weights[p]; i = p;
    }
    this.nodes[i] = node; this.weights[i] = weight;
  }
  pop(): [number, number] {
    const node = this.nodes[0], weight = this.weights[0];
    const lastNode = this.nodes.pop()!, lastWeight = this.weights.pop()!;
    if (this.nodes.length) {
      let i = 0;
      while (i * 2 + 1 < this.nodes.length) {
        let child = i * 2 + 1;
        if (child + 1 < this.nodes.length && this.weights[child + 1] < this.weights[child]) child++;
        if (this.weights[child] >= lastWeight) break;
        this.nodes[i] = this.nodes[child]; this.weights[i] = this.weights[child]; i = child;
      }
      this.nodes[i] = lastNode; this.weights[i] = lastWeight;
    }
    return [node, weight];
  }
}

function nearestNode(graph: Graph, x: number, y: number): number {
  let best = -1, distance = Infinity;
  for (let i = 0; i < graph.nodeCount; i++) {
    if (!(graph.inCore[i] & MODE_CAR)) continue;
    const dx = graph.nodesXY[i * 2] - x, dy = graph.nodesXY[i * 2 + 1] - y;
    const d = dx * dx + dy * dy;
    if (d < distance) { distance = d; best = i; }
  }
  return best;
}

export function localPoint(lat: number, lon: number): [number, number] {
  return [(lon - 4.48) * 111320 * Math.cos(51.92 * Math.PI / 180), (lat - 51.92) * 110574];
}

export interface AccessRow { district: string; baseMin: number | null; stressMin: number | null; changeMin: number | null }
/** Free-flow road travel to the nearest of four sample hospitals. No traffic assignment. */
export function calculateHospitalAccess(buffer: ArrayBuffer, districts: { name: string; x: number; y: number }[], closedEdges: Set<number>, wetSpeedFactor: number): AccessRow[] {
  const graph = parseGraph(buffer);
  const { edges } = graph;
  const head = new Int32Array(graph.nodeCount).fill(-1);
  const next: number[] = [], source: number[] = [], edgeId: number[] = [];
  const add = (at: number, from: number, edge: number) => {
    const id = next.length; next.push(head[at]); source.push(from); edgeId.push(edge); head[at] = id;
  };
  for (let e = 0; e < edges.count; e++) {
    if (!(edges.modeMask[e] & MODE_CAR)) continue;
    add(edges.b[e], edges.a[e], e);
    if (!(edges.flags[e] & 1)) add(edges.a[e], edges.b[e], e);
  }
  const hospitalNodes = HOSPITALS.map((hospital) => nearestNode(graph, ...localPoint(hospital.lat, hospital.lon))).filter((n) => n >= 0);
  const districtNodes = districts.map((district) => nearestNode(graph, district.x, district.y));
  const solve = (closed: Set<number>) => {
    const distances = new Float64Array(graph.nodeCount).fill(Infinity);
    const heap = new Heap();
    for (const node of hospitalNodes) { distances[node] = 0; heap.push(node, 0); }
    while (heap.length) {
      const [at, distance] = heap.pop();
      if (distance !== distances[at]) continue;
      for (let arc = head[at]; arc >= 0; arc = next[arc]) {
        const e = edgeId[arc];
        if (closed.has(e)) continue;
        const speed = Math.max(5, edges.speed[e]);
        const candidate = distance + edges.len[e] / (speed / 3.6 * 0.94);
        const from = source[arc];
        if (candidate < distances[from]) { distances[from] = candidate; heap.push(from, candidate); }
      }
    }
    return districtNodes.map((node) => node < 0 || !Number.isFinite(distances[node]) ? null : distances[node] / 60);
  };
  const base = solve(new Set<number>());
  const stress = solve(closedEdges);
  const factor = Math.max(0.6, Math.min(1, wetSpeedFactor));
  return districts.map((district, i) => ({
    district: district.name,
    baseMin: base[i] === null ? null : Math.round(base[i]! * 10) / 10,
    stressMin: stress[i] === null ? null : Math.round(stress[i]! / factor * 10) / 10,
    changeMin: base[i] === null || stress[i] === null ? null : Math.round((stress[i]! / factor - base[i]!) * 10) / 10,
  }));
}
