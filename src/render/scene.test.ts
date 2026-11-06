import { expect, it, vi } from "vitest";
import { PerspectiveCamera } from "three";
import { SceneCtx } from "./scene";

it("projects map labels without layout reads and follows the next canvas resize", () => {
  let width = 1280, height = 720, reads = 0;
  const canvas = {
    get clientWidth() { reads++; return width; },
    get clientHeight() { reads++; return height; },
  };
  // Exercise projection and resizing without allocating a WebGL context.
  const scene = Object.create(SceneCtx.prototype) as SceneCtx;
  Object.assign(scene, {
    pixelRatioOverride: 1,
    renderer: { domElement: canvas, setPixelRatio: vi.fn(), setSize: vi.fn() },
    camera: new PerspectiveCamera(46, width / height, 1, 1000),
  });
  scene.camera.position.set(0, 10, 10);
  scene.camera.lookAt(0, 0, 0);
  scene.camera.updateMatrixWorld();
  scene.resize();
  const out = { x: 0, y: 0 };
  const readsAfterResize = reads;
  for (let i = 0; i < 100; i++) expect(scene.project(0, 0, 0, out)).toBe(true);
  expect(reads).toBe(readsAfterResize);
  expect(out.x).toBeCloseTo(640);
  expect(out.y).toBeCloseTo(360);
  width = 800; height = 600;
  scene.resize();
  scene.project(0, 0, 0, out);
  expect(out.x).toBeCloseTo(400);
  expect(out.y).toBeCloseTo(300);
  width = 0; height = 0;
  scene.resize();
  scene.project(0, 0, 0, out);
  expect(out.x).toBeCloseTo(400);
  expect(out.y).toBeCloseTo(300);
});
