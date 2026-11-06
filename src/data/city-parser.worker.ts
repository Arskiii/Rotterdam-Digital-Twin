import { loadCity, parseBuildings, type Meta } from "./loader";
import { fetchCityBuffer } from "./city-assets";
import { transferableBuffers } from "./transfer";

self.addEventListener("message", async (event: MessageEvent<{ id: number; kind: "base" | "buildings"; base: string; meta: Meta }>) => {
  const { id, kind, base, meta } = event.data;
  try {
    const value = kind === "base"
      ? await loadCity(base, (stage, fraction) => self.postMessage({ id, type: "progress", stage, fraction }), undefined, meta, false)
      : parseBuildings(await fetchCityBuffer(base, "buildings.bin"));
    self.postMessage({ id, type: "result", value }, { transfer: transferableBuffers(value) });
  } catch (error) {
    self.postMessage({ id, type: "error", message: error instanceof Error ? error.message : String(error) });
  }
});
