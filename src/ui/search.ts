// Finding a place by typing its name.
//
// Everything on this map already has a name somewhere in memory — 10k street
// names in the graph's name table, 610 sensor stations, every RET stop the live
// feed publishes, fifteen districts — and until now there was no way to type
// any of them. This module turns those four sources into one flat index and
// ranks a query against it.
//
// Deliberately free of the DOM and of three.js: the index is built from parsed
// city data and the matcher is a pure function over it, so both can be checked
// without a browser. `App` owns the input, the list and the camera.

import type { CityData } from "../data/loader";

export type SearchKind = "street" | "station" | "stop" | "district";

export interface SearchEntry {
  label: string;
  kind: SearchKind;
  /** data coords: east, north. World z is -y, as everywhere else. */
  x: number;
  y: number;
  /** how far back the camera sits when it flies here */
  dist: number;
  /**
   * Tie-breaker within a match tier: a motorway outranks a service road, a
   * twelve-lane sensor site outranks a two-lane one. Never compared across
   * tiers — a prefix match on a footpath still beats a substring match on the
   * A20, because the operator typed the beginning of the footpath's name.
   */
  weight: number;
  /** the line under the label: district, class, whatever identifies it */
  sub: string;
  /** normalized label, precomputed — matching runs on every keystroke */
  norm: string;
}

export interface SearchHit extends SearchEntry {
  /** 0 exact · 1 prefix · 2 word-start · 3 substring */
  tier: number;
  /** [start, end) of the matched span in `label`, for highlighting */
  at: [number, number];
}

const CLASS_LABEL = [
  "Motorway", "Trunk", "Primary", "Secondary", "Tertiary",
  "Street", "Service", "Pedestrian", "Cycleway", "Footpath",
];

/**
 * Fold a name down to what someone is likely to type, keeping the offsets.
 *
 * Dutch street names carry diacritics, ligatures and punctuation that nobody
 * reaches for mid-search: `'s-Gravendijkwal`, `Burg. van Walsumweg`, `Kralingse
 * Zoom`. Compatibility decomposition also splits the `ĳ` ligature into `ij`,
 * which matters in a city with an IJsselmonde and an IJssel.
 *
 * `map` carries each normalized character back to the source index that
 * produced it, so a match found in the folded string can be highlighted in the
 * original. Deriving that afterwards by re-walking the two strings does not
 * work — folding changes length in both directions — and getting it wrong
 * underlines the wrong letters.
 */
export function fold(s: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const piece = s[i]
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
    let kept = false;
    for (const ch of piece) {
      if (/[a-z0-9]/.test(ch)) {
        norm += ch;
        map.push(i);
        kept = true;
      }
    }
    // Anything else — space, hyphen, apostrophe, full stop — is a separator.
    // Runs of them collapse to one space, and a leading run is dropped, so
    // `'s-Gravendijkwal` folds to `s gravendijkwal`.
    if (!kept && norm.length && norm[norm.length - 1] !== " ") {
      norm += " ";
      map.push(i);
    }
  }
  while (norm.endsWith(" ")) {
    norm = norm.slice(0, -1);
    map.pop();
  }
  return { norm, map };
}

export function normalize(s: string): string {
  return fold(s).norm;
}

/** Where a query starts inside a normalized haystack, at the tightest tier. */
function locate(hay: string, needle: string): { tier: number; at: number } | null {
  if (hay === needle) return { tier: 0, at: 0 };
  if (hay.startsWith(needle)) return { tier: 1, at: 0 };
  const i = hay.indexOf(needle);
  if (i >= 0) return { tier: hay[i - 1] === " " ? 2 : 3, at: i };
  // A query with its spaces removed still matches: someone typing
  // `sgravendijkwal` or `kralingsezoom` should still land on the street. The
  // hit is real but its offsets belong to a different string, so it comes back
  // unhighlightable (at: -1) rather than highlighted in the wrong place.
  const tight = needle.replace(/ /g, "");
  return tight && hay.replace(/ /g, "").includes(tight) ? { tier: 3, at: -1 } : null;
}

/** The matched span in the original label, or an empty span when unknown. */
function spanInLabel(map: number[], label: string, at: number, len: number): [number, number] {
  if (at < 0 || at >= map.length) return [0, 0];
  const start = map[at];
  const endIdx = at + len;
  const end = endIdx < map.length ? map[endIdx] : label.length;
  return [start, Math.max(start, end)];
}

function entry(
  label: string,
  kind: SearchKind,
  x: number,
  y: number,
  dist: number,
  weight: number,
  sub: string
): SearchEntry {
  return { label, kind, x, y, dist, weight, sub, norm: normalize(label) };
}

/**
 * One flat, sorted index over everything on the map that has a name.
 *
 * Built once, lazily, on the first search — the street pass walks every edge
 * in the graph, which is not something to do during boot for a panel nobody
 * may open. Live stops are the exception: they arrive with the snapshot and
 * change on every refresh, so they are indexed separately and merged at query
 * time rather than baked in here.
 */
