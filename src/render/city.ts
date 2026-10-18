// Static city geometry: road ribbons, water, buildings, rail.
// Data coords are (x east, y north) meters; world is (x, up, -y).

import * as THREE from "three";
import earcut from "earcut";
import { parseRoofTile } from "../data/loader";
import type { CityData, PolylineSet, BuildingTile, RoofShell, RoofIndex } from "../data/loader";

// class: motorway, trunk, primary, secondary, tertiary, residential, service,
// pedestrian, cycleway, footpath
const ROAD_WIDTH = [21, 17, 13.5, 11, 9, 6.4, 3.4, 3.2, 2.3, 1.7];
const ROAD_SHADE = [0.6, 0.55, 0.5, 0.43, 0.37, 0.3, 0.18, 0.16, 0.14, 0.115];
const LINE_SHADE = [0.8, 0.74, 0.66, 0.58, 0.5, 0.4, 0.23, 0.2, 0, 0];
export const ROAD_Y = 0.55;

// All flat road surfaces share one plane and never write depth: draw order
// (minor → major, tunnels first, bridges last) resolves overlaps stably, so
// nothing z-fights while the camera moves.
export function buildRoads(roads: PolylineSet): THREE.Mesh {
  let totalPts = 0;
  for (let i = 0; i < roads.count; i++) totalPts += roads.ptCount[i];
  const maxVerts = totalPts * 2;
  const pos = new Float32Array(maxVerts * 3);
  const col = new Uint8Array(maxVerts * 3);
  const idx = new Uint32Array((totalPts - roads.count) * 6);
  let v = 0;
  let ii = 0;

  const c = roads.coords;
  const emit = (i: number) => {
    const n = roads.ptCount[i];
    if (n < 2) return;
    const off = roads.ptOffset[i];
    const cls = roads.cls[i];
    const flags = roads.flags[i];
    const tunnel = (flags & 2) !== 0;
    const bridge = (flags & 1) !== 0;
    const hw = ROAD_WIDTH[cls] / 2;
    let shade = ROAD_SHADE[cls];
    if (tunnel) shade *= 0.42;
    const y = ROAD_Y + (bridge && !tunnel ? 2.6 : 0);
    const g = Math.round(shade * 255);
    const vStart = v;

    for (let k = 0; k < n; k++) {
      const x = c[(off + k) * 2];
      const z = -c[(off + k) * 2 + 1];
      let dx1 = 0, dz1 = 0, dx2 = 0, dz2 = 0;
      if (k > 0) { dx1 = x - c[(off + k - 1) * 2]; dz1 = z - -c[(off + k - 1) * 2 + 1]; }
      if (k < n - 1) { dx2 = c[(off + k + 1) * 2] - x; dz2 = -c[(off + k + 1) * 2 + 1] - z; }
      let tx = dx1 + dx2, tz = dz1 + dz2;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      const nx = -tz, nz = tx;
      let scale = 1;
      if (k > 0 && k < n - 1) {
        const l1 = Math.hypot(dx1, dz1) || 1;
        const l2 = Math.hypot(dx2, dz2) || 1;
        const cos = (dx1 / l1) * (dx2 / l2) + (dz1 / l1) * (dz2 / l2);
        const half = Math.sqrt(Math.max(0.15, (1 + cos) / 2));
        scale = Math.min(2.2, 1 / half);
      }
      const wx = nx * hw * scale, wz = nz * hw * scale;
      pos[v * 3] = x + wx; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z + wz;
      col[v * 3] = g; col[v * 3 + 1] = g; col[v * 3 + 2] = g;
      v++;
      pos[v * 3] = x - wx; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z - wz;
      col[v * 3] = g; col[v * 3 + 1] = g; col[v * 3 + 2] = g;
      v++;
    }
    for (let k = 0; k < n - 1; k++) {
      const a = vStart + k * 2;
      idx[ii++] = a; idx[ii++] = a + 2; idx[ii++] = a + 1;
      idx[ii++] = a + 1; idx[ii++] = a + 2; idx[ii++] = a + 3;
    }
  };

  // painter's order: tunnels, then paths/minor → major, bridges very last
  const buckets: number[][] = [[], [], [], []]; // tunnel, path(8-9), surface by class desc, bridge
  for (let i = 0; i < roads.count; i++) {
    const flags = roads.flags[i];
    if (flags & 2) buckets[0].push(i);
    else if (flags & 1) buckets[3].push(i);
    else if (roads.cls[i] >= 8) buckets[1].push(i);
    else buckets[2].push(i);
  }
  buckets[2].sort((a, b) => roads.cls[b] - roads.cls[a]);
  for (const b of buckets) for (const i of b) emit(i);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos.subarray(0, v * 3), 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col.subarray(0, v * 3), 3, true));
  geo.setIndex(new THREE.BufferAttribute(idx.subarray(0, ii), 1));
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: true, depthWrite: false, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.renderOrder = 3;
  return mesh;
}

