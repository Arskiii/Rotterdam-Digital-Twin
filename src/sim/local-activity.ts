// A bounded street animation for devices that cannot hold a second copy of the
// city graph in a simulation worker. It illustrates activity; it is never an
// observation, forecast, city population count or signal simulation.
import type { Graph } from "../data/loader";

type Agent = { edge: number; mode: number; s: number; backward: boolean; speed: number };
type Exit = { edge: number; backward: boolean };
export class LocalActivity {
  readonly capacity = 240;
  readonly data = new Float32Array(this.capacity * 4);
  readonly ids = Int32Array.from({ length: this.capacity }, (_, i) => i);
  readonly speeds = new Float32Array(this.capacity);
  count = 0;
  private agents: Agent[] = [];
  private center = { x: Infinity, y: Infinity };
  private candidates: number[][] = [[], [], []];
  private exits = new Map<number, Exit[]>();
  private lastAt = 0;
  private seed = 173;
  constructor(private graph: Graph) {}
  private random() { this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0; return this.seed / 4294967296; }
  private spawn(mode: number): Agent | null {
    const pool = this.candidates[mode];
    if (!pool.length) return null;
    const edge = pool[Math.floor(this.random() * pool.length)];
    return { edge, mode, s: this.random() * this.graph.edges.len[edge],
      backward: (mode === 2 || !(this.graph.edges.flags[edge] & 1)) && this.random() < 0.5,
      speed: mode === 2 ? 1.3 : mode === 1 ? 4.2 : Math.min(11, this.graph.edges.speed[edge] / 3.6) };
  }
  private recenter(x: number, y: number) {
    this.center = { x, y };
    this.candidates = [[], [], []];
    this.exits.clear();
    const e = this.graph.edges, xy = this.graph.nodesXY;
    const add = (node: number, exit: Exit) => {
      const list = this.exits.get(node) ?? [];
      list.push(exit); this.exits.set(node, list);
    };
    for (let i = 0; i < e.count; i++) {
      if (e.len[i] < 20 || e.geoCount[i] < 2 || (e.flags[i] & 2)) continue;
      const mx = (xy[e.a[i] * 2] + xy[e.b[i] * 2]) / 2;
      const my = (xy[e.a[i] * 2 + 1] + xy[e.b[i] * 2 + 1]) / 2;
      if ((mx - x) ** 2 + (my - y) ** 2 > 1400 ** 2) continue;
      for (let mode = 0; mode < 3; mode++) if (e.modeMask[i] & (1 << mode)) this.candidates[mode].push(i);
      add(e.a[i], { edge: i, backward: false });
      add(e.b[i], { edge: i, backward: true });
    }
    this.agents = [];
    for (let i = 0; i < this.capacity; i++) {
      const a = this.spawn(i % 3);
      if (a) this.agents.push(a);
    }
  }
  /** At most 12 updates/second, with reusable buffers and no worker allocation. */
  update(now: number, x: number, y: number): boolean {
    if (now - this.lastAt < 80) return false;
    const dt = Math.min(0.2, Math.max(0, (now - this.lastAt) / 1000));
    this.lastAt = now;
    if (Math.hypot(x - this.center.x, y - this.center.y) > 650) this.recenter(x, y);
    const e = this.graph.edges, geo = this.graph.geo;
    this.count = this.agents.length;
    for (let i = 0; i < this.agents.length; i++) {
      let a = this.agents[i];
      a.s += a.speed * dt;
      if (a.s >= e.len[a.edge]) {
        const node = a.backward ? e.a[a.edge] : e.b[a.edge];
        const exits = (this.exits.get(node) ?? []).filter((exit) => exit.edge !== a.edge &&
          (e.modeMask[exit.edge] & (1 << a.mode)) &&
          (!exit.backward || a.mode === 2 || !(e.flags[exit.edge] & 1)));
        if (exits.length) {
          const next = exits[Math.floor(this.random() * exits.length)];
          a.edge = next.edge; a.backward = next.backward; a.s = 0;
        } else {
          a = this.spawn(a.mode)!; this.agents[i] = a;
        }
      }
      const off = e.geoOff[a.edge], n = e.geoCount[a.edge];
      const target = a.backward ? e.len[a.edge] - a.s : a.s;
      let acc = 0;
      for (let j = 0; j < n - 1; j++) {
        const p = (off + j) * 2, dx = geo[p + 2] - geo[p], dy = geo[p + 3] - geo[p + 1];
        const len = Math.hypot(dx, dy);
        if (acc + len >= target || j === n - 2) {
          const f = len ? Math.min(1, Math.max(0, (target - acc) / len)) : 0;
          const sign = a.backward ? -1 : 1;
          const lane = a.mode === 0 ? 1.65 : a.mode === 1 ? 2.9 : 0.9;
          this.data[i * 4] = geo[p] + dx * f + sign * dy / (len || 1) * lane;
          this.data[i * 4 + 1] = geo[p + 1] + dy * f - sign * dx / (len || 1) * lane;
          this.data[i * 4 + 2] = Math.atan2(sign * dy, sign * dx);
          this.data[i * 4 + 3] = a.mode * 4 + 1;
          this.speeds[i] = a.speed;
          break;
        }
        acc += len;
      }
    }
    return true;
  }
}
