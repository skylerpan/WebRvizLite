/** Helpers to build the read-only property subtrees shown in the Selection panel. */

import * as THREE from 'three/webgpu';
import { GroupProperty, QuaternionPropertyImpl, StringPropertyImpl, VectorPropertyImpl } from '../property/Property';
import type { Property } from '../property/types';

export function selectionGroup(name: string): GroupProperty {
  return new GroupProperty(name, null, { readOnly: true });
}

export function roString(parent: Property, name: string, value: string, description = ''): StringPropertyImpl {
  return new StringPropertyImpl(name, value, parent, { readOnly: true, description });
}

export function roVector(parent: Property, name: string, v: { x: number; y: number; z: number }, description = ''): VectorPropertyImpl {
  return new VectorPropertyImpl(name, { x: v.x, y: v.y, z: v.z }, parent, { readOnly: true, description });
}

export function roQuaternion(parent: Property, name: string, q: { x: number; y: number; z: number; w: number }, description = ''): QuaternionPropertyImpl {
  return new QuaternionPropertyImpl(name, { x: q.x, y: q.y, z: q.z, w: q.w }, parent, { readOnly: true, description });
}

/** Position + Orientation rows read from flat xyz / xyzw arrays at pose index `i`. */
export function addPoseRows(parent: Property, positions: ArrayLike<number>, orientations: ArrayLike<number>, i: number) {
  roVector(parent, 'Position', { x: positions[i * 3], y: positions[i * 3 + 1], z: positions[i * 3 + 2] });
  roQuaternion(parent, 'Orientation', { x: orientations[i * 4], y: orientations[i * 4 + 1], z: orientations[i * 4 + 2], w: orientations[i * 4 + 3] });
}

export function setVector(prop: Property | undefined, v: THREE.Vector3 | { x: number; y: number; z: number }) {
  (prop as VectorPropertyImpl | undefined)?.setValue({ x: v.x, y: v.y, z: v.z }, 'program');
}

export function setQuaternion(prop: Property | undefined, q: THREE.Quaternion | { x: number; y: number; z: number; w: number }) {
  (prop as QuaternionPropertyImpl | undefined)?.setValue({ x: q.x, y: q.y, z: q.z, w: q.w }, 'program');
}

export function boxAround(out: THREE.Box3, center: { x: number; y: number; z: number }, size: number): boolean {
  tmpCenter.set(center.x, center.y, center.z);
  tmpSize.set(size, size, size);
  out.setFromCenterAndSize(tmpCenter, tmpSize);
  return true;
}

const tmpCenter = new THREE.Vector3();
const tmpSize = new THREE.Vector3();
