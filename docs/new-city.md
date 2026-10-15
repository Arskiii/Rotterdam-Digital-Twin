# Building a second city

The coverage area, projection origin, district seeds, map label and time zone
live in [`city.config.json`](../city.config.json). Build scripts read it through
`scripts/lib/city.mjs`; the app reads it through `src/config.ts` at build
time. To build another city, replace `city.config.json` in a separate checkout
or branch, then rebuild the data:

```sh
npm run fetch-data && npm run build-data
```

Scripts also accept `CITY_CONFIG=path/to/city.json` for a one-off run, but the
app always bundles `city.config.json`, and outputs always go to `data/` and
`public/data/`. `src/config.test.ts` fails when the built `public/data/meta.json` and the
config disagree on origin or districts, so a half-switched build is caught.

## Sources that work for any Dutch city

These are national and need only the bbox: OpenStreetMap (roads, signals,
water, rail, buildings), 3D BAG heights and LoD2 roofs, NDW sensors and
situations, the NWB road check, the UDAP iVRI registry, and OVapi GTFS and
GTFS-RT.

## Still Rotterdam-specific

These need per-city work before a second city is complete:

| Item | Where | What changes |
| --- | --- | --- |
| Transit operator and timetable | `scripts/fetch-gtfs-*.mjs`, `scripts/fetch-live.mjs`, `data/ret-timetable.bin` | RET routes, stations and departure boards; Amsterdam needs GVB. |
| Water level gauge | `scripts/fetch-live.mjs` (`rotterdam.nieuwemaas.boompjes`) | Pick the nearest Rijkswaterstaat gauge. |
| Weather station | `scripts/fetch-live.mjs` (Buienradar station 6344) | Pick the nearest Buienradar station. |
| Heat, flood and noise maps | `scripts/fetch-resilience.mjs` (Rotterdam DGO GIS) | City-owned GIS; another city publishes different layers or none. |
| Flood exposure sample | `scripts/build-exposure.py`, `public/data/exposure.json` | Depends on the resilience layers above. |
| Neighbourhood figures | `scripts/fetch-*-neighborhoods.py` (GM0599) | Use the CBS municipality code in `cbsMunicipality`. |
| Hospitals for access checks | `src/intelligence/routing.ts` | List the city's emergency hospitals with sources. |
| Skyline landmark heights | `scripts/landmark-heights.json` | Published heights for the city's towers. |
| Drone units | `src/config.ts` (`UNITS`) | Display fleet keyed to district keys. |
