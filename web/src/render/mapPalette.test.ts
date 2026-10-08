import { describe, expect, it } from 'vitest';
import { binarize, makeCostmapPalette, makeMapPalette, makeRawPalette } from './mapPalette';

const rgba = (p: Uint8Array, i: number) => [p[i * 4], p[i * 4 + 1], p[i * 4 + 2], p[i * 4 + 3]];

describe('OccupancyGrid palettes (spec §6.7)', () => {
  it('raw: linear grey, all opaque', () => {
    const p = makeRawPalette();
    expect(rgba(p, 0)).toEqual([0, 0, 0, 255]);
    expect(rgba(p, 255)).toEqual([255, 255, 255, 255]);
    expect(rgba(p, 128)).toEqual([128, 128, 128, 255]);
  });

  it('map: 0 white → 100 black, -1 blue-green-grey, 101–127 green, other negatives red→yellow', () => {
    const p = makeMapPalette();
    expect(rgba(p, 0)).toEqual([255, 255, 255, 255]);
    expect(rgba(p, 100)).toEqual([0, 0, 0, 255]);
    expect(rgba(p, 50)).toEqual([127, 127, 127, 255]);
    expect(rgba(p, 255)).toEqual([0x70, 0x89, 0x86, 255]);
    expect(rgba(p, 101)).toEqual([0, 255, 0, 255]);
    expect(rgba(p, 127)).toEqual([0, 255, 0, 255]);
    expect(rgba(p, 128)).toEqual([255, 0, 0, 255]);
    expect(rgba(p, 254)).toEqual([255, 255, 0, 255]);
  });

  it('costmap: 0 transparent, 1–98 blue→red, 99 cyan, 100 purple, -1 blue-green-grey', () => {
    const p = makeCostmapPalette();
    expect(rgba(p, 0)).toEqual([0, 0, 0, 0]);
    expect(rgba(p, 1)).toEqual([3, 0, 252, 255]);
    expect(rgba(p, 98)).toEqual([250, 0, 5, 255]);
    expect(rgba(p, 99)).toEqual([0, 255, 255, 255]);
    expect(rgba(p, 100)).toEqual([255, 0, 255, 255]);
    expect(rgba(p, 255)).toEqual([0x70, 0x89, 0x86, 255]);
    expect(rgba(p, 110)).toEqual([0, 255, 0, 255]);
  });

  it('binarize applies the threshold and keeps unknown', () => {
    const out = new Uint8Array(4);
    binarize(new Uint8Array([0, 99, 100, 255]), 100, out);
    expect([...out]).toEqual([0, 0, 100, 255]);
    binarize(new Uint8Array([0, 99, 100, 255]), 50, out);
    expect([...out]).toEqual([0, 100, 100, 255]);
  });
});
