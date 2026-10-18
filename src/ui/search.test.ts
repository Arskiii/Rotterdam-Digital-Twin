import { describe, it, expect } from "vitest";
import { fold, normalize, searchIndex, stopEntries, buildSearchIndex, type SearchEntry } from "./search";

function e(label: string, over: Partial<SearchEntry> = {}): SearchEntry {
  return {
    label,
    kind: "street",
    x: 0,
    y: 0,
    dist: 900,
    weight: 500,
    sub: "",
    norm: normalize(label),
    ...over,
  };
}

describe("fold", () => {
  it("strips the punctuation nobody types", () => {
    expect(normalize("'s-Gravendijkwal")).toBe("s gravendijkwal");
    expect(normalize("Burg. van Walsumweg")).toBe("burg van walsumweg");
  });

  it("folds diacritics and the Dutch ĳ ligature", () => {
    expect(normalize("Café Plein")).toBe("cafe plein");
    expect(normalize("Ĳsselmonde")).toBe("ijsselmonde");
  });

  it("collapses separator runs and trims the edges", () => {
    expect(normalize("  A -- B  ")).toBe("a b");
  });

  it("maps every folded character back to its source index", () => {
    const { norm, map } = fold("'s-Gravendijkwal");
    expect(map).toHaveLength(norm.length);
    // the 's' of "'s" comes from index 1, past the apostrophe
    expect(map[0]).toBe(1);
    // 'g' of Gravendijkwal follows the collapsed separator
    expect(norm[map.indexOf(3)]).toBe("g");
    expect("'s-Gravendijkwal"[map[norm.indexOf("g")]]).toBe("G");
  });

  it("never emits a leading separator", () => {
    expect(normalize("---abc")).toBe("abc");
    expect(fold("---abc").map[0]).toBe(3);
  });
});

describe("searchIndex", () => {
  const index = [
    e("Coolsingel", { weight: 800 }),
    e("Coolhaven", { weight: 500 }),
    e("Schiedamse Vest", { weight: 500 }),
    e("Beurs", { kind: "stop", weight: 700, sub: "Transit stop" }),
    e("'s-Gravendijkwal", { weight: 600 }),
    e("Centrum", { kind: "district", weight: 900 }),
  ];

  it("ignores a query under two characters", () => {
    expect(searchIndex(index, "c")).toHaveLength(0);
    expect(searchIndex(index, "")).toHaveLength(0);
  });

  it("puts prefix matches ahead of substring matches", () => {
    const hits = searchIndex(index, "cool");
    expect(hits.map((h) => h.label)).toEqual(["Coolsingel", "Coolhaven"]);
    expect(hits[0].tier).toBe(1);
  });

  it("ranks an exact match first even against a heavier entry", () => {
    const hits = searchIndex([e("Coolhaven", { weight: 10 }), e("Cool", { weight: 9000 })], "coolhaven");
    expect(hits[0].label).toBe("Coolhaven");
    expect(hits[0].tier).toBe(0);
  });

  it("treats a word start as tighter than a mid-word hit", () => {
    const hits = searchIndex([e("Schiedamse Vest"), e("Vestdijk")], "vest");
    expect(hits[0].label).toBe("Vestdijk"); // prefix
    expect(hits[1].label).toBe("Schiedamse Vest"); // word start
    expect(hits[1].tier).toBe(2);
  });

  it("finds a name through its punctuation", () => {
    expect(searchIndex(index, "gravendijkwal")[0].label).toBe("'s-Gravendijkwal");
    expect(searchIndex(index, "sgravendijkwal")[0].label).toBe("'s-Gravendijkwal");
  });

  it("highlights the span that actually matched", () => {
    const [hit] = searchIndex(index, "singel");
    expect(hit.label.slice(hit.at[0], hit.at[1])).toBe("singel");
  });

  it("leaves the span empty when the match only exists spaceless", () => {
    const [hit] = searchIndex(index, "sgravendijkwal");
    expect(hit.at).toEqual([0, 0]);
  });

  it("drops duplicates of the same name and kind, keeping the best", () => {
    const dupes = [e("Kerkstraat", { weight: 100, sub: "a" }), e("Kerkstraat", { weight: 900, sub: "b" })];
    const hits = searchIndex(dupes, "kerkstraat");
    expect(hits).toHaveLength(1);
    expect(hits[0].sub).toBe("b");
  });

  it("keeps the same name under a different kind", () => {
    const both = [e("Beurs"), e("Beurs", { kind: "stop" })];
    expect(searchIndex(both, "beurs")).toHaveLength(2);
  });

  it("honours the limit", () => {
    const many = Array.from({ length: 40 }, (_, i) => e(`Testweg ${i}`));
    expect(searchIndex(many, "testweg", 5)).toHaveLength(5);
  });

  it("matches case- and accent-insensitively", () => {
    const hits = searchIndex([e("Café Plein")], "CAFE");
    expect(hits).toHaveLength(1);
  });
});

