import { siteUrl } from "../ui/siteUrl";

const PUBLIC_DATA_URL = "https://raw.githubusercontent.com/Arskiii/Rotterdam-Digital-Twin/corridor-data/";
export const PUBLIC_SNAPSHOT_URL = `${PUBLIC_DATA_URL}rotterdam-snapshot.json`;

/** The collector's public layers are published independently of both frontends. */
export async function loadPublishedData<T>(path: string, valid: (value: T) => boolean): Promise<T> {
  for (const url of [`${PUBLIC_DATA_URL}${path}`, siteUrl(`data/${path}`)]) {
    try {
      const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (!response.ok) continue;
      const value = await response.json() as T;
      if (valid(value)) return value;
    } catch { /* A dated bundled copy remains useful for reference geometry. */ }
  }
  throw new Error("Public data sources are unavailable");
}

export function loadPublicSnapshot<T extends { schemaVersion: number }>(): Promise<T> {
  return loadPublishedData<T>("rotterdam-snapshot.json", (value) => value?.schemaVersion === 1);
}
