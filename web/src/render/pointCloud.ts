/**
 * Point cloud renderer (spec §6.2 / §6.5 styles) built on TSL node materials so
 * the same code runs on the WebGPU and WebGL2 backends:
 *
 * - Points / Squares / Flat Squares: `Sprite` + `PointsNodeMaterial` with
 *   instanced position/colour attributes (the official WebGPU instanced-points
 *   pattern; `THREE.Points` is fixed at 1 px on WebGPU).
 * - Spheres / Boxes / Tiles: instanced unit geometry with `positionNode =
 *   positionLocal * size + instancePosition`.
 *
 * GPU buffers are reused and grow ×2 (spec §9.7); per-frame work allocates nothing.
 */

import * as THREE from 'three/webgpu';
import { instancedBufferAttribute, positionLocal, uniform } from 'three/tsl';
import { UNIT_BOX, UNIT_SPHERE } from './primitives';

export type PointStyle = 'Points' | 'Squares' | 'Flat Squares' | 'Spheres' | 'Boxes' | 'Tiles';

const TILE = (() => {
  const g = new THREE.PlaneGeometry(1, 1);
  return g;
})();

/** One uploaded cloud (one message). Buffers are kept between messages. */
export class CloudBuffer {
  positions: THREE.InstancedBufferAttribute;
  colors: THREE.InstancedBufferAttribute;
  count = 0;
  capacity: number;
  /** ROS/wall time (ms) the cloud arrived, for Decay Time. */
  arrivedMs = 0;

  constructor(capacity = 1024) {
    this.capacity = capacity;
    this.positions = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.colors = new THREE.InstancedBufferAttribute(new Uint8Array(capacity * 3), 3, true);
    this.positions.setUsage(THREE.DynamicDrawUsage);
    this.colors.setUsage(THREE.DynamicDrawUsage);
  }

  /** Returns true if the attributes were reallocated (geometry must be rebound). */
  set(count: number, positions: Float32Array, colors: Uint8Array): boolean {
    let realloc = false;
    if (count > this.capacity) {
      this.capacity = Math.max(count, this.capacity * 2);
      this.positions = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3);
      this.colors = new THREE.InstancedBufferAttribute(new Uint8Array(this.capacity * 3), 3, true);
      this.positions.setUsage(THREE.DynamicDrawUsage);
      this.colors.setUsage(THREE.DynamicDrawUsage);
      realloc = true;
    }
    (this.positions.array as Float32Array).set(positions.subarray(0, count * 3));
    (this.colors.array as Uint8Array).set(colors.subarray(0, count * 3));
    this.positions.addUpdateRange(0, count * 3);
    this.colors.addUpdateRange(0, count * 3);
    this.positions.needsUpdate = true;
    this.colors.needsUpdate = true;
    this.count = count;
    return realloc;
  }
}

/** Renders one CloudBuffer in the current style. */
export class CloudObject extends THREE.Group {
  private sprite: THREE.Sprite | null = null;
  private mesh: THREE.Mesh | null = null;
  private style: PointStyle = 'Flat Squares';
  private readonly sizeUniform = uniform(0.01);
  private readonly alphaUniform = uniform(1);
  private pointsMaterial: THREE.PointsNodeMaterial | null = null;
  private meshMaterial: THREE.MeshBasicNodeMaterial | null = null;
  private boundBuffer: CloudBuffer | null = null;

  constructor(readonly buffer: CloudBuffer) {
    super();
    this.frustumCulled = false;
  }

  setStyle(style: PointStyle, size: number, sizePixels: number, alpha: number) {
    const changed = style !== this.style || !this.boundBuffer;
    this.style = style;
    this.sizeUniform.value = style === 'Points' ? sizePixels : size;
    this.alphaUniform.value = alpha;
    if (changed) this.rebuild();
    if (this.pointsMaterial) {
      this.pointsMaterial.sizeAttenuation = style !== 'Points';
      this.pointsMaterial.transparent = alpha < 1;
      this.pointsMaterial.needsUpdate = true;
    }
    if (this.meshMaterial) {
      this.meshMaterial.transparent = alpha < 1;
    }
  }

  /** Re-binds attributes after the buffer reallocated. */
  rebind() {
    this.rebuild();
  }

  private rebuild() {
    this.sprite?.removeFromParent();
    this.mesh?.removeFromParent();
    this.sprite = null;
    this.mesh = null;
    const buf = this.buffer;
    this.boundBuffer = buf;
    const posNode = instancedBufferAttribute(buf.positions, 'vec3' as const);
    const colNode = instancedBufferAttribute(buf.colors, 'vec3' as const);
    if (this.style === 'Points' || this.style === 'Squares' || this.style === 'Flat Squares') {
      if (!this.pointsMaterial) this.pointsMaterial = new THREE.PointsNodeMaterial({ depthWrite: true });
      const m = this.pointsMaterial;
      m.positionNode = posNode;
      m.colorNode = colNode;
      m.sizeNode = this.sizeUniform;
      m.opacityNode = this.alphaUniform;
      m.sizeAttenuation = this.style !== 'Points';
      m.needsUpdate = true;
      const sprite = new THREE.Sprite(m);
      sprite.count = buf.count;
      sprite.frustumCulled = false;
      this.sprite = sprite;
      this.add(sprite);
    } else {
      if (!this.meshMaterial) this.meshMaterial = new THREE.MeshBasicNodeMaterial();
      const m = this.meshMaterial;
      m.positionNode = positionLocal.mul(this.sizeUniform).add(posNode);
      m.colorNode = colNode;
      m.opacityNode = this.alphaUniform;
      m.needsUpdate = true;
      const base = this.style === 'Spheres' ? UNIT_SPHERE : this.style === 'Boxes' ? UNIT_BOX : TILE;
      const geometry = new THREE.InstancedBufferGeometry();
      geometry.index = base.index;
      for (const name of Object.keys(base.attributes)) geometry.setAttribute(name, base.getAttribute(name));
      geometry.instanceCount = buf.count;
      const mesh = new THREE.Mesh(geometry, m);
      mesh.frustumCulled = false;
      this.mesh = mesh;
      this.add(mesh);
    }
  }

  /** Called after every buffer update. */
  refresh(reallocated: boolean) {
    if (reallocated || this.boundBuffer !== this.buffer) {
      this.rebuild();
      return;
    }
    if (this.sprite) this.sprite.count = this.buffer.count;
    if (this.mesh) (this.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = this.buffer.count;
  }

  dispose() {
    this.mesh?.geometry.dispose();
    this.pointsMaterial?.dispose();
    this.meshMaterial?.dispose();
  }
}

