/**
 * Minimal URDF parser (links, joints, visuals, collisions, inertials,
 * materials) for the RobotModel display. Parsed with DOMParser on the main
 * thread: a robot description arrives once and is small.
 */

export interface UrdfOrigin {
  xyz: [number, number, number];
  rpy: [number, number, number];
}

export type UrdfGeometry =
  | { type: 'box'; size: [number, number, number] }
  | { type: 'cylinder'; radius: number; length: number }
  | { type: 'sphere'; radius: number }
  | { type: 'mesh'; filename: string; scale: [number, number, number] };

export interface UrdfVisual {
  name: string;
  origin: UrdfOrigin;
  geometry: UrdfGeometry;
  /** rgba 0..1 from an inline or named material, if any. */
  color: [number, number, number, number] | null;
}

export interface UrdfInertial {
  origin: UrdfOrigin;
  mass: number;
  /** ixx, ixy, ixz, iyy, iyz, izz */
  inertia: [number, number, number, number, number, number];
}

export interface UrdfLink {
  name: string;
  visuals: UrdfVisual[];
  collisions: UrdfVisual[];
  inertial: UrdfInertial | null;
}

export interface UrdfJoint {
  name: string;
  type: string;
  parent: string;
  child: string;
  origin: UrdfOrigin;
  axis: [number, number, number];
  limit: { lower: number; upper: number; effort: number; velocity: number } | null;
}

export interface UrdfModel {
  name: string;
  links: Map<string, UrdfLink>;
  joints: Map<string, UrdfJoint>;
  /** Root links (no parent joint), in document order. */
  roots: string[];
}

const IDENTITY_ORIGIN = (): UrdfOrigin => ({ xyz: [0, 0, 0], rpy: [0, 0, 0] });

function nums(s: string | null | undefined, n: number, path: string): number[] {
  if (!s) return new Array<number>(n).fill(0);
  const out = s.trim().split(/\s+/).map(Number);
  if (out.length !== n || out.some((v) => !Number.isFinite(v))) throw new Error(`${path}: expected ${n} numbers, got "${s}"`);
  return out;
}

function parseOrigin(el: Element | null, path: string): UrdfOrigin {
  if (!el) return IDENTITY_ORIGIN();
  return { xyz: nums(el.getAttribute('xyz'), 3, `${path}/origin@xyz`) as [number, number, number], rpy: nums(el.getAttribute('rpy'), 3, `${path}/origin@rpy`) as [number, number, number] };
}

function child(el: Element, tag: string): Element | null {
  for (const c of Array.from(el.children)) if (c.tagName === tag) return c;
  return null;
}

function children(el: Element, tag: string): Element[] {
  return Array.from(el.children).filter((c) => c.tagName === tag);
}

function parseGeometry(el: Element | null, path: string): UrdfGeometry {
  if (!el) throw new Error(`${path}: missing <geometry>`);
  const box = child(el, 'box');
  if (box) return { type: 'box', size: nums(box.getAttribute('size'), 3, `${path}/box@size`) as [number, number, number] };
  const cyl = child(el, 'cylinder');
  if (cyl) return { type: 'cylinder', radius: Number(cyl.getAttribute('radius') ?? 0), length: Number(cyl.getAttribute('length') ?? 0) };
  const sph = child(el, 'sphere');
  if (sph) return { type: 'sphere', radius: Number(sph.getAttribute('radius') ?? 0) };
  const mesh = child(el, 'mesh');
  if (mesh) {
    const filename = mesh.getAttribute('filename') ?? '';
    if (!filename) throw new Error(`${path}/mesh: missing filename`);
    const scale = mesh.getAttribute('scale') ? (nums(mesh.getAttribute('scale'), 3, `${path}/mesh@scale`) as [number, number, number]) : ([1, 1, 1] as [number, number, number]);
    return { type: 'mesh', filename, scale };
  }
  throw new Error(`${path}/geometry: no box / cylinder / sphere / mesh`);
}

