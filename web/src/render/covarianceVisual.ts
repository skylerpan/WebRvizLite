/**
 * rviz_default_plugins CovarianceVisual, batched: every kept pose contributes
 * a position ellipsoid plus either three orientation discs (3-D) or a yaw
 * sector (2-D). All numbers come pre-computed from the worker (PoseCovMsg);
 * this only fills three instanced pools (one draw call each), so an Odometry
 * display with Keep = 100 costs three draw calls instead of ~500.
 */

import * as THREE from 'three/webgpu';
import { UNIT_CYLINDER_Z, UNIT_SPHERE } from './primitives';
import { InstancedShapes } from './instancedShapes';
import type { PoseCovMsg } from '../worker/decoders';

export interface CovarianceStyle {
  position: { enabled: boolean; color: { r: number; g: number; b: number }; alpha: number };
  orientation: { enabled: boolean; frame: 'Local' | 'Fixed'; colorStyle: 'Unique' | 'RGB'; color: { r: number; g: number; b: number }; alpha: number; offset: number };
}

const AXIS_RGB = [0xff0000, 0x00ff00, 0x0000ff];
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
/**
 * World directions of each disc's 2×2 block basis (rviz covariance_visual.cpp):
 * x disc (pitch, yaw) → (+Z, −Y); y disc (roll, yaw) → (−Z, +X); z disc (roll, pitch) → (+X, −Y).
 */
const DISC_BASIS: [THREE.Vector3, THREE.Vector3][] = [
  [new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, -1, 0)],
  [new THREE.Vector3(0, 0, -1), new THREE.Vector3(1, 0, 0)],
  [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, -1, 0)],
];

/**
 * rviz draws the 2-D yaw uncertainty as a flat cone with its apex at the pose:
 * a unit triangle in the local XY plane, scaled per instance to
 * (Offset, Offset · tan(half-angle), 1).
 */
const UNIT_SECTOR = (() => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 1, 0, 1, -1, 0]), 3));
  g.setIndex([0, 1, 2]);
  return g;
})();

/** Property colours are sRGB bytes; the instanced pools take linear bytes (like marker colours). */
export function linearBytes(c: { r: number; g: number; b: number }, out: Uint8Array): Uint8Array {
  tmpColor.setRGB(c.r / 255, c.g / 255, c.b / 255, THREE.SRGBColorSpace);
  out[0] = Math.round(tmpColor.r * 255);
  out[1] = Math.round(tmpColor.g * 255);
  out[2] = Math.round(tmpColor.b * 255);
  return out;
}

export class CovarianceVisuals extends THREE.Group {
  private readonly ellipsoids = new InstancedShapes(UNIT_SPHERE, 16, { depthWrite: false });
  private readonly discs = new InstancedShapes(UNIT_CYLINDER_Z, 16, { depthWrite: false, side: THREE.DoubleSide });
  private readonly sectors = new InstancedShapes(UNIT_SECTOR, 16, { depthWrite: false, side: THREE.DoubleSide });

  constructor() {
    super();
    this.userData.noPick = true;
    this.add(this.ellipsoids, this.discs, this.sectors);
    this.end();
  }

  /** Starts a rebuild; `push` once per pose, then `end`. */
  begin() {
    this.ellipsoids.begin();
    this.discs.begin();
    this.sectors.begin();
  }

