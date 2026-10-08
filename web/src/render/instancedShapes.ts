/**
 * Instanced unit shapes with per-instance position, quaternion, scale and
 * RGBA colour as plain instanced attributes (no 4×4 matrices), rendered with a
 * TSL node material so it works on WebGPU and WebGL2. Used by the marker
 * display: all CUBE / SPHERE / CYLINDER markers of a display share one pool
 * each, so 5,000 cube markers are a single draw call.
 */

import * as THREE from 'three/webgpu';
import { cross, instancedBufferAttribute, positionLocal } from 'three/tsl';

export class InstancedShapes extends THREE.Group {
  private mesh: THREE.Mesh | null = null;
  private readonly material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: true });
  private positions!: THREE.InstancedBufferAttribute;
  private quaternions!: THREE.InstancedBufferAttribute;
  private scales!: THREE.InstancedBufferAttribute;
  private colors!: THREE.InstancedBufferAttribute;
  private capacity = 0;
  private cursor = 0;
  /** Caller-defined owner per instance (e.g. the marker entry), for selection. */
  private tags: unknown[] = [];

  constructor(private readonly base: THREE.BufferGeometry, initial = 64) {
    super();
    this.allocate(initial);
  }

  private allocate(capacity: number) {
    this.capacity = capacity;
    this.positions = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.quaternions = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.scales = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.colors = new THREE.InstancedBufferAttribute(new Uint8Array(capacity * 4), 4, true);
    for (const a of [this.positions, this.quaternions, this.scales, this.colors]) a.setUsage(THREE.DynamicDrawUsage);

    const pos = instancedBufferAttribute(this.positions, 'vec3' as const);
    const quat = instancedBufferAttribute(this.quaternions, 'vec4' as const);
    const scl = instancedBufferAttribute(this.scales, 'vec3' as const);
    const col = instancedBufferAttribute(this.colors, 'vec4' as const);
    // v' = v + 2 * cross(q.xyz, cross(q.xyz, v) + q.w * v)
    const v = positionLocal.mul(scl);
    const qxyz = quat.xyz;
    const t = cross(qxyz, v).add(v.mul(quat.w));
    const rotated = v.add(cross(qxyz, t).mul(2));
    this.material.positionNode = rotated.add(pos);
    this.material.colorNode = col.xyz;
    this.material.opacityNode = col.w;
    this.material.needsUpdate = true;

    this.mesh?.removeFromParent();
    this.mesh?.geometry.dispose();
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = this.base.index;
    for (const name of Object.keys(this.base.attributes)) geometry.setAttribute(name, this.base.getAttribute(name));
    geometry.instanceCount = 0;
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.add(this.mesh);
  }

  /** Starts a rebuild: subsequent `push` calls fill from index 0. */
  begin() {
    this.cursor = 0;
  }

  /** Reserves room for `n` more instances (grows ×2). */
  reserve(n: number) {
    if (this.cursor + n > this.capacity) {
      const old = { p: this.positions.array as Float32Array, q: this.quaternions.array as Float32Array, s: this.scales.array as Float32Array, c: this.colors.array as Uint8Array, n: this.cursor };
      this.allocate(Math.max(this.cursor + n, this.capacity * 2));
      (this.positions.array as Float32Array).set(old.p.subarray(0, old.n * 3));
      (this.quaternions.array as Float32Array).set(old.q.subarray(0, old.n * 4));
      (this.scales.array as Float32Array).set(old.s.subarray(0, old.n * 3));
      (this.colors.array as Uint8Array).set(old.c.subarray(0, old.n * 4));
    }
  }

  push(x: number, y: number, z: number, qx: number, qy: number, qz: number, qw: number, sx: number, sy: number, sz: number, r: number, g: number, b: number, a: number, tag?: unknown) {
    this.reserve(1);
    const i = this.cursor++;
    this.tags[i] = tag;
    const p = this.positions.array as Float32Array;
    p[i * 3] = x; p[i * 3 + 1] = y; p[i * 3 + 2] = z;
    const q = this.quaternions.array as Float32Array;
    q[i * 4] = qx; q[i * 4 + 1] = qy; q[i * 4 + 2] = qz; q[i * 4 + 3] = qw;
    const s = this.scales.array as Float32Array;
    s[i * 3] = sx; s[i * 3 + 1] = sy; s[i * 3 + 2] = sz;
    const c = this.colors.array as Uint8Array;
    c[i * 4] = r; c[i * 4 + 1] = g; c[i * 4 + 2] = b; c[i * 4 + 3] = a;
  }

  /** Finishes a rebuild and uploads. */
  end() {
    const n = this.cursor;
    for (const attr of [this.positions, this.quaternions, this.scales, this.colors]) {
      attr.addUpdateRange(0, n * attr.itemSize);
      attr.needsUpdate = true;
    }
    (this.mesh!.geometry as THREE.InstancedBufferGeometry).instanceCount = n;
    this.visible = n > 0;
  }

  instanceCount() {
    return this.cursor;
  }

  tagAt(i: number): unknown {
    return i < this.cursor ? this.tags[i] : undefined;
  }

  /** Instance pose/scale as pushed (for selection highlight boxes). */
  instanceAt(i: number, pos: THREE.Vector3, scale: THREE.Vector3): boolean {
    if (i >= this.cursor) return false;
    const p = this.positions.array as Float32Array;
    const s = this.scales.array as Float32Array;
    pos.set(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
    scale.set(s[i * 3], s[i * 3 + 1], s[i * 3 + 2]);
    return true;
  }

  dispose() {
    this.mesh?.geometry.dispose();
    this.material.dispose();
  }
}
