import { readMapNavigation, type MapMode, type MapPage } from "./header";

export interface PlatformRoute { page: MapPage; mode: MapMode }

export function isWorkspace(page: MapPage): page is "intelligence" | "lab" {
  return page === "intelligence" || page === "lab";
}

/** Legacy URLs and shared root links enter the same in-document router. */
export function readPlatformRoute(url: URL, root: URL): Partial<PlatformRoute> & { page: MapPage } | null {
  if (url.origin !== root.origin) return null;
  const paths = new Map<string, MapPage>([
    [root.pathname, "map"], [new URL("index.html", root).pathname, "map"],
    [new URL("intelligence/", root).pathname, "intelligence"],
    [new URL("lab/", root).pathname, "lab"],
  ]);
  const fallback = paths.get(url.pathname);
  if (!fallback) return null;
  const params = readMapNavigation(url.search);
  return { mode: params.mode, page: params.page ?? fallback };
}

export function platformRouteUrl(current: URL, root: URL, route: PlatformRoute, hash = ""): URL {
  const next = new URL(root);
  next.search = current.search; // retain corridor handoffs and supported deployment options
  next.searchParams.set("page", route.page);
  next.searchParams.set("mode", route.mode);
  next.hash = hash;
  return next;
}
