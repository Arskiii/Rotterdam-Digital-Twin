import * as THREE from "three";

export type ResilienceKind = "cooling" | "flood" | "noise";
const KINDS: ResilienceKind[] = ["cooling", "flood", "noise"];

export interface ResilienceIndex {
  schemaVersion: 1;
  retrievedAt: string;
  source: string;
  modelledNotLive: true;
  image: { cornersLocal: [[number, number], [number, number], [number, number], [number, number]] };
}

export function parseResilienceIndex(value: unknown): ResilienceIndex {
  if (!value || typeof value !== "object") throw new Error("Missing resilience metadata");
  const index = value as Partial<ResilienceIndex>;
  const corners = index.image?.cornersLocal;
  if (index.schemaVersion !== 1 || index.modelledNotLive !== true ||
      typeof index.retrievedAt !== "string" || !Number.isFinite(Date.parse(index.retrievedAt)) ||
      typeof index.source !== "string" || !index.source.startsWith("https://diensten.rotterdam.nl/") ||
      !Array.isArray(corners) || corners.length !== 4 ||
      !corners.every((point) => Array.isArray(point) && point.length === 2 &&
        point.every((number) => typeof number === "number" && Number.isFinite(number) && Math.abs(number) < 50_000))) {
    throw new Error("Invalid resilience metadata");
  }
  return index as ResilienceIndex;
}

export function resilienceGeometry(corners: ResilienceIndex["image"]["cornersLocal"], elevation = 1.8): THREE.BufferGeometry {
  // GIS image is north-up: bottom-left, bottom-right, top-right, top-left.
  // City coordinates use +Y north, while Three.js uses -Z north.
  const positions = new Float32Array(corners.flatMap(([x, y]) => [x, elevation, -y]));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geometry.setIndex([0, 2, 1, 0, 3, 2]);
  geometry.computeVertexNormals();
  return geometry;
}

/** Loads each static GIS surface only when the operator first enables it. */
export class ResilienceLayers {
  private index: Promise<ResilienceIndex> | null = null;
  private meshes = new Map<ResilienceKind, THREE.Mesh>();
  private pending = new Map<ResilienceKind, Promise<void>>();
  private wanted = new Map<ResilienceKind, boolean>();

  constructor(private dataBase: string, private scene: THREE.Scene) {}

  async set(kind: ResilienceKind, visible: boolean): Promise<void> {
    if (!KINDS.includes(kind)) throw new Error("Unknown resilience layer");
    this.wanted.set(kind, visible);
    const held = this.meshes.get(kind);
    if (held) { held.visible = visible; return; }
    if (!visible) return;
    const pending = this.pending.get(kind);
    if (pending) return pending;
    const task = this.load(kind).finally(() => this.pending.delete(kind));
    this.pending.set(kind, task);
    return task;
  }

  private async load(kind: ResilienceKind): Promise<void> {
    this.index ??= fetch(`${this.dataBase}resilience/index.json`)
      .then((response) => {
        if (!response.ok) throw new Error(`GIS metadata HTTP ${response.status}`);
        return response.json();
      })
      .then(parseResilienceIndex);
    let index: ResilienceIndex;
    try { index = await this.index; }
    catch (error) { this.index = null; throw error; }
    const texture = await new THREE.TextureLoader().loadAsync(`${this.dataBase}resilience/${kind}.png`);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true,
      opacity: kind === "cooling" ? 0.45 : 0.8, depthWrite: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(resilienceGeometry(index.image.cornersLocal), material);
    mesh.name = `modelled-${kind}`;
    mesh.renderOrder = 3;
    mesh.visible = this.wanted.get(kind) === true;
    this.meshes.set(kind, mesh);
    this.scene.add(mesh);
  }
}
