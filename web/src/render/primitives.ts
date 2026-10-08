/**
 * Shared render primitives (spec §7.4). Geometry is shared and reused; only
 * materials/transforms are per instance. Appearance does not try to match
 * RViz's Ogre look, only its dimensions.
 */

import * as THREE from 'three/webgpu';

/** Unit cylinder along +Z (height 1, radius 1), reused by axes, arrows, shapes. */
export const UNIT_CYLINDER_Z = (() => {
  const g = new THREE.CylinderGeometry(1, 1, 1, 12, 1);
  g.rotateX(Math.PI / 2); // Y-up cylinder → Z-up
  return g;
})();

/** Unit cone along +Z (base radius 1, height 1), tip at z = 1. */
export const UNIT_CONE_Z = (() => {
  const g = new THREE.ConeGeometry(1, 1, 12, 1);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, 0.5);
  return g;
})();

export const UNIT_SPHERE = new THREE.SphereGeometry(1, 12, 8);
export const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);

const AXIS_COLORS = [0xff0000, 0x00ff00, 0x0000ff] as const;

/** Three RGB cylinders along X/Y/Z, as rviz_rendering::Axes. */
export class Axes extends THREE.Group {
  private readonly cylinders: THREE.Mesh[];
  readonly materials: THREE.MeshBasicMaterial[];

  constructor(length = 1, radius = 0.1) {
    super();
    this.materials = AXIS_COLORS.map((c) => new THREE.MeshBasicMaterial({ color: c }));
    this.cylinders = this.materials.map((m) => new THREE.Mesh(UNIT_CYLINDER_Z, m));
    // X: rotate Z→X, Y: rotate Z→Y, Z: none
    this.cylinders[0].rotation.y = Math.PI / 2;
    this.cylinders[1].rotation.x = -Math.PI / 2;
    for (const c of this.cylinders) this.add(c);
    this.set(length, radius);
  }

  set(length: number, radius: number) {
    const [x, y, z] = this.cylinders;
    x.position.set(length / 2, 0, 0);
    y.position.set(0, length / 2, 0);
    z.position.set(0, 0, length / 2);
    for (const c of this.cylinders) c.scale.set(radius, radius, length);
  }

  setOpacity(alpha: number) {
    for (const m of this.materials) {
      m.opacity = alpha;
      m.transparent = alpha < 1;
    }
  }

  dispose() {
    for (const m of this.materials) m.dispose();
  }
}

/** Shaft + cone head along +X, as rviz_rendering::Arrow (dimensions in meters). */
export class Arrow extends THREE.Group {
  readonly material: THREE.MeshBasicMaterial;
  private readonly shaft: THREE.Mesh;
  private readonly head: THREE.Mesh;

  constructor(color = 0xff1900, shaftLength = 1, shaftRadius = 0.05, headLength = 0.3, headRadius = 0.1) {
    super();
    this.material = new THREE.MeshBasicMaterial({ color });
    this.shaft = new THREE.Mesh(UNIT_CYLINDER_Z, this.material);
    this.head = new THREE.Mesh(UNIT_CONE_Z, this.material);
    this.shaft.rotation.y = Math.PI / 2; // Z → X
    this.head.rotation.y = Math.PI / 2;
    this.add(this.shaft, this.head);
    this.set(shaftLength, shaftRadius, headLength, headRadius);
  }

  set(shaftLength: number, shaftRadius: number, headLength: number, headRadius: number) {
    this.shaft.position.set(shaftLength / 2, 0, 0);
    this.shaft.scale.set(shaftRadius, shaftRadius, shaftLength);
    this.head.position.set(shaftLength, 0, 0);
    this.head.scale.set(headRadius, headRadius, headLength);
  }

  setColor(r: number, g: number, b: number, alpha = 1) {
    this.material.color.setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
    this.material.opacity = alpha;
    this.material.transparent = alpha < 1;
  }

  dispose() {
    this.material.dispose();
  }
}

