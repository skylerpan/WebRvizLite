import type { Rgb } from './types';

/** Qt named colours RViz configs are likely to contain (QColor::setNamedColor subset). */
const NAMED: Record<string, Rgb> = {
  white: { r: 255, g: 255, b: 255 },
  black: { r: 0, g: 0, b: 0 },
  red: { r: 255, g: 0, b: 0 },
  green: { r: 0, g: 128, b: 0 },
  blue: { r: 0, g: 0, b: 255 },
  cyan: { r: 0, g: 255, b: 255 },
  magenta: { r: 255, g: 0, b: 255 },
  yellow: { r: 255, g: 255, b: 0 },
  gray: { r: 128, g: 128, b: 128 },
  grey: { r: 128, g: 128, b: 128 },
  darkyellow: { r: 128, g: 128, b: 0 },
  darkred: { r: 128, g: 0, b: 0 },
  darkgreen: { r: 0, g: 100, b: 0 },
  darkblue: { r: 0, g: 0, b: 139 },
  darkgray: { r: 169, g: 169, b: 169 },
  lightgray: { r: 211, g: 211, b: 211 },
  orange: { r: 255, g: 165, b: 0 },
};

const clamp255 = (n: number) => Math.min(255, Math.max(0, Math.round(n)));

/** rviz_common parseColor: "r; g; b", Qt colour names, or "#rrggbb". Null when unparsable. */
export function parseColor(text: string): Rgb | null {
  const s = text.trim();
  if (s.includes(';')) {
    const parts = s.split(';').map((p) => Number(p.trim()));
    if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
      return { r: clamp255(parts[0]), g: clamp255(parts[1]), b: clamp255(parts[2]) };
    }
    return null;
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(s);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  return NAMED[s.toLowerCase()] ?? null;
}

/** rviz_common printColor: "r; g; b". */
export function printColor(c: Rgb): string {
  return `${c.r}; ${c.g}; ${c.b}`;
}

export function colorToHex(c: Rgb): string {
  return '#' + [c.r, c.g, c.b].map((v) => clamp255(v).toString(16).padStart(2, '0')).join('');
}