/** Filled discs over junction nodes so crossing carriageways read as one solid surface. */
export function buildJunctionPlates(graph: import("../data/loader").Graph): THREE.Mesh {
  const deg = new Uint8Array(graph.nodeCount);
  const wid = new Float32Array(graph.nodeCount);
  const shade = new Float32Array(graph.nodeCount);
  for (let e = 0; e < graph.edges.count; e++) {
    const cls = graph.edges.cls[e];
    if (cls > 6) continue;
    for (const ni of [graph.edges.a[e], graph.edges.b[e]]) {
      deg[ni] = Math.min(250, deg[ni] + 1);
      if (ROAD_WIDTH[cls] > wid[ni]) wid[ni] = ROAD_WIDTH[cls];
      if (ROAD_SHADE[cls] > shade[ni]) shade[ni] = ROAD_SHADE[cls];
    }
  }
  const SEG = 12;
  let count = 0;
  for (let i = 0; i < graph.nodeCount; i++) if (deg[i] >= 3) count++;
  const pos = new Float32Array(count * (SEG + 1) * 3);
  const col = new Uint8Array(count * (SEG + 1) * 3);
  const idx = new Uint32Array(count * SEG * 3);
  let v = 0;
  let ii = 0;
  for (let i = 0; i < graph.nodeCount; i++) {
    if (deg[i] < 3) continue;
    const x = graph.nodesXY[i * 2];
    const z = -graph.nodesXY[i * 2 + 1];
    const r = wid[i] * 0.58 + 1.4;
    const g = Math.round(shade[i] * 255);
    const center = v;
    pos[v * 3] = x; pos[v * 3 + 1] = ROAD_Y; pos[v * 3 + 2] = z;
    col[v * 3] = g; col[v * 3 + 1] = g; col[v * 3 + 2] = g;
    v++;
    for (let s = 0; s < SEG; s++) {
      const a = (s / SEG) * Math.PI * 2;
      pos[v * 3] = x + Math.cos(a) * r;
      pos[v * 3 + 1] = ROAD_Y;
      pos[v * 3 + 2] = z + Math.sin(a) * r;
      col[v * 3] = g; col[v * 3 + 1] = g; col[v * 3 + 2] = g;
      v++;
      idx[ii++] = center;
      idx[ii++] = center + 1 + ((s + 1) % SEG);
      idx[ii++] = center + 1 + s;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3, true));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, fog: true, depthWrite: false, side: THREE.DoubleSide }));
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.renderOrder = 4;
  return mesh;
}

