/**
 * Main-thread view of the worker's tf2 buffer: the latest snapshot of every
 * frame's pose in the fixed frame. Displays query it per frame (Grid /
 * Axes reference frames, TF display, frame-locked markers).
 */

import { createSignal, type Accessor } from 'solid-js';
import * as THREE from 'three/webgpu';
import type { TfSnapshotMessage } from '../worker/messages';

const STRIDE = 9;

export class TfSnapshot {
  names: string[] = [];
  parents: Int32Array<ArrayBufferLike> = new Int32Array(0);
  poses: Float64Array<ArrayBufferLike> = new Float64Array(0);
  count = 0;
  fixedFrame = '';
  nowNs = 0;
  private index = new Map<string, number>();
  /** Bumps on every snapshot; UI that lists frames can track it. */
  readonly version: Accessor<number>;
  private readonly setVersion: (v: number) => void;
  /** Bumps only when the frame list changes. */
  readonly framesVersion: Accessor<number>;
  private readonly setFramesVersion: (v: number) => void;

  constructor() {
    [this.version, this.setVersion] = createSignal(0);
    [this.framesVersion, this.setFramesVersion] = createSignal(0);
  }

  apply(msg: TfSnapshotMessage) {
    if (msg.names) {
      this.names = msg.names;
      this.parents = msg.parents ?? new Int32Array(this.names.length);
      this.index = new Map(this.names.map((n, i) => [n, i]));
      this.setFramesVersion(this.framesVersion() + 1);
    }
    this.poses = msg.poses;
    this.count = msg.count;
    this.fixedFrame = msg.fixedFrame;
    this.nowNs = msg.nowNs;
    this.setVersion(this.version() + 1);
  }

  frames(): readonly string[] {
    return this.names;
  }

  has(frame: string): boolean {
    return this.index.has(frame);
  }

  parent(frame: string): string | null {
    const i = this.index.get(frame);
    if (i === undefined) return null;
    const p = this.parents[i];
    return p >= 0 ? this.names[p] : null;
  }

  /** Whether `frame` can currently be expressed in the fixed frame. */
  isValid(frame: string): boolean {
    const i = this.index.get(frame);
    return i !== undefined && i < this.count && this.poses[i * STRIDE] >= 1;
  }

  isStatic(frame: string): boolean {
    const i = this.index.get(frame);
    return i !== undefined && i < this.count && this.poses[i * STRIDE] === 2;
  }

  /** Age of the last update of `frame` in seconds (Infinity if unknown). */
  age(frame: string): number {
    const i = this.index.get(frame);
    if (i === undefined || i >= this.count) return Infinity;
    if (this.poses[i * STRIDE] === 2) return 0; // static frames never age
    return (this.nowNs - this.poses[i * STRIDE + 8]) / 1e9;
  }

  /** Writes the frame's pose in the fixed frame into `out`. False if unavailable. */
  lookup(frame: string, out: THREE.Matrix4, pos?: THREE.Vector3, quat?: THREE.Quaternion): boolean {
    const i = this.index.get(frame);
    if (i === undefined || i >= this.count) return false;
    const o = i * STRIDE;
    const p = this.poses;
    if (p[o] < 1) return false;
    tmpPos.set(p[o + 1], p[o + 2], p[o + 3]);
    tmpQuat.set(p[o + 4], p[o + 5], p[o + 6], p[o + 7]);
    out.compose(tmpPos, tmpQuat, unitScale);
    pos?.copy(tmpPos);
    quat?.copy(tmpQuat);
    return true;
  }

  /** Pose of `frame` relative to its parent (for the TF display's Relative Position). */
  lookupRelative(frame: string, pos: THREE.Vector3, quat: THREE.Quaternion): boolean {
    const parent = this.parent(frame);
    if (!parent || !this.lookup(frame, tmpM1) || !this.lookup(parent, tmpM2)) return false;
    tmpM2.invert().multiply(tmpM1);
    tmpM2.decompose(pos, quat, tmpScale);
    return true;
  }
}

const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpScale = new THREE.Vector3();
const unitScale = new THREE.Vector3(1, 1, 1);
const tmpM1 = new THREE.Matrix4();
const tmpM2 = new THREE.Matrix4();
