import { describe, expect, it } from "vitest";
import { parseBuildings, parsePolylines } from "./loader";

function binary() {
  const buffer = new ArrayBuffer(256), view = new DataView(buffer); let position = 0;
  return {
    u8(v: number) { view.setUint8(position++, v); },
    u16(v: number) { view.setUint16(position, v, true); position += 2; },
    i16(v: number) { view.setInt16(position, v, true); position += 2; },
    u32(v: number) { view.setUint32(position, v, true); position += 4; },
    f32(v: number) { view.setFloat32(position, v, true); position += 4; },
    done() { return buffer.slice(0, position); },
  };
}
describe("exact-size binary city parsing", () => {
  it("preserves road geometry, classes, flags and offsets across variable-length records", () => {
    const b = binary(); b.u32(0x524d5452); b.u32(2);
    b.u8(3); b.u8(1); b.u16(2); [1.5, -2, 10, 30].forEach(b.f32);
    b.u8(6); b.u8(2); b.u16(1); [-5, 9].forEach(b.f32);
    const bytes = b.done(), data = parsePolylines(bytes, 0x524d5452);
    expect(data).toEqual({ count: 2, cls: new Uint8Array([3, 6]), flags: new Uint8Array([1, 2]),
      ptOffset: new Uint32Array([0, 2]), ptCount: new Uint32Array([2, 1]), coords: new Float32Array([1.5, -2, 10, 30, -5, 9]) });
    expect(() => parsePolylines(bytes.slice(0, -1), 0x524d5452)).toThrow();
    expect(() => parsePolylines(new Uint8Array([...new Uint8Array(bytes), 0]).buffer, 0x524d5452)).toThrow();
  });
  it("packs adjacent building vertices and triangles without losing signed coordinates", () => {
    const b = binary(); b.u32(0x424d5452); b.u32(1); b.f32(800); b.f32(-100); b.u32(2);
    b.u16(150); b.u8(3); b.u8(1); [-20, 5, 30, 5, 0, 40].forEach(b.i16); [0, 1, 2].forEach(b.u8);
    b.u16(300); b.u8(4); b.u8(2); [0, 0, 20, 0, 20, 20, 0, 20].forEach(b.i16); [0, 1, 2, 0, 2, 3].forEach(b.u8);
    const bytes = b.done(), [tile] = parseBuildings(bytes);
    expect(tile.ox).toBe(800); expect(tile.oy).toBe(-100); expect(tile.count).toBe(2);
    expect([...tile.heights]).toEqual([150, 300]); expect([...tile.vertOff]).toEqual([0, 3]); expect([...tile.triOff]).toEqual([0, 1]);
    expect([...tile.verts]).toEqual([-20, 5, 30, 5, 0, 40, 0, 0, 20, 0, 20, 20, 0, 20]);
    expect([...tile.tris]).toEqual([0, 1, 2, 0, 1, 2, 0, 2, 3]);
    expect(tile.totalVerts).toBe(7); expect(tile.totalTris).toBe(3);
    expect(() => parseBuildings(bytes.slice(0, -1))).toThrow();
    expect(() => parseBuildings(new Uint8Array([...new Uint8Array(bytes), 0]).buffer)).toThrow();
  });
});
