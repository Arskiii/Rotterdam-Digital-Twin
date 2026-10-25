import { describe, expect, it } from "vitest";
import { buildHeader, readMapNavigation } from "./header";
import { normalizePlatformRoute, platformRouteUrl, readPlatformRoute } from "./navigation";

const root = new URL("https://example.test/Rotterdam-Digital-Twin/");

describe("persistent platform navigation", () => {
  it("offers all five destinations as local view switches with one active page", () => {
    for (const page of ["map", "brief", "setup", "intelligence", "lab"] as const) {
      const markup = buildHeader({ page });
      const navigation = markup.match(/<nav id="topnav"[\s\S]*?<\/nav>/)![0];
      expect([...navigation.matchAll(/data-page="([^"]+)"/g)].map(m => m[1])).toEqual(["brief", "map", "setup", "intelligence", "lab"]);
      expect([...navigation.matchAll(/<button[^>]*aria-current="page"/g)]).toHaveLength(1);
      expect(navigation).toContain(`data-page="${page}" aria-current="page"`);
      expect(navigation).not.toContain("href=");
    }
  });

  it("accepts workspace deep links and ignores unsupported query values", () => {
    expect(readMapNavigation("?mode=sim&page=lab")).toEqual({ mode: "sim", page: "lab" });
    expect(readMapNavigation("?mode=live&page=intelligence")).toEqual({ mode: "live", page: "intelligence" });
    expect(readMapNavigation("?mode=unknown&page=%3Cscript%3E")).toEqual({});
    expect(readMapNavigation("?nosw=1")).toEqual({});
  });

  it("opens Setup in Simulation from any mode, including direct links and restored history", () => {
    for (const mode of ["live", "history", "sim"] as const) {
      const target = readPlatformRoute(new URL(`?page=setup&mode=${mode}`, root), root)!;
      const route = normalizePlatformRoute({ page: target.page, mode: target.mode! });
      expect(route).toEqual({ page: "setup", mode: "sim" });
      expect(readPlatformRoute(platformRouteUrl(root, root, route), root)).toEqual(route);
    }
  });

  it("releases the Setup mode lock on every other page and respects unavailable simulation", () => {
    for (const page of ["map", "brief", "intelligence", "lab"] as const) {
      for (const mode of ["live", "history", "sim"] as const) {
        expect(normalizePlatformRoute({ page, mode })).toEqual({ page, mode });
      }
    }
    expect(normalizePlatformRoute({ page: "setup", mode: "sim" }, false)).toEqual({ page: "map", mode: "live" });
    expect(normalizePlatformRoute({ page: "map", mode: "history" }, false)).toEqual({ page: "map", mode: "history" });
  });

  it("resolves old paths and root links at both domain and repository roots", () => {
    for (const base of [root, new URL("https://example.test/")]) {
      for (const [path, page] of [["", "map"], ["index.html", "map"], ["lab/", "lab"],
        ["lab/index.html", "lab"], ["intelligence/", "intelligence"], ["intelligence/index.html", "intelligence"]]) {
        expect(readPlatformRoute(new URL(path, base), base)?.page).toBe(page);
      }
      expect(readPlatformRoute(new URL("?page=setup&mode=sim", base), base)).toEqual({ page: "setup", mode: "sim" });
      expect(readPlatformRoute(new URL("v03/", base), base)).toBeNull();
      expect(readPlatformRoute(new URL("https://other.test/lab/"), base)).toBeNull();
    }
  });

  it("retains handoffs and section bookmarks while canonicalizing the document URL", () => {
    const current = new URL("lab/?corridor=road-12&handoff=saved&nosw=1#observations", root);
    const next = platformRouteUrl(current, root, { page: "lab", mode: "live" }, "#results-panel");
    expect(next.pathname).toBe(root.pathname);
    expect(next.searchParams.get("corridor")).toBe("road-12");
    expect(next.searchParams.get("handoff")).toBe("saved");
    expect(next.searchParams.get("nosw")).toBe("1");
    expect(next.hash).toBe("#results-panel");
    expect(readPlatformRoute(next, root)).toEqual({ page: "lab", mode: "live" });
    const map = platformRouteUrl(next, root, { page: "map", mode: "sim" });
    expect(map.hash).toBe("");
    expect(readPlatformRoute(map, root)).toEqual({ page: "map", mode: "sim" });
  });
});