/** 1-px line overlay so every street stays visible at city scale (ribbons go sub-pixel). */
export function buildRoadLines(roads: PolylineSet): THREE.LineSegments {
  let totalPts = 0;
  for (let i = 0; i < roads.count; i++) totalPts += roads.ptCount[i];
  const pos = new Float32Array((totalPts - roads.count) * 2 * 3);
  const col = new Uint8Array((totalPts - roads.count) * 2 * 3);
  let v = 0;
  const c = roads.coords;
  for (let i = 0; i < roads.count; i++) {
    if (roads.cls[i] >= 8) continue; // paths: ribbons only, no far-view lines
    const n = roads.ptCount[i];
    const off = roads.ptOffset[i];
    let shade = LINE_SHADE[roads.cls[i]];
    if (roads.flags[i] & 2) shade *= 0.45; // tunnel
    const g = Math.round(shade * 255);
    const y = 1.3 + (roads.flags[i] & 1 ? 2.6 : 0);
    for (let k = 0; k < n - 1; k++) {
      for (const kk of [k, k + 1]) {
        pos[v * 3] = c[(off + kk) * 2];
        pos[v * 3 + 1] = y;
        pos[v * 3 + 2] = -c[(off + kk) * 2 + 1];
        col[v * 3] = g;
        col[v * 3 + 1] = g;
        col[v * 3 + 2] = g;
        v++;
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos.subarray(0, v * 3), 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col.subarray(0, v * 3), 3, true));
  const mesh = new THREE.LineSegments(
    geo,
    new THREE.LineBasicMaterial({ vertexColors: true, fog: true, transparent: true, opacity: 0.62, depthWrite: false })
  );
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.renderOrder = 5;
  return mesh;
}

export function buildRail(rail: PolylineSet): THREE.LineSegments {
  let totalPts = 0;
  for (let i = 0; i < rail.count; i++) totalPts += rail.ptCount[i];
  const pos = new Float32Array((totalPts - rail.count) * 2 * 3);
  const col = new Uint8Array((totalPts - rail.count) * 2 * 3);
  let v = 0;
  const c = rail.coords;
  for (let i = 0; i < rail.count; i++) {
    const n = rail.ptCount[i];
    const off = rail.ptOffset[i];
    const kind = rail.cls[i];
    const shade = kind === 1 ? 0.21 : 0.17; // tram slightly brighter
    const g = Math.round(shade * 255);
    for (let k = 0; k < n - 1; k++) {
      for (const kk of [k, k + 1]) {
        pos[v * 3] = c[(off + kk) * 2];
        pos[v * 3 + 1] = 0.85;
        pos[v * 3 + 2] = -c[(off + kk) * 2 + 1];
        col[v * 3] = g; col[v * 3 + 1] = g; col[v * 3 + 2] = Math.round(g * 1.12);
        v++;
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos.subarray(0, v * 3), 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col.subarray(0, v * 3), 3, true));
  const mesh = new THREE.LineSegments(
    geo,
    new THREE.LineBasicMaterial({ vertexColors: true, fog: true, transparent: true, opacity: 0.85, depthWrite: false })
  );
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.renderOrder = 5;
  return mesh;
}

export function buildWater(water: { verts: Float32Array; tris: Uint32Array }): THREE.Mesh {
  const n = water.verts.length / 2;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = water.verts[i * 2];
    pos[i * 3 + 1] = 0;
    pos[i * 3 + 2] = -water.verts[i * 2 + 1];
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(water.tris, 1));

  const mat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      fogColor: { value: new THREE.Color(0x0a0a0b) },
      fogNear: { value: 8000 },
      fogFar: { value: 30000 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vW;
      varying float vFogDepth;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vW = wp.xyz;
        vec4 mv = viewMatrix * wp;
        vFogDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vW;
      varying float vFogDepth;
      uniform float uTime;
      uniform vec3 fogColor;
      uniform float fogNear;
      uniform float fogFar;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vnoise(vec2 p){
        vec2 i = floor(p); vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1,0)), f.x), mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), f.x), f.y);
      }
      void main() {
        vec3 base = vec3(0.075, 0.088, 0.1);
        float n1 = vnoise(vW.xz * 0.004 + vec2(uTime * 0.015, 0.0));
        float n2 = vnoise(vW.xz * 0.011 - vec2(0.0, uTime * 0.02));
        float band = sin(vW.x * 0.012 + vW.z * 0.017 + n1 * 9.0 + uTime * 0.25);
        band = smoothstep(0.86, 0.99, band);
        float band2 = sin(vW.x * 0.006 - vW.z * 0.009 + n2 * 7.0 - uTime * 0.18);
        band2 = smoothstep(0.9, 0.995, band2);
        vec3 col = base + vec3(0.075, 0.085, 0.095) * (band * 0.6 + band2 * 0.45) + vec3(0.02) * n2;
        float fogF = smoothstep(fogNear, fogFar, vFogDepth);
        gl_FragColor = vec4(mix(col, fogColor, fogF), 1.0);
      }`,
  });
  mat.depthWrite = false;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = -0.35;
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  mesh.renderOrder = 1;
  return mesh;
}

export function buildGround(extent: { minX: number; minY: number; maxX: number; maxY: number }): THREE.Mesh {
  const w = extent.maxX - extent.minX;
  const h = extent.maxY - extent.minY;
  const geo = new THREE.PlaneGeometry(w * 3, h * 3);
  const mat = new THREE.MeshBasicMaterial({ color: 0x0c0c0d, fog: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set((extent.minX + extent.maxX) / 2, -0.8, -(extent.minY + extent.maxY) / 2);
  return mesh;
}

// -------- buildings: chunked build with shared verts + int16 attrs ----------

const buildingMat = new THREE.ShaderMaterial({
  uniforms: {
    uOrigin: { value: new THREE.Vector2() },
    uAmbient: { value: 1 },
    fogColor: { value: new THREE.Color(0x0a0a0b) },
    fogNear: { value: 8000 },
    fogFar: { value: 30000 },
  },
  vertexShader: /* glsl */ `
    attribute vec3 apos; // x_dm, h_dm, y_dm (north)
    uniform vec2 uOrigin;
    varying vec3 vW;
    varying float vFogDepth;
    varying float vH;
    void main() {
      vec3 wp = vec3(uOrigin.x + apos.x * 0.1, apos.y * 0.1, -(uOrigin.y + apos.z * 0.1));
      vW = wp;
      vH = apos.y * 0.1;
      vec4 mv = viewMatrix * vec4(wp, 1.0);
      vFogDepth = -mv.z;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */ `
    varying vec3 vW;
    varying float vFogDepth;
    varying float vH;
    uniform vec3 fogColor;
    uniform float fogNear;
    uniform float fogFar;
    uniform float uAmbient;
    void main() {
      vec3 fdx = dFdx(vW);
      vec3 fdy = dFdy(vW);
      vec3 N = normalize(cross(fdx, fdy));
      if (!gl_FrontFacing) N = -N; // roof tiles render double-sided
      // stylized monochrome shading
      float top = clamp(N.y, 0.0, 1.0);
      float side = clamp(dot(N, normalize(vec3(0.5, 0.0, 0.62))), 0.0, 1.0);
      float back = clamp(dot(N, normalize(vec3(-0.6, 0.0, -0.4))), 0.0, 1.0);
      vec3 col = vec3(0.088)             // base wall
        + vec3(0.05) * side              // lit side
        - vec3(0.028) * back             // shadow side
        + vec3(0.052) * top;             // roof
      col += vec3(0.07) * clamp(vH / 150.0, 0.0, 1.0);   // towers read lighter
      col *= 0.66 + 0.34 * clamp(vW.y / 8.0, 0.0, 1.0);  // grounded AO
      col *= uAmbient;                                    // sim-clock daylight
      float fogF = smoothstep(fogNear, fogFar, vFogDepth);
      gl_FragColor = vec4(mix(col, fogColor, fogF), 1.0);
    }`,
});

