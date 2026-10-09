/**
 * Instanced pose primitives shared by Path (Pose Style), PoseArray, Odometry
 * and the Marker list types: one draw call per shape, capacity grows ×2.
 */

import * as THREE from 'three/webgpu';
import { depth, float, floor, mrt, varying, vec4, vertexIndex } from 'three/tsl';
import { UNIT_CONE_Z, UNIT_CYLINDER_Z } from './primitives';
import { PICK_OUTPUT, pickIdUniform } from './picking';

/** Pick output for FlatArrows: 6 vertices per arrow, so the arrow index is vertexIndex / 6. */
const FLAT_ARROW_PICK_MRT = mrt({ [PICK_OUTPUT]: vec4(pickIdUniform, varying(floor(float(vertexIndex).div(6))), depth, 1) });

const tmpM = new THREE.Matrix4();
const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpScale = new THREE.Vector3();
const tmpRot = new THREE.Matrix4();
const Z_TO_X = new THREE.Matrix4().makeRotationY(Math.PI / 2);
const Z_TO_Y = new THREE.Matrix4().makeRotationX(-Math.PI / 2);

/** Grows an InstancedMesh's capacity (×2) without losing the material. */
function ensureCapacity(mesh: THREE.InstancedMesh, needed: number, geometry: THREE.BufferGeometry, material: THREE.Material): THREE.InstancedMesh {
  if (needed <= mesh.instanceMatrix.count) return mesh;
  const cap = Math.max(needed, mesh.instanceMatrix.count * 2, 16);
  const next = new THREE.InstancedMesh(geometry, material, cap);
  next.frustumCulled = false;
  mesh.parent?.add(next);
  mesh.removeFromParent();
  mesh.dispose();
  return next;
}

/** N axis triads (3 instanced cylinders). */
export class InstancedAxes extends THREE.Group {
  private meshes: THREE.InstancedMesh[];
  private readonly materials: THREE.MeshBasicMaterial[];

  constructor(initial = 16) {
    super();
    this.materials = [0xff0000, 0x00ff00, 0x0000ff].map((c) => new THREE.MeshBasicMaterial({ color: c }));
    this.meshes = this.materials.map((m) => {
      const im = new THREE.InstancedMesh(UNIT_CYLINDER_Z, m, initial);
      im.frustumCulled = false;
      im.count = 0;
      this.add(im);
      return im;
    });
  }

  /** `positions` xyz × n, `orientations` xyzw × n. */
  set(n: number, positions: Float32Array, orientations: Float32Array, length: number, radius: number) {
    this.meshes = this.meshes.map((m, i) => ensureCapacity(m, n, UNIT_CYLINDER_Z, this.materials[i]));
    for (let i = 0; i < n; i++) {
      tmpPos.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      tmpQuat.set(orientations[i * 4], orientations[i * 4 + 1], orientations[i * 4 + 2], orientations[i * 4 + 3]);
      tmpRot.compose(tmpPos, tmpQuat, tmpScale.set(1, 1, 1));
      // X axis: rotate Z→X, offset half length along X; same for Y, Z.
      tmpM.copy(tmpRot).multiply(Z_TO_X).multiply(tmpScale2(length / 2, radius, length));
      this.meshes[0].setMatrixAt(i, tmpM);
      tmpM.copy(tmpRot).multiply(Z_TO_Y).multiply(tmpScale2(length / 2, radius, length));
      this.meshes[1].setMatrixAt(i, tmpM);
      tmpM.copy(tmpRot).multiply(tmpScale2(length / 2, radius, length));
      this.meshes[2].setMatrixAt(i, tmpM);
    }
    for (const m of this.meshes) {
      m.count = n;
      m.instanceMatrix.needsUpdate = true;
    }
  }

  setOpacity(alpha: number) {
    for (const m of this.materials) {
      m.opacity = alpha;
      m.transparent = alpha < 1;
    }
  }

  dispose() {
    for (const m of this.meshes) m.dispose();
    for (const m of this.materials) m.dispose();
  }
}

/** Translation along local Z by `offset`, then scale (radius, radius, length): a cylinder from 0 to `length`. */
function tmpScale2(offset: number, radius: number, length: number): THREE.Matrix4 {
  return tmpLocal.makeScale(radius, radius, length).setPosition(0, 0, offset);
}
const tmpLocal = new THREE.Matrix4();

/** N arrows along each pose's +X (shaft cylinder + cone head), one colour. */
export class InstancedArrows extends THREE.Group {
  private shafts: THREE.InstancedMesh;
  private heads: THREE.InstancedMesh;
  readonly material: THREE.MeshBasicMaterial;

