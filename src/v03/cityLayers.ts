import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { OsmBuildSummary } from "./osm";
import { siteUrl } from "../ui/platform";

type Point = { lat: number; lon: number };
type TimedPoint = Point & { observedAt: string };
type GeoRing = Array<[number, number]>;
type GeoPolygon = { rings: GeoRing[]; value: number };
type Snapshot = {
  schemaVersion: number;
  health?: { traffic?: { status?: string } };
  traffic?: { retrievedAt: string; readings: Array<TimedPoint & { name: string; vehiclesPerHour: number | null; speedKmh: number | null }> };
  disruptions?: { retrievedAt: string; events: Array<Point & { description: string; detail: string; startsAt: string; endsAt: string | null }> };
  trees?: { retrievedAt: string; trees: Array<Point & { species: string; height: string }> };
  water?: { retrievedAt: string; readings: Array<TimedPoint & { name: string; cmNAP: number }> };
  air?: { retrievedAt: string; reading: Point & { name: string; values: Record<string, { value: number; observedAt: string }> } };
  energy?: { reading: { year: number; region: string; gasM3: number | null; electricityKwh: number | null; districtHeatingPercent: number | null } };
  buildings?: { retrievedAt: string; buildings: Array<{ id: string; rings: GeoRing[]; heightM: number; constructionYear: number | null; status: string }> };
  resilience?: { retrievedAt: string; coolAccess: { columns: number; rows: number; distanceM: Array<number | null> }; floodDepth25cm: GeoPolygon[]; noiseDb: GeoPolygon[] };
};

const sources = {
  traffic: "https://opendata.ndw.nu/",
  disruptions: "https://opendata.ndw.nu/",
  trees: "https://diensten.rotterdam.nl/arcgis/rest/services/SB_Infra/Bomen/MapServer",
  water: "https://rijkswaterstaatdata.nl/waterdata/",
  air: "https://www.luchtmeetnet.nl/meetpunten?component=NO2&station=NL10418",
  energy: "https://www.cbs.nl/nl-nl/cijfers/detail/86333NED",
  buildings: "https://www.openstreetmap.org/copyright",
  threeDBag: "https://3dbag.nl/download",
  resilience: "https://diensten.rotterdam.nl/arcgis/rest/services/SO_IBURO/DGO_data/MapServer",
  transit: "https://www.openstreetmap.org/copyright",
} as const;

function ageMs(value: string | undefined): number {
  const time = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(time) || time > Date.now() + 2 * 60_000) return Infinity;
  return Math.max(0, Date.now() - time);
}

function timeLabel(value: string | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "unknown time";
  return new Date(value).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

function validPoint(point: Point): boolean {
  return Number.isFinite(point.lat) && Number.isFinite(point.lon) &&
    point.lat >= 51.90 && point.lat <= 51.93 && point.lon >= 4.46 && point.lon <= 4.51;
}

function markerGroup(points: Point[], origin: OsmBuildSummary["origin"], color: number, radius: number): THREE.Group {
  const group = new THREE.Group();
  const valid = points.filter(validPoint).slice(0, 1000);
  if (!valid.length) return group;
  const mesh = new THREE.InstancedMesh(
    new THREE.SphereGeometry(radius, 8, 6),
    new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0.3 }),
    valid.length,
  );
  const dummy = new THREE.Object3D();
  for (let i = 0; i < valid.length; i++) {
    const p = project(valid[i], origin);
    dummy.position.set(p.x, radius + 1, p.z);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  group.add(mesh);
  return group;
}

function project(point: Point, origin: OsmBuildSummary["origin"]): { x: number; z: number } {
  return {
    x: (point.lon - origin.lon) * 111320 * Math.cos(origin.lat * Math.PI / 180),
    z: -(point.lat - origin.lat) * 111320,
  };
}

function makeShape(rings: Array<Array<{ x: number; z: number }>>): THREE.Shape | null {
  if (!rings.length || rings[0].length < 3) return null;
  const shape = new THREE.Shape();
  rings[0].forEach((point, i) => i ? shape.lineTo(point.x, -point.z) : shape.moveTo(point.x, -point.z));
  shape.closePath();
  for (const ring of rings.slice(1)) {
    if (ring.length < 3) continue;
    const hole = new THREE.Path();
    ring.forEach((point, i) => i ? hole.lineTo(point.x, -point.z) : hole.moveTo(point.x, -point.z));
    hole.closePath();
    shape.holes.push(hole);
  }
  return shape;
}