export function syncFog(fog: THREE.Fog) {
  buildingMat.uniforms.fogNear.value = fog.near;
  buildingMat.uniforms.fogFar.value = fog.far;
}

export function setAmbient(v: number) {
  buildingMat.uniforms.uAmbient.value = v;
}

/** Prism (extruded footprint) geometry for a tile; `skip` drops buildings replaced by roof shells. */
function emitPrisms(tile: BuildingTile, skip: Set<number> | null, apos: number[], idx: number[]) {
  for (let b = 0; b < tile.count; b++) {
    if (skip?.has(b)) continue;
    const nv = tile.nVerts[b];
    const off = tile.vertOff[b];
    const h = tile.heights[b];
    if (h === 0) continue; // removed artifact (e.g. bridge structure polygons)
    const base = apos.length / 3;
    for (let k = 0; k < nv; k++) {
      const x = tile.verts[(off + k) * 2];
      const y = tile.verts[(off + k) * 2 + 1];
      apos.push(x, 0, y);
    }
    for (let k = 0; k < nv; k++) {
      const x = tile.verts[(off + k) * 2];
      const y = tile.verts[(off + k) * 2 + 1];
      apos.push(x, h, y);
    }
    // walls
    for (let k = 0; k < nv; k++) {
      const k2 = (k + 1) % nv;
      const b0 = base + k, b1 = base + k2, t0 = base + nv + k, t1 = base + nv + k2;
      idx.push(b0, b1, t1, b0, t1, t0);
    }
    // roof (precomputed earcut indices, CCW)
    const tOff = tile.triOff[b];
    for (let k = 0; k < tile.nTris[b]; k++) {
      idx.push(
        base + nv + tile.tris[(tOff + k) * 3],
        base + nv + tile.tris[(tOff + k) * 3 + 2],
        base + nv + tile.tris[(tOff + k) * 3 + 1]
      );
    }
  }
}