  constructor(color = 0xff1900, initial = 16) {
    super();
    this.material = new THREE.MeshBasicMaterial({ color });
    this.shafts = new THREE.InstancedMesh(UNIT_CYLINDER_Z, this.material, initial);
    this.heads = new THREE.InstancedMesh(UNIT_CONE_Z, this.material, initial);
    for (const m of [this.shafts, this.heads]) {
      m.frustumCulled = false;
      m.count = 0;
      this.add(m);
    }
  }

  set(n: number, positions: Float32Array, orientations: Float32Array, shaftLength: number, shaftRadius: number, headLength: number, headRadius: number) {
    this.shafts = ensureCapacity(this.shafts, n, UNIT_CYLINDER_Z, this.material);
    this.heads = ensureCapacity(this.heads, n, UNIT_CONE_Z, this.material);
    for (let i = 0; i < n; i++) {
      tmpPos.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      tmpQuat.set(orientations[i * 4], orientations[i * 4 + 1], orientations[i * 4 + 2], orientations[i * 4 + 3]);
      tmpRot.compose(tmpPos, tmpQuat, tmpScale.set(1, 1, 1)).multiply(Z_TO_X);
      tmpM.copy(tmpRot).multiply(tmpScale2(shaftLength / 2, shaftRadius, shaftLength));
      this.shafts.setMatrixAt(i, tmpM);
      tmpM.copy(tmpRot).multiply(tmpLocal.makeScale(headRadius, headRadius, headLength).setPosition(0, 0, shaftLength));
      this.heads.setMatrixAt(i, tmpM);
    }
    for (const m of [this.shafts, this.heads]) {
      m.count = n;
      m.instanceMatrix.needsUpdate = true;
    }
  }

  setColor(r: number, g: number, b: number, alpha = 1) {
    this.material.color.setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
    this.material.opacity = alpha;
    this.material.transparent = alpha < 1;
  }

  dispose() {
    this.shafts.dispose();
    this.heads.dispose();
    this.material.dispose();
  }
}

/**
 * Flat 2D arrows (rviz PoseArray "Arrow (Flat)"): line segments in the pose's
 * XY plane. One LineSegments object, buffer grows ×2.
 */
export class FlatArrows extends THREE.LineSegments {
  private capacity = 0;
  readonly lineMaterial: THREE.LineBasicMaterial;

  constructor(color = 0xff1900) {
    const material = new THREE.LineBasicMaterial({ color });
    super(new THREE.BufferGeometry(), material);
    this.lineMaterial = material;
    (material as unknown as { mrtNode: unknown }).mrtNode = FLAT_ARROW_PICK_MRT;
    this.frustumCulled = false;
  }

  /** Each arrow: shaft (2 verts) + two head strokes (4 verts) = 6 vertices. */
  set(n: number, positions: Float32Array, orientations: Float32Array, length: number, headLength: number, headWidth: number) {
    if (n === 0) {
      this.geometry.setDrawRange(0, 0);
      return;
    }
    if (n > this.capacity) {
      this.capacity = Math.max(n, this.capacity * 2, 16);
      this.geometry.dispose();
      this.geometry = new THREE.BufferGeometry();
      this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.capacity * 6 * 3), 3));
    }
    const attr = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const shaft = Math.max(0, length - headLength);
    let k = 0;
    const put = (v: THREE.Vector3) => {
      arr[k++] = v.x;
      arr[k++] = v.y;
      arr[k++] = v.z;
    };
    for (let i = 0; i < n; i++) {
      tmpPos.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      tmpQuat.set(orientations[i * 4], orientations[i * 4 + 1], orientations[i * 4 + 2], orientations[i * 4 + 3]);
      const tip = v1.set(length, 0, 0).applyQuaternion(tmpQuat).add(tmpPos);
      const l = v2.set(shaft, headWidth / 2, 0).applyQuaternion(tmpQuat).add(tmpPos);
      const r = v3.set(shaft, -headWidth / 2, 0).applyQuaternion(tmpQuat).add(tmpPos);
      put(tmpPos); put(tip);
      put(tip); put(l);
      put(tip); put(r);
    }
    this.geometry.setDrawRange(0, n * 6);
    attr.addUpdateRange(0, n * 18);
    attr.needsUpdate = true;
  }

  setColor(r: number, g: number, b: number, alpha = 1) {
    this.lineMaterial.color.setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
    this.lineMaterial.opacity = alpha;
    this.lineMaterial.transparent = alpha < 1;
  }

  dispose() {
    this.geometry.dispose();
    this.lineMaterial.dispose();
  }
}

const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const v3 = new THREE.Vector3();