  /** Adds the visuals for one pose (positions/orientations already in the fixed frame). */
  push(msg: PoseCovMsg, style: CovarianceStyle) {
    const px = msg.positions[0], py = msg.positions[1], pz = msg.positions[2];
    const e = msg.ellipsoid;
    if (style.position.enabled && e.length === 7) {
      const c = linearBytes(style.position.color, tmpBytes);
      this.ellipsoids.push(px, py, pz, e[3], e[4], e[5], e[6], Math.max(e[0], 1e-4), Math.max(e[1], 1e-4), Math.max(e[2], 1e-4), c[0], c[1], c[2], style.position.alpha * 255);
    }

    const o = msg.orientation;
    if (!(style.orientation.enabled && o.length > 0)) return;
    // Orientation visuals are placed relative to the pose: Frame = Local rotates them with it.
    if (style.orientation.frame === 'Local') tmpParentQ.set(msg.orientations[0], msg.orientations[1], msg.orientations[2], msg.orientations[3]);
    else tmpParentQ.identity();
    const unique = style.orientation.colorStyle === 'Unique';
    const offset = style.orientation.offset;
    const alpha = style.orientation.alpha * 255;
    if (unique) linearBytes(style.orientation.color, tmpBytes);
    if (msg.is2d || o.length === 1) {
      if (!unique) hexBytes(AXIS_RGB[2], tmpBytes);
      const w = offset * Math.tan(o[0]);
      this.sectors.push(px, py, pz, tmpParentQ.x, tmpParentQ.y, tmpParentQ.z, tmpParentQ.w, offset, w, 1, tmpBytes[0], tmpBytes[1], tmpBytes[2], alpha);
      return;
    }
    for (let i = 0; i < 3 && i * 4 + 3 < o.length; i++) {
      const axis = o[i * 4] | 0;
      const a = o[i * 4 + 1], b = o[i * 4 + 2], angle = o[i * 4 + 3];
      if (!(a > 0 || b > 0)) continue;
      const ax = AXES[axis] ?? AXES[2];
      // Cylinder axis Z → disc axis, then spin so the ellipse's first axis follows the eigenvector angle
      // measured in the disc's block basis (see DISC_BASIS).
      tmpQ.setFromUnitVectors(Z_AXIS, ax);
      const [va, vb] = DISC_BASIS[axis] ?? DISC_BASIS[2];
      tmpTarget.copy(va).multiplyScalar(Math.cos(angle)).addScaledVector(vb, Math.sin(angle));
      tmpB1.set(1, 0, 0).applyQuaternion(tmpQ);
      tmpB2.set(0, 1, 0).applyQuaternion(tmpQ);
      const phi = Math.atan2(tmpTarget.dot(tmpB2), tmpTarget.dot(tmpB1));
      tmpQ2.setFromAxisAngle(Z_AXIS, phi);
      tmpQ.multiply(tmpQ2).premultiply(tmpParentQ);
      tmpPos.copy(ax).multiplyScalar(offset).applyQuaternion(tmpParentQ);
      if (!unique) hexBytes(AXIS_RGB[axis] ?? 0xffffff, tmpBytes);
      this.discs.push(px + tmpPos.x, py + tmpPos.y, pz + tmpPos.z, tmpQ.x, tmpQ.y, tmpQ.z, tmpQ.w, Math.max(a, 1e-4), Math.max(b, 1e-4), 0.01, tmpBytes[0], tmpBytes[1], tmpBytes[2], alpha);
    }
  }

  /** Finishes a rebuild and uploads the pools. */
  end() {
    this.ellipsoids.end();
    this.discs.end();
    this.sectors.end();
    this.visible = this.ellipsoids.instanceCount() + this.discs.instanceCount() + this.sectors.instanceCount() > 0;
  }

  /** Instance counts per pool (tests / debugging). */
  counts() {
    return { ellipsoids: this.ellipsoids.instanceCount(), discs: this.discs.instanceCount(), sectors: this.sectors.instanceCount() };
  }

  hide() {
    this.begin();
    this.end();
  }

  dispose() {
    this.ellipsoids.dispose();
    this.discs.dispose();
    this.sectors.dispose();
  }
}

function hexBytes(hex: number, out: Uint8Array): Uint8Array {
  tmpColor.setHex(hex);
  out[0] = Math.round(tmpColor.r * 255);
  out[1] = Math.round(tmpColor.g * 255);
  out[2] = Math.round(tmpColor.b * 255);
  return out;
}

const tmpColor = new THREE.Color();
const tmpBytes = new Uint8Array(3);
const tmpParentQ = new THREE.Quaternion();
const tmpQ = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();
const tmpPos = new THREE.Vector3();
const tmpTarget = new THREE.Vector3();
const tmpB1 = new THREE.Vector3();
const tmpB2 = new THREE.Vector3();