function makeTileMesh(tile: BuildingTile, apos: number[], idx: number[], doubleSide: boolean): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("apos", new THREE.BufferAttribute(Int16Array.from(apos), 3, false));
  const maxIdx = apos.length / 3;
  geo.setIndex(new THREE.BufferAttribute(maxIdx > 65000 ? Uint32Array.from(idx) : Uint16Array.from(idx), 1));
  // bounding sphere in world space for culling
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(tile.ox + 500, 30, -(tile.oy + 500)), 950);

  const mat = buildingMat.clone();
  mat.uniforms.uOrigin.value = new THREE.Vector2(tile.ox, tile.oy);
  mat.uniforms.fogColor = buildingMat.uniforms.fogColor;
  mat.uniforms.fogNear = buildingMat.uniforms.fogNear;
  mat.uniforms.fogFar = buildingMat.uniforms.fogFar;
  mat.uniforms.uAmbient = buildingMat.uniforms.uAmbient;
  if (doubleSide) mat.side = THREE.DoubleSide;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.matrixAutoUpdate = false;
  mesh.renderOrder = 2;
  return mesh;
}

function buildTileMesh(tile: BuildingTile): THREE.Mesh {
  const apos: number[] = [];
  const idx: number[] = [];
  emitPrisms(tile, null, apos, idx);
  return makeTileMesh(tile, apos, idx, false);
}

/**
 * Street-view tile: true LoD2.2 roof surfaces (with skirt walls dropped to the
 * ground) for slanted-roof buildings, prisms for the rest. Coordinates share
 * the prism convention: dm ints against the tile origin.
 */
function buildNearTileMesh(tile: BuildingTile, shells: RoofShell[]): THREE.Mesh {
  const apos: number[] = [];
  const idx: number[] = [];
  const skip = new Set<number>();
  for (const s of shells) skip.add(s.ordinal);
  emitPrisms(tile, skip, apos, idx);

  for (const s of shells) {
    const nV = s.verts.length / 3;
    const base = apos.length / 3;
    // top vertices, then ground copies for the skirts
    for (let k = 0; k < nV; k++) apos.push(s.verts[k * 3], s.verts[k * 3 + 2], s.verts[k * 3 + 1]);
    for (let k = 0; k < nV; k++) apos.push(s.verts[k * 3], 0, s.verts[k * 3 + 1]);
    for (const rings of s.faces) {
      // triangulate the roof face on its XY projection (roof planes are never vertical)
      const flat: number[] = [];
      const holes: number[] = [];
      for (let r = 0; r < rings.length; r++) {
        if (r > 0) holes.push(flat.length / 2);
        for (const vi of rings[r]) flat.push(s.verts[vi * 3], s.verts[vi * 3 + 1]);
      }
      const ringVerts: number[] = [];
      for (const ring of rings) for (const vi of ring) ringVerts.push(vi);
      let tris = earcut(flat, holes.length ? holes : undefined, 2);
      if (!tris.length && rings[0].length >= 3) {
        tris = [];
        for (let k = 1; k < rings[0].length - 1; k++) tris.push(0, k, k + 1);
      }
      for (const t of tris) idx.push(base + ringVerts[t]);
      // skirt: vertical quads from every ring edge down to the ground
      for (const ring of rings) {
        for (let k = 0; k < ring.length; k++) {
          const a = ring[k], b = ring[(k + 1) % ring.length];
          idx.push(base + a, base + b, base + nV + b, base + a, base + nV + b, base + nV + a);
        }
      }
    }
  }
  return makeTileMesh(tile, apos, idx, true);
}