describe("stopEntries", () => {
  it("returns nothing when the snapshot has no boards yet", () => {
    expect(stopEntries(undefined)).toEqual([]);
  });

  it("carries the stop's own coordinates through", () => {
    const [entry] = stopEntries({ "sta:1": ["Beurs", 120, -340] });
    expect(entry).toMatchObject({ label: "Beurs", kind: "stop", x: 120, y: -340 });
    expect(entry.norm).toBe("beurs");
  });

  it("skips a stop with no name rather than indexing a blank", () => {
    expect(stopEntries({ a: ["", 1, 2] })).toEqual([]);
  });
});

describe("buildSearchIndex", () => {
  // A four-edge graph covering both selection rules: two Kerkstraats of the
  // same class and different lengths, and a Coolsingel whose named cycleway is
  // longer than its carriageway — the real shape of a Dutch city street.
  const geo = new Float32Array([
    0, 0, 100, 0, 200, 0, // edge 0 — Coolsingel carriageway (primary), 3 points
    0, 50, 10, 50, //        edge 1 — Kerkstraat (short)
    900, 50, 980, 50, //     edge 2 — Kerkstraat (longer)
    0, 90, 600, 90, //       edge 3 — Coolsingel cycleway, longer than edge 0
  ]);
  const data = {
    meta: {
      districts: [{ key: "centrum", name: "Centrum", x: 5, y: 5 }],
    },
    graph: {
      names: ["", "Coolsingel", "Kerkstraat"],
      geo,
      edges: {
        count: 4,
        cls: new Uint8Array([2, 5, 5, 8]), // 2 primary, 5 street, 8 cycleway
        len: new Float32Array([200, 10, 80, 600]),
        geoOff: new Uint32Array([0, 3, 5, 7]),
        geoCount: new Uint16Array([3, 2, 2, 2]),
        district: new Uint8Array([0, 0, 0, 0]),
        nameIdx: new Uint16Array([1, 2, 2, 1]),
      },
    },
    ndw: {
      stations: [{ x: 7, y: 8, name: "RWS A20 Kralingen", lanes: 3 }],
    },
  } as unknown as Parameters<typeof buildSearchIndex>[0];

  const index = buildSearchIndex(data, ["Centrum"]);

  it("indexes each street name once, on its longest stretch", () => {
    const kerk = index.filter((x) => x.label === "Kerkstraat");
    expect(kerk).toHaveLength(1);
    expect(kerk[0].x).toBe(940); // midpoint of edge 2, not edge 1
  });

  it("places a two-point edge mid-segment, not on the junction at its end", () => {
    // edge 2 runs 900 → 980; landing on 980 would be the next street's corner
    expect(index.find((x) => x.label === "Kerkstraat")!.x).toBe(940);
  });

  it("places a multi-point edge on an interior vertex", () => {
    expect(index.find((x) => x.label === "Coolsingel")!.x).toBe(100);
  });

  it("names a street after its carriageway, not the longer cycleway beside it", () => {
    // Dutch streets carry a separate named cycleway, and it is often the longer
    // single stretch because the road itself is cut up at every junction.
    // Length alone made the Coolsingel a "Cycleway · Centrum".
    const cool = index.find((x) => x.label === "Coolsingel")!;
    expect(cool.sub).toBe("Primary · Centrum");
    expect(cool.x).toBe(100); // on edge 0, not the 600m cycleway
  });

  it("still uses length to choose between ways of the same class", () => {
    expect(index.find((x) => x.label === "Kerkstraat")!.x).toBe(940);
  });

  it("skips the empty name slot", () => {
    expect(index.some((x) => x.label === "")).toBe(false);
  });

  it("weights a bigger road above a smaller one", () => {
    const cool = index.find((x) => x.label === "Coolsingel")!;
    const kerk = index.find((x) => x.label === "Kerkstraat")!;
    expect(cool.weight).toBeGreaterThan(kerk.weight);
    expect(cool.sub).toBe("Primary · Centrum");
  });

  it("includes sensor stations and districts", () => {
    expect(index.find((x) => x.kind === "station")?.label).toBe("RWS A20 Kralingen");
    expect(index.find((x) => x.kind === "district")).toMatchObject({ label: "Centrum", x: 5, y: 5 });
  });

  it("produces an index a query can actually be run against", () => {
    expect(searchIndex(index, "coolsingel")[0].label).toBe("Coolsingel");
    expect(searchIndex(index, "centrum")[0].kind).toBe("district");
  });
});
