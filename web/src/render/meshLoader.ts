/**
 * Mesh resources (spec §7.4): STL / DAE / OBJ loaded by extension. `http(s)://`
 * is fetched directly; `package://` and `file://` go through the server's
 * `/api/mesh`, which resolves ROS packages. Loads are cached per URI and
 * instantiated per use.
 */

import * as THREE from 'three/webgpu';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { ColladaLoader } from 'three/addons/loaders/ColladaLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';

const meshCache = new Map<string, Promise<THREE.Object3D>>();

export function meshUrl(uri: string): string {
  return /^https?:\/\//.test(uri) ? uri : `/api/mesh?uri=${encodeURIComponent(uri)}`;
}

/** Loads (once) the prototype object for a mesh URI; callers clone it. */
export function loadMesh(uri: string): Promise<THREE.Object3D> {
  let p = meshCache.get(uri);
  if (p) return p;
  const url = meshUrl(uri);
  const ext = uri.split('?')[0].split('.').pop()?.toLowerCase();
  p = (async () => {
    if (ext === 'stl') {
      const geometry = await new STLLoader().loadAsync(url);
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
      mesh.userData.hasEmbeddedMaterial = false;
      return mesh;
    }
    if (ext === 'dae') {
      const collada = await new ColladaLoader().loadAsync(url);
      if (!collada) throw new Error('empty collada');
      collada.scene.userData.hasEmbeddedMaterial = true;
      return collada.scene;
    }
    if (ext === 'obj') {
      const obj = await new OBJLoader().loadAsync(url);
      obj.userData.hasEmbeddedMaterial = false;
      return obj;
    }
    throw new Error(`unsupported mesh format .${ext}`);
  })();
  p.catch(() => meshCache.delete(uri));
  meshCache.set(uri, p);
  return p;
}

export interface InstantiateOptions {
  /** 0..1 RGB; when set (or the mesh has no embedded material) every mesh gets a flat material of this colour. */
  color?: THREE.Color;
  alpha?: number;
  scale?: [number, number, number];
  useEmbeddedMaterials?: boolean;
  wireframe?: boolean;
}

/** Clones a loaded prototype with its own materials, so alpha/colour edits do not leak between users. */
export function instantiateMesh(proto: THREE.Object3D, opts: InstantiateOptions = {}): THREE.Object3D {
  const inst = proto.clone(true);
  const embedded = opts.useEmbeddedMaterials !== false && proto.userData.hasEmbeddedMaterial === true && !opts.color;
  const alpha = opts.alpha ?? 1;
  inst.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (embedded) {
      const src = Array.isArray(m.material) ? m.material[0] : m.material;
      const mat = src.clone();
      mat.transparent = alpha < 1;
      mat.opacity = alpha;
      m.material = mat;
    } else {
      m.material = new THREE.MeshBasicMaterial({ color: opts.color ?? new THREE.Color(0.8, 0.8, 0.8), transparent: alpha < 1, opacity: alpha, wireframe: opts.wireframe ?? false });
    }
  });
  if (opts.scale) inst.scale.set(opts.scale[0], opts.scale[1], opts.scale[2]);
  return inst;
}

/** Sets opacity on every material under `obj`. */
export function setObjectAlpha(obj: THREE.Object3D, alpha: number) {
  obj.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!m) return;
    for (const mat of Array.isArray(m) ? m : [m]) {
      mat.transparent = alpha < 1;
      mat.opacity = alpha;
    }
  });
}

/** Disposes geometries/materials under `obj` except shared unit geometries. */
export function disposeInstantiated(obj: THREE.Object3D, sharedGeometries: readonly THREE.BufferGeometry[] = []) {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry && !sharedGeometries.includes(m.geometry) && !m.userData.sharedGeometry) m.geometry.dispose?.();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose?.();
  });
}