const tileKeyOf = (tile: BuildingTile) => `${Math.round(tile.ox / 1000)}_${Math.round(tile.oy / 1000)}`;

/**
 * Streams true roof tiles in around the camera: within RADIUS_IN of the view
 * target a tile swaps its prism mesh for the LoD2.2 near mesh (fetched and
 * built on first approach), beyond RADIUS_OUT it swaps back. Built tiles stay
 * cached up to CACHE_MAX, then the farthest are disposed.
 */
export class RoofStreamer {
  private states = new Map<string, { tile: BuildingTile; prism: THREE.Mesh; near?: THREE.Mesh; status: "far" | "loading" | "near" | "none" }>();
  private group: THREE.Group;
  private base: string;
  private inflight = 0;
  private lastUpdate = 0;
  static RADIUS_IN = 1700;
  static RADIUS_OUT = 2300;
  static CACHE_MAX = 80;

  constructor(base: string, index: RoofIndex, tiles: BuildingTile[], group: THREE.Group) {
    this.base = base;
    this.group = group;
    const meshByKey = new Map<string, THREE.Mesh>();
    for (const child of group.children) {
      const key = (child as THREE.Mesh).userData.tileKey as string | undefined;
      if (key) meshByKey.set(key, child as THREE.Mesh);
    }
    for (const tile of tiles) {
      const key = tileKeyOf(tile);
      const prism = meshByKey.get(key);
      if (!prism) continue;
      this.states.set(key, { tile, prism, status: index.tiles[key] ? "far" : "none" });
    }
  }

  update(target: THREE.Vector3, now: number) {
    if (now - this.lastUpdate < 250) return;
    this.lastUpdate = now;
    const nearKeys: { key: string; d: number }[] = [];
    for (const [key, st] of this.states) {
      if (st.status === "none") continue;
      const d = Math.hypot(st.tile.ox + 500 - target.x, -(st.tile.oy + 500) - target.z);
      if (st.status === "far" && d < RoofStreamer.RADIUS_IN && this.inflight < 3) this.load(key, st);
      if (st.near) {
        const showNear = d < (st.prism.visible ? RoofStreamer.RADIUS_IN : RoofStreamer.RADIUS_OUT);
        st.near.visible = showNear;
        st.prism.visible = !showNear;
        nearKeys.push({ key, d });
      }
    }
    // evict the farthest cached near meshes beyond the cap
    if (nearKeys.length > RoofStreamer.CACHE_MAX) {
      nearKeys.sort((a, b) => b.d - a.d);
      for (const { key, d } of nearKeys.slice(0, nearKeys.length - RoofStreamer.CACHE_MAX)) {
        const st = this.states.get(key)!;
        if (d < RoofStreamer.RADIUS_OUT) continue;
        this.group.remove(st.near!);
        st.near!.geometry.dispose();
        (st.near!.material as THREE.Material).dispose();
        st.near = undefined;
        st.prism.visible = true;
        st.status = "far";
      }
    }
  }

