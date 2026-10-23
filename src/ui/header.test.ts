import { describe, expect, it } from "vitest";
import { buildHeader, readMapNavigation } from "./header";

describe("shared platform navigation", () => {
  it("opens each Intelligence destination in its requested map context", () => {
    const markup = buildHeader({ page: "intelligence" });
    const links = Array.from(markup.matchAll(/href="(\.\.\/[^"]+)"/g), (match) =>
      new URL(match[1].replaceAll("&amp;", "&"), "https://example.test/platform/intelligence/")
    );
    const mapLinks = links.filter((link) => link.pathname === "/platform/");
    expect(mapLinks).toHaveLength(6);
    expect(links.some((link) => link.pathname === "/platform/lab/")).toBe(true);
    expect(mapLinks.map((link) => readMapNavigation(link.search))).toEqual([
      { mode: "live", page: "map" },
      { mode: "sim", page: "map" },
      { mode: "history", page: "map" },
      { mode: "live", page: "brief" },
      { mode: "live", page: "map" },
      { mode: "sim", page: "setup" },
    ]);
    expect(markup).toContain('href="./" aria-current="page">Intelligence</a>');
    expect(buildHeader({ page: "map" })).toContain('href="./lab/">Scenario lab</a>');
  });

  it("ignores unsupported query values instead of passing them to the app", () => {
    expect(readMapNavigation("?mode=unknown&page=intelligence")).toEqual({});
    expect(readMapNavigation("?mode=live&page=%3Cscript%3E")).toEqual({ mode: "live" });
    expect(readMapNavigation("?nosw=1")).toEqual({});
  });

  it("keeps lab and Intelligence navigation in the same platform with one active page", () => {
    for (const page of ["lab", "intelligence"] as const) {
      const markup = buildHeader({ page, mapHref: "/platform/" });
      const navigation = markup.match(/<nav id="topnav"[\s\S]*?<\/nav>/)![0];
      const active = [...navigation.matchAll(/<a[^>]*aria-current="page"[^>]*>([^<]+)<\/a>/g)];
      expect(active.map((match) => match[1])).toEqual([page === "lab" ? "Scenario lab" : "Intelligence"]);
      const links = [...navigation.matchAll(/href="([^"]+)"/g)].map((match) =>
        new URL(match[1].replaceAll("&amp;", "&"), `https://example.test/platform/${page}/`));
      expect(links.map((link) => link.pathname)).toEqual([
        "/platform/", "/platform/", "/platform/", "/platform/intelligence/", "/platform/lab/",
      ]);
      expect(markup).toContain('aria-label="Map modes"');
      expect(markup).not.toContain('<button data-mode=');
    }
  });
});