/** Orients an object so its +X axis points from `from` to `to`; returns the length. */
export function pointXAxisAt(obj: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3): number {
  tmpDir.subVectors(to, from);
  const len = tmpDir.length();
  obj.position.copy(from);
  if (len > 1e-9) {
    tmpDir.divideScalar(len);
    obj.quaternion.setFromUnitVectors(X_AXIS, tmpDir);
  }
  return len;
}

const tmpDir = new THREE.Vector3();
const X_AXIS = new THREE.Vector3(1, 0, 0);

const textureCache = new Map<string, { texture: THREE.CanvasTexture; aspect: number; refs: number }>();

/**
 * View-facing text as a canvas-textured sprite (troika-three-text does not
 * support WebGPURenderer). Textures are cached per string.
 */
export class TextSprite extends THREE.Sprite {
  private key = '';
  private charHeight = 0.1;

  constructor(text: string, charHeight = 0.1, color = '#ffffff') {
    super(new THREE.SpriteMaterial({ depthTest: false, transparent: true }));
    this.renderOrder = 1000;
    this.setText(text, charHeight, color);
  }

  setText(text: string, charHeight = this.charHeight, color = '#ffffff') {
    const key = `${color}|${text}`;
    if (key !== this.key) {
      this.release();
      let entry = textureCache.get(key);
      if (!entry) {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d')!;
        const fontPx = 48;
        ctx.font = `${fontPx}px sans-serif`;
        const w = Math.max(1, Math.ceil(ctx.measureText(text).width) + 8);
        const h = fontPx + 8;
        canvas.width = w;
        canvas.height = h;
        ctx.font = `${fontPx}px sans-serif`;
        ctx.textBaseline = 'middle';
        ctx.fillStyle = color;
        ctx.fillText(text, 4, h / 2);
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        entry = { texture, aspect: w / h, refs: 0 };
        textureCache.set(key, entry);
      }
      entry.refs++;
      this.key = key;
      (this.material as THREE.SpriteMaterial).map = entry.texture;
      (this.material as THREE.SpriteMaterial).needsUpdate = true;
    }
    this.charHeight = charHeight;
    const aspect = textureCache.get(key)?.aspect ?? 1;
    this.scale.set(charHeight * aspect, charHeight, 1);
  }

  setOpacity(alpha: number) {
    (this.material as THREE.SpriteMaterial).opacity = alpha;
  }

  private release() {
    const entry = textureCache.get(this.key);
    if (entry && --entry.refs <= 0) {
      entry.texture.dispose();
      textureCache.delete(this.key);
    }
    this.key = '';
  }

  dispose() {
    this.release();
    (this.material as THREE.SpriteMaterial).dispose();
  }
}

/** Grid line geometry in the XY plane (rviz_rendering::Grid), optionally stacked along Z. */
export function buildGridGeometry(cellCount: number, normalCellCount: number, cellSize: number, plane: 'XY' | 'XZ' | 'YZ'): THREE.BufferGeometry {
  const half = (cellCount * cellSize) / 2;
  const pts: number[] = [];
  const layers = normalCellCount > 0 ? normalCellCount + 1 : 1;
  const zBase = normalCellCount > 0 ? -(normalCellCount * cellSize) / 2 : 0;
  for (let l = 0; l < layers; l++) {
    const z = zBase + l * cellSize;
    for (let i = 0; i <= cellCount; i++) {
      const v = -half + i * cellSize;
      pts.push(v, -half, z, v, half, z);
      pts.push(-half, v, z, half, v, z);
    }
  }
  if (normalCellCount > 0) {
    // vertical lines at every intersection
    for (let i = 0; i <= cellCount; i++) {
      for (let j = 0; j <= cellCount; j++) {
        const x = -half + i * cellSize;
        const y = -half + j * cellSize;
        pts.push(x, y, zBase, x, y, zBase + normalCellCount * cellSize);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  if (plane === 'XZ') g.rotateX(Math.PI / 2);
  else if (plane === 'YZ') g.rotateY(Math.PI / 2);
  return g;
}