  private async load(key: string, st: { tile: BuildingTile; prism: THREE.Mesh; near?: THREE.Mesh; status: string }) {
    st.status = "loading";
    this.inflight++;
    try {
      const res = await fetch(`${this.base}roofs/${key}.bin`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const shells = parseRoofTile(await res.arrayBuffer());
      const near = buildNearTileMesh(st.tile, shells);
      releaseToGPU(near.geometry); // streamed in, written once, disposed on the way out
      near.userData.tileKey = key;
      near.visible = false;
      this.group.add(near);
      st.near = near;
      st.status = "near";
    } catch {
      st.status = "none"; // stay on prisms for this tile
    } finally {
      this.inflight--;
    }
  }
}

// rAF stalls in hidden tabs; MessageChannel yields run at full speed anywhere.
const yieldTask = () =>
  new Promise<void>((r) => {
    const mc = new MessageChannel();
    mc.port1.onmessage = () => r();
    mc.port2.postMessage(0);
  });

export async function buildBuildings(
  tiles: BuildingTile[],
  onProgress: (frac: number) => void
): Promise<THREE.Group> {
  const group = new THREE.Group();
  group.matrixAutoUpdate = false;
  let i = 0;
  const CHUNK = 14;
  while (i < tiles.length) {
    const end = Math.min(tiles.length, i + CHUNK);
    for (; i < end; i++) {
      const mesh = buildTileMesh(tiles[i]);
      mesh.userData.tileKey = tileKeyOf(tiles[i]);
      group.add(mesh);
    }
    onProgress(i / tiles.length);
    await yieldTask();
  }
  return group;
}

export function buildDistrictBounds(bounds: import("../data/loader").DistrictBoundary[]): THREE.LineSegments {
  let segs = 0;
  for (const b of bounds) for (const r of b.rings) segs += r.length / 2;
  const pos = new Float32Array(segs * 2 * 3);
  let v = 0;
  for (const b of bounds) {
    for (const ring of b.rings) {
      const n = ring.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        pos[v * 3] = ring[i * 2];
        pos[v * 3 + 1] = 1.0;
        pos[v * 3 + 2] = -ring[i * 2 + 1];
        v++;
        pos[v * 3] = ring[j * 2];
        pos[v * 3 + 1] = 1.0;
        pos[v * 3 + 2] = -ring[j * 2 + 1];
        v++;
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos.subarray(0, v * 3), 3));
  const mesh = new THREE.LineSegments(
    geo,
    new THREE.LineBasicMaterial({ color: 0x3a3d44, transparent: true, opacity: 0.5, fog: true, depthWrite: false })
  );
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.renderOrder = 5;
  return mesh;
}

export interface CityMeshes {
  ground: THREE.Mesh;
  water: THREE.Mesh;
  roads: THREE.Mesh;
  junctions: THREE.Mesh;
  roadLines: THREE.LineSegments;
  rail: THREE.LineSegments;
  buildings: THREE.Group;
}

/**
 * Hand a geometry to the GPU and stop holding a second copy in JavaScript.
 *
 * Three.js keeps every vertex and index array alive on the heap after
 * uploading it, so it can re-upload on demand. For the static city that costs
 * 93 MB — buildings 44, road and water meshes 34, line work 15 — of arrays
 * nothing will ever read again. On a phone that is the difference between the
 * simulation worker being allowed to start and being refused.
 *
 * Only ever for geometry that is written once. Anything with a dynamic
 * attribute (the congestion colours, agent instance buffers, the live vehicle
 * points) must keep its arrays: dropping those would break the next update.
 *
 * The bounding sphere is computed first, because three.js would otherwise
 * derive it lazily from the very array being released. The accepted cost is
 * that a lost WebGL context cannot be restored without a reload.
 */
export function releaseToGPU(geo: THREE.BufferGeometry) {
  if (!geo.boundingSphere) geo.computeBoundingSphere();
  const drop = (a: THREE.BufferAttribute) =>
    a.onUpload(function (this: THREE.BufferAttribute) {
      (this as unknown as { array: null }).array = null;
    });
  for (const a of Object.values(geo.attributes)) drop(a as THREE.BufferAttribute);
  if (geo.index) drop(geo.index);
}

export async function buildCity(
  data: CityData,
  scene: THREE.Scene,
  onStructures: (frac: number) => void
): Promise<CityMeshes> {
  const ground = buildGround(data.meta.extent);
  const water = buildWater(data.water);
  const roads = buildRoads(data.roads);
  const junctions = buildJunctionPlates(data.graph);
  const roadLines = buildRoadLines(data.roads);
  const rail = buildRail(data.rail);
  scene.add(ground, water, roads, junctions, roadLines, rail);
  const buildings = await buildBuildings(data.buildings, onStructures);
  scene.add(buildings);
  for (const m of [ground, water, roads, junctions, roadLines, rail]) releaseToGPU(m.geometry);
  buildings.traverse((o) => {
    const g = (o as THREE.Mesh).geometry;
    if (g) releaseToGPU(g);
  });
  return { ground, water, roads, junctions, roadLines, rail, buildings };
}