export function buildSearchIndex(data: CityData, districtNames: string[]): SearchEntry[] {
  const out: SearchEntry[] = [];
  const g = data.graph;

  // ---- streets: one entry per name, on the way that carries its identity ----
  //
  // A name can span dozens of edges scattered across the city (Rotterdam has a
  // Kerkstraat in four districts). Flying to a random one of them is a coin
  // toss, and flying to their centroid can land in the water between two
  // halves. So one edge has to stand for the name.
  //
  // Class before length, and that order matters. Picking the longest edge alone
  // made the Coolsingel a "Cycleway · Centrum": Dutch streets carry a separate
  // cycleway way alongside the carriageway under the same name, and the bike
  // path is frequently the longer single stretch because the road is cut into
  // segments at every junction. The lowest class number is the most important
  // way wearing the name, and that is what the name means; length only settles
  // ties within it.
  const best = new Map<number, { cls: number; len: number; edge: number }>();
  for (let e = 0; e < g.edges.count; e++) {
    const ni = g.edges.nameIdx[e];
    const cls = g.edges.cls[e];
    const len = g.edges.len[e];
    const cur = best.get(ni);
    if (!cur || cls < cur.cls || (cls === cur.cls && len > cur.len)) best.set(ni, { cls, len, edge: e });
  }
  for (const [ni, { edge }] of best) {
    const name = g.names[ni];
    if (!name || name.length < 2) continue;
    const off = g.edges.geoOff[edge];
    const n = g.edges.geoCount[edge];
    if (!n) continue;
    // An interior vertex when the edge has one, the midpoint of the single
    // segment when it does not. Taking `geo[off + n>>1]` unconditionally puts a
    // two-point edge on its far endpoint — which is a junction, where the
    // street ends and the next one begins.
    let mx: number;
    let my: number;
    if (n >= 3) {
      const k = off + (n >> 1);
      mx = g.geo[k * 2];
      my = g.geo[k * 2 + 1];
    } else if (n === 2) {
      mx = (g.geo[off * 2] + g.geo[(off + 1) * 2]) / 2;
      my = (g.geo[off * 2 + 1] + g.geo[(off + 1) * 2 + 1]) / 2;
    } else {
      mx = g.geo[off * 2];
      my = g.geo[off * 2 + 1];
    }
    const cls = g.edges.cls[edge];
    const district = districtNames[g.edges.district[edge]] ?? "";
    const clsLabel = CLASS_LABEL[cls] ?? "Way";
    out.push(
      entry(
        name,
        "street",
        mx,
        my,
        cls <= 1 ? 2600 : cls <= 3 ? 1500 : 900,
        // low class number is a bigger road; keep it a positive weight
        (10 - Math.min(9, cls)) * 100,
        district ? `${clsLabel} · ${district}` : clsLabel
      )
    );
  }

  // ---- NDW sensor stations ----
  for (const s of data.ndw?.stations ?? []) {
    if (!s.name) continue;
    out.push(
      entry(
        s.name,
        "station",
        s.x,
        s.y,
        1100,
        400 + Math.min(400, s.lanes * 40),
        `Sensor station · ${s.lanes} lane${s.lanes === 1 ? "" : "s"}`
      )
    );
  }

  // ---- districts ----
  for (const d of data.meta.districts) {
    out.push(entry(d.name, "district", d.x, d.y, 4200, 900, "District"));
  }

  return out;
}

/** The live RET stops, as index entries. Rebuilt whenever the snapshot moves. */
export function stopEntries(stops: Record<string, [string, number, number]> | undefined): SearchEntry[] {
  if (!stops) return [];
  const out: SearchEntry[] = [];
  for (const key of Object.keys(stops)) {
    const [name, x, y] = stops[key];
    if (!name) continue;
    out.push(entry(name, "stop", x, y, 800, 700, "Transit stop"));
  }
  return out;
}

/**
 * Rank an index against what has been typed so far.
 *
 * Tier before weight, always: someone who has typed four characters is telling
 * you how a name starts, and honouring that matters more than any notion of
 * which road is important. Weight only settles ties inside a tier.
 *
 * Names repeat across the city — four Kerkstraats, a dozen stops sharing a
 * name with the street they sit on — so an exact-label duplicate is dropped
 * once a better-ranked one is already in the list. Different kinds at the same
 * name are kept: `Beurs` the stop and `Beurs` the street are different answers.
 */
export function searchIndex(index: SearchEntry[], query: string, limit = 8): SearchHit[] {
  const q = normalize(query);
  if (q.length < 2) return [];
  // Ranked first, folded second. Re-folding every candidate just to know where
  // to underline would mean 10k folds a keystroke; only the handful that
  // survive the cut ever need their offsets back.
  const ranked: { e: SearchEntry; tier: number; at: number }[] = [];
  for (const e of index) {
    const m = locate(e.norm, q);
    if (m) ranked.push({ e, tier: m.tier, at: m.at });
  }
  ranked.sort(
    (a, b) =>
      a.tier - b.tier ||
      b.e.weight - a.e.weight ||
      a.e.label.length - b.e.label.length ||
      a.e.label.localeCompare(b.e.label)
  );
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const r of ranked) {
    const key = `${r.e.kind}:${r.e.norm}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...r.e, tier: r.tier, at: spanInLabel(fold(r.e.label).map, r.e.label, r.at, q.length) });
    if (out.length >= limit) break;
  }
  return out;
}
