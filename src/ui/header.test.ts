import { describe, expect, it } from "vitest";
import { buildHeader, readMapNavigation } from "./header";

describe("shared platform navigation", () => {
  it("opens each Intelligence destination in its requested map context", () => {
    const markup = buildHeader({ page: "intelligence" });
    const links = Array.from(markup.matchAll(/href="(\.\.\/[^"]+)"/g), (match) =>
      new URL(match[1].replaceAll("&amp;", "&"), "https://example.test/platform/intelligence/")
    );
    expect(links.map((link) => link.pathname)).toEqual(Array(6).fill("/platform/"));
    expect(links.map((link) => readMapNavigation(link.search))).toEqual([
      { mode: "live", page: "map" },
      { mode: "sim", page: "map" },
      { mode: "history", page: "map" },
      { mode: "live", page: "brief" },
      { mode: "live", page: "map" },
      { mode: "sim", page: "setup" },
    ]);
    expect(markup).toContain('href="./" aria-current="page">Intelligence</a>');
  });

  it("ignores unsupported query values instead of passing them to the app", () => {
    expect(readMapNavigation("?mode=unknown&page=intelligence")).toEqual({});
    expect(readMapNavigation("?mode=live&page=%3Cscript%3E")).toEqual({ mode: "live" });
    expect(readMapNavigation("?nosw=1")).toEqual({});
  });
});