function parseMaterialColor(el: Element | null, named: Map<string, [number, number, number, number]>): [number, number, number, number] | null {
  if (!el) return null;
  const color = child(el, 'color');
  if (color?.getAttribute('rgba')) return nums(color.getAttribute('rgba'), 4, 'material/color@rgba') as [number, number, number, number];
  const name = el.getAttribute('name');
  return (name && named.get(name)) || null;
}

function parseVisual(el: Element, path: string, named: Map<string, [number, number, number, number]>): UrdfVisual {
  return {
    name: el.getAttribute('name') ?? '',
    origin: parseOrigin(child(el, 'origin'), path),
    geometry: parseGeometry(child(el, 'geometry'), path),
    color: parseMaterialColor(child(el, 'material'), named),
  };
}

export function parseUrdf(xml: string): UrdfModel {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const err = doc.querySelector('parsererror');
  if (err) throw new Error(`URDF XML parse error: ${err.textContent?.split('\n')[0] ?? 'unknown'}`);
  const robot = doc.documentElement;
  if (!robot || robot.tagName !== 'robot') throw new Error('URDF root element must be <robot>');

  const named = new Map<string, [number, number, number, number]>();
  for (const m of children(robot, 'material')) {
    const name = m.getAttribute('name');
    const color = parseMaterialColor(m, named);
    if (name && color) named.set(name, color);
  }

  const links = new Map<string, UrdfLink>();
  for (const l of children(robot, 'link')) {
    const name = l.getAttribute('name') ?? '';
    if (!name) throw new Error('<link> without a name');
    const path = `link[${name}]`;
    let inertial: UrdfInertial | null = null;
    const in_ = child(l, 'inertial');
    if (in_) {
      const inertia = child(in_, 'inertia');
      const g = (k: string) => Number(inertia?.getAttribute(k) ?? 0);
      inertial = { origin: parseOrigin(child(in_, 'origin'), `${path}/inertial`), mass: Number(child(in_, 'mass')?.getAttribute('value') ?? 0), inertia: [g('ixx'), g('ixy'), g('ixz'), g('iyy'), g('iyz'), g('izz')] };
    }
    links.set(name, {
      name,
      visuals: children(l, 'visual').map((v, i) => parseVisual(v, `${path}/visual[${i}]`, named)),
      collisions: children(l, 'collision').map((v, i) => parseVisual(v, `${path}/collision[${i}]`, named)),
      inertial,
    });
  }

  const joints = new Map<string, UrdfJoint>();
  const hasParent = new Set<string>();
  for (const j of children(robot, 'joint')) {
    const name = j.getAttribute('name') ?? '';
    if (!name) throw new Error('<joint> without a name');
    const parent = child(j, 'parent')?.getAttribute('link') ?? '';
    const childLink = child(j, 'child')?.getAttribute('link') ?? '';
    if (!links.has(parent) || !links.has(childLink)) throw new Error(`joint[${name}]: unknown parent/child link (${parent} → ${childLink})`);
    const limitEl = child(j, 'limit');
    const limit = limitEl
      ? { lower: Number(limitEl.getAttribute('lower') ?? 0), upper: Number(limitEl.getAttribute('upper') ?? 0), effort: Number(limitEl.getAttribute('effort') ?? 0), velocity: Number(limitEl.getAttribute('velocity') ?? 0) }
      : null;
    const axisEl = child(j, 'axis');
    joints.set(name, {
      name,
      type: j.getAttribute('type') ?? 'fixed',
      parent,
      child: childLink,
      origin: parseOrigin(child(j, 'origin'), `joint[${name}]`),
      axis: axisEl ? (nums(axisEl.getAttribute('xyz'), 3, `joint[${name}]/axis@xyz`) as [number, number, number]) : [1, 0, 0],
      limit,
    });
    hasParent.add(childLink);
  }
  const roots = [...links.keys()].filter((n) => !hasParent.has(n));
  return { name: robot.getAttribute('name') ?? '', links, joints, roots };
}
