// Static city geometry: road ribbons, water, buildings, rail.
// Data coords are (x east, y north) meters; world is (x, up, -y).

import * as THREE from "three";
import type { CityData, PolylineSet, BuildingTile } from "../data/loader";

// class: motorway, trunk, primary, secondary, tertiary, residential, service, pedestrian
const ROAD_WIDTH = [21, 17, 13.5, 11, 9, 6.4, 3.4, 3.2];
const ROAD_SHADE = [0.68, 0.63, 0.57, 0.5, 0.44, 0.36, 0.2, 0.18];
const ROAD_Y = [1.15, 1.05, 0.95, 0.85, 0.75, 0.65, 0.5, 0.45];
const LINE_SHADE = [0.8, 0.74, 0.66, 0.58, 0.5, 0.4, 0.23, 0.2];

export function buildRoads(roads: PolylineSet): THREE.Mesh {
  // count verts/tris
  let totalPts = 0;
  for (let i = 0; i < roads.count; i++) totalPts += roads.ptCount[i];
  const maxVerts = totalPts * 2;
  const pos = new Float32Array(maxVerts * 3);
  const col = new Uint8Array(maxVerts * 3);
  const idx = new Uint32Array((totalPts - roads.count) * 6);
  let v = 0;
  let ii = 0;

  const c = roads.coords;
  for (let i = 0; i < roads.count; i++) {
    const n = roads.ptCount[i];
    if (n < 2) continue;
    const off = roads.ptOffset[i];
    const cls = roads.cls[i];
    const flags = roads.flags[i];
    const tunnel = (flags & 2) !== 0;
    const bridge = (flags & 1) !== 0;
    const hw = ROAD_WIDTH[cls] / 2;
    let shade = ROAD_SHADE[cls];
    if (tunnel) shade *= 0.42;
    const y = tunnel ? 0.18 : ROAD_Y[cls] + (bridge ? 2.6 : 0);
    const g = Math.round(shade * 255);
    const vStart = v;

    for (let k = 0; k < n; k++) {
      const x = c[(off + k) * 2];
      const z = -c[(off + k) * 2 + 1];
      // averaged normal (miter, clamped)
      let dx1 = 0, dz1 = 0, dx2 = 0, dz2 = 0;
      if (k > 0) { dx1 = x - c[(off + k - 1) * 2]; dz1 = z - -c[(off + k - 1) * 2 + 1]; }
      if (k < n - 1) { dx2 = c[(off + k + 1) * 2] - x; dz2 = -c[(off + k + 1) * 2 + 1] - z; }
      let tx = dx1 + dx2, tz = dz1 + dz2;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      // normal in XZ plane
      let nx = -tz, nz = tx;
      // miter scale
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
      idx[ii++] = a; idx[ii++] = a + 1; idx[ii++] = a + 2;
      idx[ii++] = a + 1; idx[ii++] = a + 3; idx[ii++] = a + 2;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos.subarray(0, v * 3), 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col.subarray(0, v * 3), 3, true));
  geo.setIndex(new THREE.BufferAttribute(idx.subarray(0, ii), 1));
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
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
    new THREE.LineBasicMaterial({ vertexColors: true, fog: true, transparent: true, opacity: 0.62 })
  );
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
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
        pos[v * 3 + 1] = 0.35;
        pos[v * 3 + 2] = -c[(off + kk) * 2 + 1];
        col[v * 3] = g; col[v * 3 + 1] = g; col[v * 3 + 2] = Math.round(g * 1.12);
        v++;
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos.subarray(0, v * 3), 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col.subarray(0, v * 3), 3, true));
  const mesh = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, fog: true, transparent: true, opacity: 0.85 }));
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
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
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = -0.35;
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
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
    void main() {
      vec3 fdx = dFdx(vW);
      vec3 fdy = dFdy(vW);
      vec3 N = normalize(cross(fdx, fdy));
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
      float fogF = smoothstep(fogNear, fogFar, vFogDepth);
      gl_FragColor = vec4(mix(col, fogColor, fogF), 1.0);
    }`,
});

export function syncFog(fog: THREE.Fog) {
  buildingMat.uniforms.fogNear.value = fog.near;
  buildingMat.uniforms.fogFar.value = fog.far;
}

function buildTileMesh(tile: BuildingTile): THREE.Mesh {
  const V = tile.totalVerts * 2; // bottom + top ring per footprint vertex
  const T = tile.totalTris + tile.totalVerts * 2; // roof + 2 wall tris per edge
  const apos = new Int16Array(V * 3);
  const idx = V > 65000 ? new Uint32Array(T * 3) : new Uint16Array(T * 3);
  let v = 0;
  let ii = 0;
  for (let b = 0; b < tile.count; b++) {
    const nv = tile.nVerts[b];
    const off = tile.vertOff[b];
    const h = tile.heights[b];
    const base = v;
    for (let k = 0; k < nv; k++) {
      const x = tile.verts[(off + k) * 2];
      const y = tile.verts[(off + k) * 2 + 1];
      apos[v * 3] = x; apos[v * 3 + 1] = 0; apos[v * 3 + 2] = y;
      apos[(v + nv) * 3] = x; apos[(v + nv) * 3 + 1] = h; apos[(v + nv) * 3 + 2] = y;
      v++;
    }
    v += nv;
    // walls
    for (let k = 0; k < nv; k++) {
      const k2 = (k + 1) % nv;
      const b0 = base + k, b1 = base + k2, t0 = base + nv + k, t1 = base + nv + k2;
      idx[ii++] = b0; idx[ii++] = b1; idx[ii++] = t1;
      idx[ii++] = b0; idx[ii++] = t1; idx[ii++] = t0;
    }
    // roof (precomputed earcut indices, CCW)
    const tOff = tile.triOff[b];
    for (let k = 0; k < tile.nTris[b]; k++) {
      idx[ii++] = base + nv + tile.tris[(tOff + k) * 3];
      idx[ii++] = base + nv + tile.tris[(tOff + k) * 3 + 2];
      idx[ii++] = base + nv + tile.tris[(tOff + k) * 3 + 1];
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("apos", new THREE.BufferAttribute(apos, 3, false));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  // bounding sphere in world space for culling
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(tile.ox + 500, 30, -(tile.oy + 500)), 950);

  const mat = buildingMat.clone();
  mat.uniforms.uOrigin.value = new THREE.Vector2(tile.ox, tile.oy);
  mat.uniforms.fogColor = buildingMat.uniforms.fogColor;
  mat.uniforms.fogNear = buildingMat.uniforms.fogNear;
  mat.uniforms.fogFar = buildingMat.uniforms.fogFar;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.matrixAutoUpdate = false;
  return mesh;
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
    for (; i < end; i++) group.add(buildTileMesh(tiles[i]));
    onProgress(i / tiles.length);
    await yieldTask();
  }
  return group;
}

export interface CityMeshes {
  ground: THREE.Mesh;
  water: THREE.Mesh;
  roads: THREE.Mesh;
  roadLines: THREE.LineSegments;
  rail: THREE.LineSegments;
  buildings: THREE.Group;
}

export async function buildCity(
  data: CityData,
  scene: THREE.Scene,
  onStructures: (frac: number) => void
): Promise<CityMeshes> {
  const ground = buildGround(data.meta.extent);
  const water = buildWater(data.water);
  const roads = buildRoads(data.roads);
  const roadLines = buildRoadLines(data.roads);
  const rail = buildRail(data.rail);
  scene.add(ground, water, roads, roadLines, rail);
  const buildings = await buildBuildings(data.buildings, onStructures);
  scene.add(buildings);
  return { ground, water, roads, roadLines, rail, buildings };
}
