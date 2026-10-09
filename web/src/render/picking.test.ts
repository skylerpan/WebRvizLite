// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { PickRegistry, collectHits, rowStrideTexels } from './picking';

describe('pick readback', () => {
  it('uses 256-byte aligned rows on WebGPU and packed rows on WebGL', () => {
    expect(rowStrideTexels(1, false)).toBe(1);
    expect(rowStrideTexels(1, true)).toBe(16);
    expect(rowStrideTexels(17, true)).toBe(32);
    expect(rowStrideTexels(32, true)).toBe(32);
  });

  it('collects the nearest pixel per (id, instance) honouring the row stride', () => {
    const registry = new PickRegistry();
    const owner = { describeSelection: () => null };
    const obj = new THREE.Object3D();
    const id = registry.register(owner, obj);
    // 2×2 pick with a stride of 16 texels (WebGPU padding): pixels at (row, col) = (0,0), (0,1), (1,0), (1,1).
    const tw = 2, th = 2, stride = 16;
    const px = new Float32Array(stride * th * 4);
    const set = (row: number, col: number, pickId: number, instance: number, depth: number) => {
      const i = (row * stride + col) * 4;
      px[i] = pickId; px[i + 1] = instance; px[i + 2] = depth; px[i + 3] = 1;
    };
    set(0, 0, id, 3, 0.8);
    set(0, 1, id, 3, 0.4); // same key, nearer → wins
    set(1, 0, 0, 0, 0.9); // unregistered surface
    // (1,1) left uncovered (alpha 0).
    // Padding texels beyond tw must be ignored even if they hold junk.
    set(0, 5, 42, 42, 0.1);
    const identity = new THREE.Matrix4();
    const hits = collectHits(px, tw, th, stride, false, true, identity, identity, registry);
    expect(hits).toHaveLength(2);
    const mine = hits.find((h) => h.pickId === id)!;
    expect(mine.instance).toBe(3);
    expect(mine.depth).toBeCloseTo(0.4);
    expect(mine.object).toBe(obj);
    expect(mine.owner).toBe(owner);
    // NDC of pixel (row 0, col 1) with identity matrices: x = 0.5, y = 0.5, z = depth.
    expect(mine.worldPos.x).toBeCloseTo(0.5);
    expect(mine.worldPos.y).toBeCloseTo(0.5);
    expect(mine.worldPos.z).toBeCloseTo(0.4);
    const bg = hits.find((h) => h.pickId === 0)!;
    expect(bg.owner).toBeNull();
    expect(hits.some((h) => h.pickId === 42)).toBe(false);
  });

  it('flips rows for WebGL readbacks', () => {
    const registry = new PickRegistry();
    const px = new Float32Array(2 * 1 * 4);
    px[0] = 0; px[1] = 0; px[2] = 0.5; px[3] = 1; // row 0 of the readback = bottom row on WebGL
    const identity = new THREE.Matrix4();
    const [hit] = collectHits(px, 1, 2, 1, true, false, identity, identity, registry);
    expect(hit.worldPos.y).toBeCloseTo(-0.5);
    expect(hit.worldPos.z).toBeCloseTo(0); // d * 2 - 1
  });
});
