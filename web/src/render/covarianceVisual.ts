/**
 * rviz_default_plugins CovarianceVisual: a position ellipsoid plus either
 * three orientation discs (3-D) or a yaw sector (2-D). All numbers come
 * pre-computed from the worker (PoseCovMsg); this only places meshes.
 */

import * as THREE from 'three/webgpu';
import { UNIT_CYLINDER_Z, UNIT_SPHERE } from './primitives';
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

export class CovarianceVisual extends THREE.Group {
  private readonly ellipsoidMaterial = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false });
  private readonly ellipsoid = new THREE.Mesh(UNIT_SPHERE, this.ellipsoidMaterial);
  private readonly discMaterials = [0, 1, 2].map(() => new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide }));
  private readonly discs = this.discMaterials.map((m) => new THREE.Mesh(UNIT_CYLINDER_Z, m));
  private readonly sectorMaterial = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  private readonly sector: THREE.Mesh;
  /** Orientation visuals live here so Frame = Local can rotate them with the pose. */
  private readonly orientationNode = new THREE.Group();

  constructor() {
    super();
    this.userData.noPick = true;
    // rviz draws the 2-D yaw uncertainty as a flat cone: a triangle with its apex at the pose.
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    geometry.setIndex([0, 1, 2]);
    this.sector = new THREE.Mesh(geometry, this.sectorMaterial);
    this.sector.frustumCulled = false;
    this.orientationNode.add(...this.discs, this.sector);
    this.add(this.ellipsoid, this.orientationNode);
    this.visible = false;
  }

  /** Places the visual for one pose (positions/orientations already in the fixed frame). */
  set(msg: PoseCovMsg, style: CovarianceStyle) {
    const px = msg.positions[0], py = msg.positions[1], pz = msg.positions[2];
    const e = msg.ellipsoid;
    const showPos = style.position.enabled && e.length === 7;
    this.ellipsoid.visible = showPos;
    if (showPos) {
      this.ellipsoid.position.set(px, py, pz);
      this.ellipsoid.quaternion.set(e[3], e[4], e[5], e[6]);
      this.ellipsoid.scale.set(Math.max(e[0], 1e-4), Math.max(e[1], 1e-4), Math.max(e[2], 1e-4));
      const c = style.position.color;
      this.ellipsoidMaterial.color.setRGB(c.r / 255, c.g / 255, c.b / 255, THREE.SRGBColorSpace);
      this.ellipsoidMaterial.opacity = style.position.alpha;
    }

    const o = msg.orientation;
    const showOri = style.orientation.enabled && o.length > 0;
    this.orientationNode.visible = showOri;
    if (showOri) {
      this.orientationNode.position.set(px, py, pz);
      if (style.orientation.frame === 'Local') this.orientationNode.quaternion.set(msg.orientations[0], msg.orientations[1], msg.orientations[2], msg.orientations[3]);
      else this.orientationNode.quaternion.identity();
      const unique = style.orientation.colorStyle === 'Unique';
      const c = style.orientation.color;
      const offset = style.orientation.offset;
      if (msg.is2d || o.length === 1) {
        for (const d of this.discs) d.visible = false;
        this.sector.visible = true;
        this.setSector(o[0], offset);
        if (unique) this.sectorMaterial.color.setRGB(c.r / 255, c.g / 255, c.b / 255, THREE.SRGBColorSpace);
        else this.sectorMaterial.color.set(AXIS_RGB[2]);
        this.sectorMaterial.opacity = style.orientation.alpha;
      } else {
        this.sector.visible = false;
        for (let i = 0; i < 3 && i * 4 + 3 < o.length; i++) {
          const axis = o[i * 4] | 0;
          const a = o[i * 4 + 1], b = o[i * 4 + 2], angle = o[i * 4 + 3];
          const disc = this.discs[i];
          disc.visible = a > 0 || b > 0;
          const ax = AXES[axis] ?? AXES[2];
          disc.position.copy(ax).multiplyScalar(offset);
          // Cylinder axis Z → disc axis, then spin so the ellipse's first axis follows the eigenvector angle
          // measured in the disc's block basis (see DISC_BASIS).
          tmpQ.setFromUnitVectors(Z_AXIS, ax);
          const [va, vb] = DISC_BASIS[axis] ?? DISC_BASIS[2];
          tmpTarget.copy(va).multiplyScalar(Math.cos(angle)).addScaledVector(vb, Math.sin(angle));
          tmpB1.set(1, 0, 0).applyQuaternion(tmpQ);
          tmpB2.set(0, 1, 0).applyQuaternion(tmpQ);
          const phi = Math.atan2(tmpTarget.dot(tmpB2), tmpTarget.dot(tmpB1));
          tmpQ2.setFromAxisAngle(Z_AXIS, phi);
          disc.quaternion.copy(tmpQ).multiply(tmpQ2);
          disc.scale.set(Math.max(a, 1e-4), Math.max(b, 1e-4), 0.01);
          const m = this.discMaterials[i];
          if (unique) m.color.setRGB(c.r / 255, c.g / 255, c.b / 255, THREE.SRGBColorSpace);
          else m.color.set(AXIS_RGB[axis] ?? 0xffffff);
          m.opacity = style.orientation.alpha;
        }
      }
    }
    this.visible = showPos || showOri;
  }

  /** Flat cone in the local XY plane: apex at the origin, height `h` (Offset), half-width `h · tan(half)`. */
  private setSector(half: number, h: number) {
    const attr = this.sector.geometry.getAttribute('position') as THREE.BufferAttribute;
    const w = h * Math.tan(half);
    attr.setXYZ(0, 0, 0, 0);
    attr.setXYZ(1, h, w, 0);
    attr.setXYZ(2, h, -w, 0);
    attr.needsUpdate = true;
  }

  hide() {
    this.visible = false;
  }

  dispose() {
    this.ellipsoidMaterial.dispose();
    for (const m of this.discMaterials) m.dispose();
    this.sectorMaterial.dispose();
    this.sector.geometry.dispose();
  }
}

const tmpQ = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();
const tmpTarget = new THREE.Vector3();
const tmpB1 = new THREE.Vector3();
const tmpB2 = new THREE.Vector3();
