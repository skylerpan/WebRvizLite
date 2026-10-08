/**
 * OccupancyGrid colour schemes (spec §6.7, rviz map_display.cpp palettes).
 * Each palette is 256 RGBA entries indexed by the int8 cell value
 * reinterpreted as u8 (-1 → 255, -128 → 128).
 */

export type ColorScheme = 'map' | 'costmap' | 'raw';

const UNKNOWN = [0x70, 0x89, 0x86, 255] as const; // -1: blue-green-grey

function set(p: Uint8Array, i: number, r: number, g: number, b: number, a = 255) {
  p[i * 4] = r;
  p[i * 4 + 1] = g;
  p[i * 4 + 2] = b;
  p[i * 4 + 3] = a;
}

function illegalRange(p: Uint8Array) {
  // 101..127: green; 128..254 (other negatives): red → yellow
  for (let i = 101; i <= 127; i++) set(p, i, 0, 255, 0);
  for (let i = 128; i <= 254; i++) set(p, i, 255, Math.round((255 * (i - 128)) / 126), 0);
  set(p, 255, ...UNKNOWN);
}

export function makeMapPalette(): Uint8Array {
  const p = new Uint8Array(256 * 4);
  for (let i = 0; i <= 100; i++) {
    const v = 255 - Math.round((255 * i) / 100); // 0 white → 100 black
    set(p, i, v, v, v);
  }
  illegalRange(p);
  return p;
}

export function makeCostmapPalette(): Uint8Array {
  const p = new Uint8Array(256 * 4);
  set(p, 0, 0, 0, 0, 0); // free: transparent
  for (let i = 1; i <= 98; i++) {
    const v = Math.round((255 * i) / 100);
    set(p, i, v, 0, 255 - v); // blue → red
  }
  set(p, 99, 0, 255, 255); // inscribed: cyan
  set(p, 100, 255, 0, 255); // lethal: purple
  illegalRange(p);
  return p;
}

export function makeRawPalette(): Uint8Array {
  const p = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) set(p, i, i, i, i);
  return p;
}

export function makePalette(scheme: ColorScheme): Uint8Array {
  switch (scheme) {
    case 'map': return makeMapPalette();
    case 'costmap': return makeCostmapPalette();
    case 'raw': return makeRawPalette();
  }
}

/** Binary representation: cells at or above the threshold become 100, the rest 0 (unknown stays). */
export function binarize(src: Uint8Array, threshold: number, out: Uint8Array) {
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    out[i] = v === 255 ? 255 : v >= threshold ? 100 : 0;
  }
}