function buildBuildings(buildings: Array<{ rings: Array<Array<{ x: number; z: number }>>; heightM: number }>, color = 0x445166): THREE.Group {
  const group = new THREE.Group();
  const geometries: THREE.BufferGeometry[] = [];
  for (const building of buildings) {
    const shape = makeShape(building.rings);
    if (!shape || !Number.isFinite(building.heightM) || building.heightM < 1 || building.heightM > 300) continue;
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: building.heightM, bevelEnabled: false, curveSegments: 1 });
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(0, 0.1, 0);
    geometries.push(geometry);
  }
  const merged = geometries.length ? mergeGeometries(geometries, false) : null;
  geometries.forEach((geometry) => geometry.dispose());
  if (merged) group.add(new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide })));
  return group;
}

function buildPolygonLayer(polygons: GeoPolygon[], origin: OsmBuildSummary["origin"], color: number, elevation: number): THREE.Group {
  const group = new THREE.Group();
  const geometries: THREE.BufferGeometry[] = [];
  for (const polygon of polygons.slice(0, 500)) {
    const shape = makeShape(polygon.rings.map((ring) => ring.map(([lon, lat]) => project({ lon, lat }, origin))));
    if (!shape) continue;
    const geometry = new THREE.ShapeGeometry(shape);
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(0, elevation, 0);
    geometries.push(geometry);
  }
  const merged = geometries.length ? mergeGeometries(geometries, false) : null;
  geometries.forEach((geometry) => geometry.dispose());
  if (merged) group.add(new THREE.Mesh(merged, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide })));
  return group;
}

function buildCoolAccess(grid: NonNullable<Snapshot["resilience"]>["coolAccess"], bbox: OsmBuildSummary["bbox"]): THREE.Group {
  const group = new THREE.Group();
  if (grid.columns < 1 || grid.rows < 1 || grid.columns * grid.rows !== grid.distanceM.length) return group;
  const cellWidth = bbox.widthM / grid.columns;
  const cellHeight = bbox.heightM / grid.rows;
  const values = grid.distanceM.filter((value): value is number => value !== null && Number.isFinite(value));
  if (!values.length) return group;
  const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(cellWidth, cellHeight), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.36, depthWrite: false, side: THREE.DoubleSide }), values.length);
  const dummy = new THREE.Object3D();
  let index = 0;
  for (let row = 0; row < grid.rows; row++) {
    for (let column = 0; column < grid.columns; column++) {
      const value = grid.distanceM[row * grid.columns + column];
      if (value === null || !Number.isFinite(value)) continue;
      dummy.position.set(-bbox.widthM / 2 + (column + 0.5) * cellWidth, 0.25, bbox.heightM / 2 - (row + 0.5) * cellHeight);
      dummy.rotation.x = -Math.PI / 2;
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
      mesh.setColorAt(index, new THREE.Color(value <= 150 ? 0x4acb80 : value <= 300 ? 0xf4ce54 : 0xe56a5b));
      index++;
    }
  }
  mesh.count = index;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  group.add(mesh);
  return group;
}

function buildTrees(trees: Array<Point & { height: string }>, origin: OsmBuildSummary["origin"]): THREE.Group {
  const group = new THREE.Group();
  const valid = trees.filter(validPoint).slice(0, 2500);
  if (!valid.length) return group;
  const crowns = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(2.5, 0), new THREE.MeshLambertMaterial({ color: 0x3b8c64 }), valid.length);
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.22, 0.27, 4, 5), new THREE.MeshLambertMaterial({ color: 0x78634e }), valid.length);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < valid.length; i++) {
    const p = project(valid[i], origin);
    const heights = valid[i].height.match(/\d+(?:\.\d+)?/g)?.slice(0, 2).map(Number) ?? [];
    const height = Math.min(35, Math.max(4, heights.length === 2 ? (heights[0] + heights[1]) / 2 : heights[0] ?? 9));
    const crownScale = height / 9;
    dummy.scale.setScalar(crownScale);
    dummy.position.set(p.x, height * 0.74, p.z);
    dummy.updateMatrix();
    crowns.setMatrixAt(i, dummy.matrix);
    dummy.scale.set(1, height * 0.15, 1);
    dummy.position.y = height * 0.3;
    dummy.updateMatrix();
    trunks.setMatrixAt(i, dummy.matrix);
  }
  crowns.instanceMatrix.needsUpdate = true;
  trunks.instanceMatrix.needsUpdate = true;
  group.add(crowns, trunks);
  return group;
}

