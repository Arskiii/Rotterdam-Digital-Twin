import { describe, expect, it } from "vitest";
import meta from "../public/data/meta.json";
import city from "../city.config.json";
import { DISTRICTS } from "./config";

// The built city data and the city config must describe the same city: the
// district seeds baked into meta.json are what the sim attributes roads to,
// and the UI labels them from the config.
describe("city config", () => {
  it("matches the projection origin the data was built with", () => {
    expect(meta.origin).toEqual(city.origin);
  });

  it("names the same districts, in the same order, at the same seeds", () => {
    const M_PER_LAT = 110574;
    const M_PER_LON = 111320 * Math.cos((city.origin.lat * Math.PI) / 180);
    expect(meta.districts.map((d) => d.key)).toEqual(DISTRICTS.map((d) => d.key));
    meta.districts.forEach((d, i) => {
      expect(Math.abs(d.x - (DISTRICTS[i].lon - city.origin.lon) * M_PER_LON)).toBeLessThan(1);
      expect(Math.abs(d.y - (DISTRICTS[i].lat - city.origin.lat) * M_PER_LAT)).toBeLessThan(1);
    });
  });

  it("has a bbox that contains the origin", () => {
    const { s, w, n, e } = city.bbox;
    expect(s < city.origin.lat && city.origin.lat < n && w < city.origin.lon && city.origin.lon < e).toBe(true);
  });
});
