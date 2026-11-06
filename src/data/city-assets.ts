// Only bundled, same-origin city files use this build's content versions. The
// fallback mirror is pinned to a Git commit and may contain a different city.
export class CityVersionError extends Error {
  constructor() { super("City data changed during loading. Please reload to get the latest build."); }
}

function versionFor(base: string, path: string): string | undefined {
  if (new URL(base, location.href).origin !== location.origin) return undefined;
  return __CITY_ASSET_VERSIONS__[path.startsWith("roofs/") ? "roofs/" : path];
}

export function cityAssetUrl(base: string, path: string): string {
  const url = new URL(path, new URL(base, location.href));
  const version = versionFor(base, path);
  if (version) url.searchParams.set("v", version);
  return url.href;
}

/** Overlap the map's large downloads with its lazy module, only when it is opened. */
export function preloadCity(base: string): void {
  for (const path of ["graph.bin", "roads.bin"]) {
    if (document.querySelector(`link[data-city-preload="${path}"]`)) continue;
    const link = document.createElement("link");
    link.rel = "preload";
    link.as = "fetch";
    link.crossOrigin = "anonymous";
    link.href = cityAssetUrl(base, path);
    link.dataset.cityPreload = path;
    document.head.append(link);
  }
}

export async function fetchCityBuffer(
  base: string,
  path: string,
  onProgress: (fraction: number) => void = () => {},
  timeoutMs = 120_000,
): Promise<ArrayBuffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`${path}: download timed out. Please reload to retry.`)), timeoutMs);
  try {
    const response = await fetch(cityAssetUrl(base, path), { signal: controller.signal });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    const total = Number(response.headers.get("Content-Length") ?? 0);
    let buffer: ArrayBuffer;
    if (!response.body || !total) {
      buffer = await response.arrayBuffer();
    } else {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.byteLength;
        onProgress(Math.min(1, received / total));
      }
      const bytes = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      buffer = bytes.buffer;
    }
    const expected = versionFor(base, path);
    // Roofs share a directory version; core files have individual digests. A
    // stale tab crossing a deployment must not combine two different graphs.
    if (expected && !path.startsWith("roofs/") && crypto.subtle) {
      const digest = await crypto.subtle.digest("SHA-256", buffer);
      const actual = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      if (actual !== expected) throw new CityVersionError();
    }
    onProgress(1);
    return buffer;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchCityJson<T>(base: string, path: string, timeoutMs = 10_000): Promise<T> {
  const buffer = await fetchCityBuffer(base, path, undefined, timeoutMs);
  return JSON.parse(new TextDecoder().decode(buffer)) as T;
}