function addCard(parent: HTMLElement, title: string, body: string, href: string, detail?: string): HTMLElement {
  const card = document.createElement("div");
  card.className = "data-card";
  const heading = document.createElement("strong");
  heading.textContent = title;
  const link = document.createElement("a");
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "source ↗";
  const line = document.createElement("div");
  line.className = "data-body";
  line.textContent = body;
  card.append(heading, link, line);
  if (detail) {
    const small = document.createElement("small");
    small.textContent = detail;
    card.append(small);
  }
  parent.append(card);
  return card;
}

function addToggle(panel: HTMLElement, label: string, group: THREE.Group, checked = true, expiresAt = Infinity): HTMLInputElement {
  group.visible = checked && Date.now() < expiresAt;
  const row = document.createElement("label");
  row.className = "layer-toggle";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = group.visible;
  input.disabled = Date.now() >= expiresAt;
  input.addEventListener("change", () => {
    // Recheck the deadline even if a background tab has delayed its timer.
    if (Date.now() >= expiresAt) {
      input.checked = false;
      input.disabled = true;
    }
    group.visible = input.checked && !input.disabled;
  });
  row.append(input, document.createTextNode(label));
  panel.append(row);
  return input;
}

export async function installCityLayers(scene: THREE.Scene, summary: OsmBuildSummary, onSnapshot?: (snapshot: Snapshot) => void): Promise<void> {
  const toggles = document.getElementById("city-layer-toggles")!;
  const cards = document.getElementById("city-data-cards")!;
  cards.replaceChildren();
  const buildings = new THREE.Group();
  buildings.add(buildBuildings(summary.buildings.map((b) => ({ rings: [b.points], heightM: b.heightM }))));
  scene.add(buildings);
  addToggle(toggles, `3D buildings (${summary.buildings.length})`, buildings);
  const estimated = summary.buildings.filter((b) => b.heightEstimated).length;
  const buildingCard = addCard(cards, "Buildings · OSM", `${summary.buildings.length} footprints; ${estimated} heights estimated at 12 m where absent.`, sources.buildings);

  const stops = new THREE.Group();
  const stopMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(1.7, 1.7, 0.5, 8), new THREE.MeshLambertMaterial({ color: 0x9b84f7 }), summary.transitStops.length);
  const dummy = new THREE.Object3D();
  summary.transitStops.forEach((stop, i) => {
    dummy.position.set(stop.x, 1, stop.z);
    dummy.updateMatrix();
    stopMesh.setMatrixAt(i, dummy.matrix);
  });
  stopMesh.instanceMatrix.needsUpdate = true;
  stops.add(stopMesh);
  scene.add(stops);
  addToggle(toggles, `Transit stops (${summary.transitStops.length})`, stops);
  addCard(cards, "Public transport · OSM", `${summary.transitStops.length} mapped stops/stations. No live departures yet.`, sources.transit);

  let snapshot: Snapshot;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(siteUrl("data/rotterdam-snapshot.json"), { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    snapshot = await response.json() as Snapshot;
    if (snapshot.schemaVersion !== 1) throw new Error("unsupported snapshot version");
  } catch (error) {
    addCard(cards, "Public data unavailable", `Snapshot could not load: ${String(error)}`, sources.traffic);
    return;
  } finally {
    window.clearTimeout(timeout);
  }
  onSnapshot?.(snapshot);
  const expiring: Array<{ group: THREE.Group; card: HTMLElement; toggle: HTMLInputElement; expiresAt: number }> = [];

  if (snapshot.buildings?.buildings?.length) {
    const official = snapshot.buildings.buildings.filter((b) => b.rings.length && Number.isFinite(b.heightM));
    const mapped = official.map((b) => ({
      rings: b.rings.map((ring) => ring.map(([lon, lat]) => project({ lon, lat }, summary.origin))),
      heightM: b.heightM,
    }));
    buildings.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose());
        else object.material.dispose();
      }
    });
    buildings.clear();
    buildings.add(buildBuildings(mapped, 0x526780));
    const toggle = toggles.querySelector(".layer-toggle");
    if (toggle) toggle.lastChild!.textContent = `3D buildings (${official.length})`;
    buildingCard.querySelector("strong")!.textContent = "Buildings · 3DBAG + BAG";
    buildingCard.querySelector("a")!.href = sources.threeDBag;
    buildingCard.querySelector(".data-body")!.textContent = `${official.length} measured-height building parts; ${official.filter((b) => b.constructionYear).length} linked construction years.`;
    const detail = document.createElement("small");
    detail.textContent = `LoD1.2 roof height above local ground · snapshot ${timeLabel(snapshot.buildings.retrievedAt)}`;
    buildingCard.append(detail);
    document.getElementById("threedbag-attribution")!.hidden = false;
  }

  if (snapshot.resilience) {
    const r = snapshot.resilience;
    const cool = buildCoolAccess(r.coolAccess, summary.bbox);
    scene.add(cool);
    addToggle(toggles, "Cooling access", cool, false);
    const flood = buildPolygonLayer(r.floodDepth25cm, summary.origin, 0x4299ec, 0.35);
    scene.add(flood);
    addToggle(toggles, `Water depth risk (${r.floodDepth25cm.length})`, flood, false);
    const noise = buildPolygonLayer(r.noiseDb.filter((p) => p.value >= 60), summary.origin, 0xe6677f, 0.4);
    scene.add(noise);
    addToggle(toggles, "Noise ≥60 dB", noise, false);
    addCard(cards, "Resilience · Rotterdam GIS", `Cooling-access distance classes, ${r.floodDepth25cm.length} mapped areas with water depth over 25 cm, and ${r.noiseDb.length} noise polygons.`, sources.resilience, `Modelled risk layers · snapshot ${timeLabel(r.retrievedAt)} · not current conditions`);
  }

  if (snapshot.trees) {
    const treeGroup = buildTrees(snapshot.trees.trees ?? [], summary.origin);
    scene.add(treeGroup);
    addToggle(toggles, `City trees (${snapshot.trees.trees.length})`, treeGroup);
    addCard(cards, "City trees · Rotterdam", `${snapshot.trees.trees.length} inventoried trees in this tile.`, sources.trees, `Inventory snapshot ${timeLabel(snapshot.trees.retrievedAt)}`);
  }

  if (snapshot.traffic) {
    const readings = (snapshot.traffic.readings ?? []).filter((r) => validPoint(r) && ageMs(r.observedAt) < 90 * 60_000);
    const expiresAt = Math.min(...readings.map((r) => Date.parse(r.observedAt))) + 90 * 60_000;
    const group = markerGroup(readings, summary.origin, 0x4cc2ff, 3);
    scene.add(group);
    const toggle = addToggle(toggles, `Traffic sensors (${readings.length})`, group, true, readings.length ? expiresAt : 0);
    const summaryText = readings.length ? readings.map((r) => `${r.name}: ${r.speedKmh ?? "—"} km/h, ${r.vehiclesPerHour ?? "—"} veh/h`).join(" · ") : "No recent measurements in this tile.";
    const card = addCard(cards, "Measured traffic · NDW", summaryText, sources.traffic, readings.length ? `Observed ${timeLabel(readings[0].observedAt)} · snapshot, not streaming` : `Last snapshot ${timeLabel(snapshot.traffic.retrievedAt)}`);
    if (readings.length) expiring.push({ group, card, toggle, expiresAt });
  }

  if (snapshot.disruptions) {
    const fresh = ageMs(snapshot.disruptions.retrievedAt) < 24 * 3600_000;
    const events = fresh ? (snapshot.disruptions.events ?? []).filter((e) => validPoint(e) && (!e.endsAt || Date.parse(e.endsAt) > Date.now())) : [];
    const expiresAt = Math.min(Date.parse(snapshot.disruptions.retrievedAt) + 24 * 3600_000,
      ...events.filter((event) => event.endsAt).map((event) => Date.parse(event.endsAt!)));
    const group = markerGroup(events, summary.origin, 0xffa951, 4);
    scene.add(group);
    const toggle = addToggle(toggles, `Road disruptions (${events.length})`, group, true, fresh ? expiresAt : 0);
    const card = addCard(cards, "Roadworks & events · NDW", events.length ? `${events.length} active or upcoming in this tile. ${events.slice(0, 3).map((e) => e.description).join(" · ")}` : fresh ? "No active or upcoming records in this tile." : "Snapshot is old; current status unavailable.", sources.disruptions, `Published snapshot ${timeLabel(snapshot.disruptions.retrievedAt)}`);
    if (fresh) expiring.push({ group, card, toggle, expiresAt });
  }

  if (snapshot.air?.reading) {
    const air = snapshot.air.reading;
    const values = Object.entries(air.values ?? {}).filter(([, v]) => ageMs(v.observedAt) < 4 * 3600_000);
    const expiresAt = Math.min(...values.map(([, value]) => Date.parse(value.observedAt))) + 4 * 3600_000;
    const group = markerGroup(values.length ? [air] : [], summary.origin, 0xef94d1, 4);
    scene.add(group);
    const toggle = addToggle(toggles, "Air station", group, true, values.length ? expiresAt : 0);
    const card = addCard(cards, "Air quality · Luchtmeetnet", values.length ? values.map(([name, value]) => `${name} ${value.value} µg/m³`).join(" · ") : "No recent readings.", sources.air, `${air.name} · ${values.length ? timeLabel(values[0][1].observedAt) : "latest reading unavailable"} · preliminary readings`);
    if (values.length) expiring.push({ group, card, toggle, expiresAt });
  }

  const water = (snapshot.water?.readings ?? []).filter((r) => ageMs(r.observedAt) < 3 * 3600_000);
  const waterCard = addCard(cards, "Water level · Rijkswaterstaat", water.length ? water.slice(0, 3).map((r) => `${r.name}: ${r.cmNAP} cm NAP`).join(" · ") : "No recent valid reading near this tile.", sources.water, water.length ? `Observed ${timeLabel(water[0].observedAt)}` : "Water feed remains unverified for this area");
  if (water.length) {
    const group = markerGroup(water, summary.origin, 0x5b9dff, 4);
    scene.add(group);
    const expiresAt = Math.min(...water.map((r) => Date.parse(r.observedAt))) + 3 * 3600_000;
    const toggle = addToggle(toggles, `Water gauges (${water.length})`, group, true, expiresAt);
    expiring.push({ group, card: waterCard, toggle, expiresAt });
  }

  if (snapshot.energy?.reading) {
    const e = snapshot.energy.reading;
    addCard(cards, `Housing energy · CBS ${e.year}`, `Rotterdam municipality averages: ${e.gasM3 ?? "—"} m³ gas and ${e.electricityKwh ?? "—"} kWh electricity per home; ${e.districtHeatingPercent ?? "—"}% district heating.`, sources.energy, "Citywide annual statistics; not measured for this map tile");
  }
  if (expiring.length) {
    let timer: ReturnType<typeof window.setTimeout>;
    const expire = () => {
      window.clearTimeout(timer);
      for (let i = expiring.length - 1; i >= 0; i--) {
        const item = expiring[i];
        if (Date.now() < item.expiresAt) continue;
        item.group.visible = false;
        item.toggle.checked = false;
        item.toggle.disabled = true;
        const body = item.card.querySelector(".data-body");
        if (body) body.textContent = "One or more records are no longer current; reload for the latest available data.";
        expiring.splice(i, 1);
      }
      if (expiring.length) {
        timer = window.setTimeout(expire, Math.max(0, Math.min(...expiring.map((item) => item.expiresAt)) - Date.now()));
      } else {
        document.removeEventListener("visibilitychange", expire);
      }
    };
    document.addEventListener("visibilitychange", expire);
    expire();
  }
}
