/**
 * three.js layer bits for per-camera visibility (Camera display "Visibility").
 * Bit 0 is the main view; bits 1..31 are handed out to Camera displays.
 */

const free: number[] = [];
let next = 1;

export function allocLayer(): number {
  const bit = free.pop() ?? next++;
  if (bit > 31) throw new Error('no free render layers (max 31 camera views)');
  return bit;
}

export function releaseLayer(bit: number) {
  if (bit >= 1 && bit <= 31) free.push(bit);
}
