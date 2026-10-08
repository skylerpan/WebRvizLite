/**
 * Colour-ID picking (spec §7.3). Filled in by M10; this file currently only
 * defines the hit type shared with the tools.
 */

import type * as THREE from 'three/webgpu';

export interface PickHit {
  /** Registered pick id (0 = unregistered surface, e.g. the map or grid). */
  pickId: number;
  /** Instance / point index within the picked object. */
  instance: number;
  /** Normalised depth in [0, 1]. */
  depth: number;
  worldPos: THREE.Vector3;
  object: THREE.Object3D | null;
}
