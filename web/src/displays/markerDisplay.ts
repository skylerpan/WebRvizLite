/**
 * rviz_default_plugins/Marker and MarkerArray (marker_display.cpp, markers/*):
 * 12 marker types, ADD/MODIFY/DELETE/DELETEALL, lifetime, frame_locked and
 * the Namespaces subtree. Simple shapes (CUBE / SPHERE / CYLINDER / ARROW and
 * the *_LIST types) are pooled into one instanced draw call per shape, so a
 * 5,000-cube MarkerArray is four draw calls and no per-marker scene objects.
 * Markers are updated in place by (ns, id); nothing is allocated per frame.
 */

import * as THREE from 'three/webgpu';
import { MessageFilterDisplayBase } from './Display';
import { BoolPropertyImpl, GroupProperty } from '../property/Property';
import type { ChangeSource, YamlValue } from '../property/types';
import type { DisplayClassInfo } from './types';
import type { DataMessage } from '../worker/messages';
import { MARKER_STRIDE, MarkerField, type MarkerArrayMsg } from '../worker/decoders';
import { InstancedShapes } from '../render/instancedShapes';
import { loadMesh } from '../render/meshLoader';
import { TextSprite, UNIT_BOX, UNIT_CONE_Z, UNIT_CYLINDER_Z, UNIT_SPHERE } from '../render/primitives';
import { boxAround, roQuaternion, roString, roVector, selectionGroup, setQuaternion, setVector } from './selectionInfo';
import type { PickHit } from '../render/picking';
import type { Property } from '../property/types';
import { CloudBuffer, CloudObject } from '../render/pointCloud';
import type { TfSnapshot } from '../render/tf';

export const MARKER_INFO: DisplayClassInfo = {
  classId: 'rviz_default_plugins/Marker',
  name: 'Marker',
  description: 'Displays visualization markers sent over a visualization_msgs::Marker topic.',
  messageTypes: ['visualization_msgs/msg/Marker'],
};
export const MARKER_ARRAY_INFO: DisplayClassInfo = {
  classId: 'rviz_default_plugins/MarkerArray',
  name: 'MarkerArray',
  description: 'Displays visualization markers sent over a visualization_msgs::MarkerArray topic.',
  messageTypes: ['visualization_msgs/msg/MarkerArray'],
};

const ARROW = 0, CUBE = 1, SPHERE = 2, CYLINDER = 3, LINE_STRIP = 4, LINE_LIST = 5, CUBE_LIST = 6, SPHERE_LIST = 7, POINTS = 8, TEXT_VIEW_FACING = 9, MESH_RESOURCE = 10, TRIANGLE_LIST = 11;
const DELETE = 2, DELETEALL = 3;
const MARKER_TYPE_NAMES: Record<number, string> = {  };
const POOLED = new Set([ARROW, CUBE, SPHERE, CYLINDER, CUBE_LIST, SPHERE_LIST]);

/** One live marker. Numeric fields are read straight from the message arrays. */
class Entry {
  msg!: MarkerArrayMsg;
  o = 0; // offset into msg.numeric
  ns = '';
  type = 0;
  object: THREE.Object3D | null = null;
  expiresAtMs = Infinity;
  readonly pos = new THREE.Vector3();
  readonly quat = new THREE.Quaternion();
  frameLocked = false;
  frameId = '';
}


/** One material per primitive kind for every marker (colour and alpha live in vertex attributes),
 * so updating a marker never creates a material or compiles a shader. */
const LINE_MATERIAL = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true });
const TRIANGLE_MATERIAL = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, side: THREE.DoubleSide });

/** Writes marker points (+ per-vertex RGBA or the marker colour) into `geometry`, growing buffers ×2. */
function fillGeometry(geometry: THREE.BufferGeometry, points: Float32Array, colors: Uint8Array, r: number, g: number, b: number, a: number) {
  const n = points.length / 3;
  let pos = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  let col = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
  if (!pos || pos.count < n) {
    const cap = Math.max(n, (pos?.count ?? 0) * 2, 8);
    pos = new THREE.BufferAttribute(new Float32Array(cap * 3), 3);
    col = new THREE.BufferAttribute(new Uint8Array(cap * 4), 4, true);
    pos.setUsage(THREE.DynamicDrawUsage);
    col.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', pos);
    geometry.setAttribute('color', col);
  }
  (pos.array as Float32Array).set(points);
  const c = col!.array as Uint8Array;
  if (colors.length === n * 4) c.set(colors);
  else {
    for (let i = 0; i < n; i++) {
      c[i * 4] = r * 255; c[i * 4 + 1] = g * 255; c[i * 4 + 2] = b * 255; c[i * 4 + 3] = a * 255;
    }
  }
  pos.addUpdateRange(0, n * 3);
  col!.addUpdateRange(0, n * 4);
  pos.needsUpdate = true;
  col!.needsUpdate = true;
  geometry.setDrawRange(0, n);
}

interface MarkerHost {
  setStatus(level: 'ok' | 'warn' | 'error', name: string, text: string): void;
  deleteStatus(name: string): void;
  tf: TfSnapshot;
  namespaceVisible(ns: string): boolean;
  onNamespace(ns: string): void;
  makePickable(obj: THREE.Object3D): void;
  releasePickable(obj: THREE.Object3D): void;
}

/** Shared rendering/state for Marker and MarkerArray displays. */
export class MarkerScene {
  private readonly entries = new Map<string, Entry>();
  private readonly pool: Entry[] = [];
  private readonly cubes = new InstancedShapes(UNIT_BOX);
  private readonly spheres = new InstancedShapes(UNIT_SPHERE);
  private readonly cylinders = new InstancedShapes(UNIT_CYLINDER_Z);
  private readonly cones = new InstancedShapes(UNIT_CONE_Z);
  private dirty = true;
  private frameLockedCount = 0;
  private expiringCount = 0;

  constructor(private readonly root: THREE.Group, private readonly host: MarkerHost) {
    root.add(this.cubes, this.spheres, this.cylinders, this.cones);
    for (const pool of [this.cubes, this.spheres, this.cylinders, this.cones]) host.makePickable(pool);
  }

  /** The marker behind a pick hit: pooled shapes via the instance tag, other markers via their object. */
  entryForHit(hit: PickHit): { key: string; entry: Entry } | null {
    const pools = [this.cubes, this.spheres, this.cylinders, this.cones];
    const pool = pools.find((p) => p === hit.object);
    const e = pool ? (pool.tagAt(hit.instance) as Entry | undefined) : hit.object ? (hit.object.userData.markerEntry as Entry | undefined) : undefined;
    if (!e) return null;
    for (const [key, entry] of this.entries) if (entry === e) return { key, entry };
    return null;
  }

  /** Pool slot pose for the highlight box (pooled markers only). */
  /** First pool slot of a _LIST entry (its points are pushed contiguously). */
  firstInstanceOf(hit: PickHit, e: Entry): number {
    const pool = [this.cubes, this.spheres, this.cylinders, this.cones].find((p) => p === hit.object);
    if (!pool) return -1;
    let i = hit.instance;
    while (i > 0 && pool.tagAt(i - 1) === e) i--;
    return i;
  }

  instanceBounds(hit: PickHit, out: THREE.Box3): boolean {
    const pool = [this.cubes, this.spheres, this.cylinders, this.cones].find((p) => p === hit.object);
    if (!pool || !pool.instanceAt(hit.instance, tmpV, tmpV2)) return false;
    out.setFromCenterAndSize(tmpV, tmpV2.multiplyScalar(pool === this.cubes ? 1 : 2));
    return true;
  }

  processMarkers(msg: MarkerArrayMsg, nowMs: number) {
    const n = msg.numeric;
    for (let i = 0; i < msg.count; i++) {
      const o = i * MARKER_STRIDE;
      const action = n[o + MarkerField.Action];
      if (action === DELETEALL) {
        this.clear();
        continue;
      }
      const s = msg.strings[i];
      const ns = s[0];
      const key = `${ns}/${n[o + MarkerField.Id]}`;
      if (action === DELETE) {
        this.remove(key);
        continue;
      }
      this.host.onNamespace(ns);
      if (s[4]) {
        this.remove(key);
        this.host.setStatus('error', key, s[4]);
        continue;
      }
      if (n[o + MarkerField.TfStatus] === 2) {
        this.remove(key);
        this.host.setStatus('error', key, `Could not transform from [${s[1]}] to the fixed frame`);
        continue;
      }
      const type = n[o + MarkerField.Type];
      let e = this.entries.get(key);
      if (e && e.type !== type) {
        this.remove(key);
        e = undefined;
      }
      if (!e) {
        e = this.pool.pop() ?? new Entry();
        e.object = null;
        this.entries.set(key, e);
      }
      if (e.expiresAtMs !== Infinity) this.expiringCount--;
      if (e.frameLocked) this.frameLockedCount--;
      e.msg = msg;
      e.o = o;
      e.ns = ns;
      e.type = type;
      const lifetime = n[o + MarkerField.LifetimeS];
      e.expiresAtMs = lifetime > 0 ? nowMs + lifetime * 1000 : Infinity;
      if (e.expiresAtMs !== Infinity) this.expiringCount++;
      e.frameLocked = n[o + MarkerField.FrameLocked] === 1;
      if (e.frameLocked) this.frameLockedCount++;
      e.frameId = s[1];
      e.pos.set(n[o + MarkerField.Px], n[o + MarkerField.Px + 1], n[o + MarkerField.Px + 2]);
      e.quat.set(n[o + MarkerField.Qx], n[o + MarkerField.Qx + 1], n[o + MarkerField.Qx + 2], n[o + MarkerField.Qx + 3]).normalize();
      if (!POOLED.has(type)) {
        if (e.object && this.updateObject(e.object, msg, i, key)) {
          // reused in place
        } else {
          if (e.object) {
            this.host.releasePickable(e.object);
            e.object.removeFromParent();
            disposeObject(e.object);
          }
          e.object = this.buildObject(msg, i, key);
          if (e.object) {
            this.root.add(e.object);
            e.object.userData.markerEntry = e;
            if (!(e.object instanceof TextSprite)) this.host.makePickable(e.object);
          }
        }
      }
    }
    this.dirty = true;
  }

  private buildObject(msg: MarkerArrayMsg, i: number, key: string): THREE.Object3D | null {
    const n = msg.numeric;
    const o = i * MARKER_STRIDE;
    const s = msg.strings[i];
    const type = n[o + MarkerField.Type];
    const r = n[o + MarkerField.R], g = n[o + MarkerField.R + 1], b = n[o + MarkerField.R + 2], a = n[o + MarkerField.R + 3];
    const rgb = new THREE.Color(r, g, b);
    const points = msg.points.subarray(n[o + MarkerField.PointsOffset], n[o + MarkerField.PointsOffset] + n[o + MarkerField.PointsLen]);
    const colors = msg.colors.subarray(n[o + MarkerField.ColorsOffset], n[o + MarkerField.ColorsOffset] + n[o + MarkerField.ColorsLen]);
    switch (type) {
      case LINE_STRIP:
      case LINE_LIST: {
        const geometry = new THREE.BufferGeometry();
        fillGeometry(geometry, points, colors, r, g, b, a);
        const obj = type === LINE_STRIP ? new THREE.Line(geometry, LINE_MATERIAL) : new THREE.LineSegments(geometry, LINE_MATERIAL);
        obj.frustumCulled = false;
        return obj;
      }
      case POINTS: {
        const count = points.length / 3;
        const buffer = new CloudBuffer(Math.max(16, count));
        const rgb8 = new Uint8Array(count * 3);
        for (let k = 0; k < count; k++) {
          rgb8[k * 3] = colors.length ? colors[k * 4] : r * 255;
          rgb8[k * 3 + 1] = colors.length ? colors[k * 4 + 1] : g * 255;
          rgb8[k * 3 + 2] = colors.length ? colors[k * 4 + 2] : b * 255;
        }
        buffer.set(count, points, rgb8);
        const obj = new CloudObject(buffer);
        obj.setStyle('Squares', n[o + MarkerField.Sx], 3, a);
        obj.refresh(true);
        return obj;
      }
      case TEXT_VIEW_FACING:
        return new TextSprite(s[2], n[o + MarkerField.Sx + 2], `rgb(${(r * 255) | 0},${(g * 255) | 0},${(b * 255) | 0})`);
      case TRIANGLE_LIST: {
        const geometry = new THREE.BufferGeometry();
        fillGeometry(geometry, points, colors, r, g, b, a);
        const obj = new THREE.Mesh(geometry, TRIANGLE_MATERIAL);
        obj.frustumCulled = false;
        return obj;
      }
      case MESH_RESOURCE: {
        const holder = new THREE.Group();
        const uri = s[3];
        holder.userData.uri = uri;
        holder.userData.scale = `${n[o + MarkerField.Sx]},${n[o + MarkerField.Sx + 1]},${n[o + MarkerField.Sx + 2]}`;
        if (!uri) {
          this.host.setStatus('error', key, 'Mesh resource marker has no mesh_resource');
          return holder;
        }
        const scale = [n[o + MarkerField.Sx], n[o + MarkerField.Sx + 1], n[o + MarkerField.Sx + 2]];
        loadMesh(uri)
          .then((mesh) => {
            const inst = mesh.clone(true);
            inst.traverse((obj) => {
              if ((obj as THREE.Mesh).isMesh) (obj as THREE.Mesh).material = new THREE.MeshBasicMaterial({ color: rgb, transparent: a < 1, opacity: a });
            });
            inst.scale.set(scale[0], scale[1], scale[2]);
            holder.add(inst);
          })
          .catch((err) => this.host.setStatus('error', key, `Could not load mesh [${uri}]: ${String(err)}`));
        return holder;
      }
      default:
        this.host.setStatus('error', key, `Unknown marker type ${type}`);
        return null;
    }
  }

  /** Updates an existing per-marker object in place; false if it must be rebuilt. */
  private updateObject(obj: THREE.Object3D, msg: MarkerArrayMsg, i: number, _key: string): boolean {
    const n = msg.numeric;
    const o = i * MARKER_STRIDE;
    const s = msg.strings[i];
    const type = n[o + MarkerField.Type];
    const r = n[o + MarkerField.R], g = n[o + MarkerField.R + 1], b = n[o + MarkerField.R + 2], a = n[o + MarkerField.R + 3];
    const points = msg.points.subarray(n[o + MarkerField.PointsOffset], n[o + MarkerField.PointsOffset] + n[o + MarkerField.PointsLen]);
    const colors = msg.colors.subarray(n[o + MarkerField.ColorsOffset], n[o + MarkerField.ColorsOffset] + n[o + MarkerField.ColorsLen]);
    switch (type) {
      case LINE_STRIP:
      case LINE_LIST:
      case TRIANGLE_LIST:
        fillGeometry((obj as THREE.Mesh).geometry, points, colors, r, g, b, a);
        return true;
      case TEXT_VIEW_FACING:
        (obj as TextSprite).setText(s[2], n[o + MarkerField.Sx + 2], `rgb(${(r * 255) | 0},${(g * 255) | 0},${(b * 255) | 0})`);
        return true;
      case POINTS: {
        const cloud = obj as CloudObject;
        const count = points.length / 3;
        const rgb8 = this.scratchRgb(count);
        for (let k = 0; k < count; k++) {
          rgb8[k * 3] = colors.length ? colors[k * 4] : r * 255;
          rgb8[k * 3 + 1] = colors.length ? colors[k * 4 + 1] : g * 255;
          rgb8[k * 3 + 2] = colors.length ? colors[k * 4 + 2] : b * 255;
        }
        const realloc = cloud.buffer.set(count, points, rgb8);
        cloud.setStyle('Squares', n[o + MarkerField.Sx], 3, a);
        cloud.refresh(realloc);
        return true;
      }
      case MESH_RESOURCE:
        // Same resource: keep the loaded mesh (colour/scale changes are rare; rebuild then).
        return (obj as THREE.Group).userData.uri === s[3] && (obj as THREE.Group).userData.scale === `${n[o + MarkerField.Sx]},${n[o + MarkerField.Sx + 1]},${n[o + MarkerField.Sx + 2]}`;
      default:
        return false;
    }
  }

  private scratch = new Uint8Array(0);
  private scratchRgb(count: number): Uint8Array {
    if (this.scratch.length < count * 3) this.scratch = new Uint8Array(Math.max(count * 3, this.scratch.length * 2));
    return this.scratch.subarray(0, count * 3);
  }

  private remove(key: string) {
    const e = this.entries.get(key);
    if (!e) return;
    if (e.object) {
      this.host.releasePickable(e.object);
      e.object.removeFromParent();
      disposeObject(e.object);
      e.object = null;
    }
    if (e.expiresAtMs !== Infinity) this.expiringCount--;
    if (e.frameLocked) this.frameLockedCount--;
    e.expiresAtMs = Infinity;
    e.frameLocked = false;
    this.entries.delete(key);
    this.pool.push(e);
    this.dirty = true;
  }

  clear() {
    for (const key of [...this.entries.keys()]) this.remove(key);
  }

  /** Once per frame: lifetimes, frame_locked poses, namespace visibility, pool rebuild. */
  update(nowMs: number) {
    if (this.expiringCount > 0) {
      for (const [key, e] of this.entries) if (nowMs >= e.expiresAtMs) this.remove(key);
    }
    if (this.frameLockedCount > 0) this.dirty = true;
    if (!this.dirty) return;
    this.dirty = false;
    this.cubes.begin();
    this.spheres.begin();
    this.cylinders.begin();
    this.cones.begin();
    for (const e of this.entries.values()) {
      let visible = this.host.namespaceVisible(e.ns);
      if (e.frameLocked) {
        visible = visible && this.host.tf.lookup(e.frameId, tmpM, tmpPos, tmpQuat);
        if (visible) {
          const n = e.msg.numeric;
          const o = e.o;
          e.pos.copy(tmpPos).add(tmpV.set(n[o + MarkerField.Px], n[o + MarkerField.Px + 1], n[o + MarkerField.Px + 2]).applyQuaternion(tmpQuat));
          e.quat.copy(tmpQuat).multiply(tmpQ.set(n[o + MarkerField.Qx], n[o + MarkerField.Qx + 1], n[o + MarkerField.Qx + 2], n[o + MarkerField.Qx + 3]));
        }
      }
      if (e.object) {
        e.object.visible = visible;
        e.object.position.copy(e.pos);
        e.object.quaternion.copy(e.quat);
        continue;
      }
      if (visible) this.pushPooled(e);
    }
    this.cubes.end();
    this.spheres.end();
    this.cylinders.end();
    this.cones.end();
  }

  private pushPooled(e: Entry) {
    const n = e.msg.numeric;
    const o = e.o;
    const r = n[o + MarkerField.R] * 255, g = n[o + MarkerField.R + 1] * 255, b = n[o + MarkerField.R + 2] * 255, a = n[o + MarkerField.R + 3] * 255;
    const sx = n[o + MarkerField.Sx], sy = n[o + MarkerField.Sx + 1], sz = n[o + MarkerField.Sx + 2];
    const q = e.quat;
    const p = e.pos;
    switch (e.type) {
      case CUBE:
        this.cubes.push(p.x, p.y, p.z, q.x, q.y, q.z, q.w, sx, sy, sz, r, g, b, a, e);
        break;
      case SPHERE:
        this.spheres.push(p.x, p.y, p.z, q.x, q.y, q.z, q.w, sx / 2, sy / 2, sz / 2, r, g, b, a, e);
        break;
      case CYLINDER:
        this.cylinders.push(p.x, p.y, p.z, q.x, q.y, q.z, q.w, sx / 2, sy / 2, sz, r, g, b, a, e);
        break;
      case CUBE_LIST:
      case SPHERE_LIST: {
        const pool = e.type === CUBE_LIST ? this.cubes : this.spheres;
        const k = e.type === CUBE_LIST ? 1 : 0.5;
        const po = n[o + MarkerField.PointsOffset];
        const count = n[o + MarkerField.PointsLen] / 3;
        const co = n[o + MarkerField.ColorsOffset];
        const hasColors = n[o + MarkerField.ColorsLen] > 0;
        const pts = e.msg.points;
        const cols = e.msg.colors;
        pool.reserve(count);
        for (let i = 0; i < count; i++) {
          tmpV.set(pts[po + i * 3], pts[po + i * 3 + 1], pts[po + i * 3 + 2]).applyQuaternion(q).add(p);
          const ci = co + i * 4;
          pool.push(tmpV.x, tmpV.y, tmpV.z, q.x, q.y, q.z, q.w, sx * k, sy * k, sz * k,
            hasColors ? cols[ci] : r, hasColors ? cols[ci + 1] : g, hasColors ? cols[ci + 2] : b, hasColors ? cols[ci + 3] : a, e);
        }
        break;
      }
      case ARROW: {
        // rviz: scale.x = length, y = shaft diameter, z = head diameter; or two points.
        let start = tmpV.copy(p);
        let dir = tmpDir.set(1, 0, 0).applyQuaternion(q);
        let length = sx;
        let shaftD = sy;
        let headD = sz;
        let headLen = 0.23 * length;
        if (n[o + MarkerField.PointsLen] === 6) {
          const po = n[o + MarkerField.PointsOffset];
          const pts = e.msg.points;
          start = tmpV.set(pts[po], pts[po + 1], pts[po + 2]).applyQuaternion(q).add(p);
          const end = tmpV2.set(pts[po + 3], pts[po + 4], pts[po + 5]).applyQuaternion(q).add(p);
          dir = tmpDir.subVectors(end, start);
          length = dir.length();
          if (length > 0) dir.divideScalar(length);
          shaftD = sx;
          headD = sy;
          headLen = sz > 0 ? sz : 0.23 * length;
        }
        const shaftLen = Math.max(0, length - headLen);
        tmpQ.setFromUnitVectors(Z_AXIS, dir);
        const mid = tmpV2.copy(start).addScaledVector(dir, shaftLen / 2);
        this.cylinders.push(mid.x, mid.y, mid.z, tmpQ.x, tmpQ.y, tmpQ.z, tmpQ.w, shaftD / 2, shaftD / 2, shaftLen, r, g, b, a, e);
        const headBase = tmpV2.copy(start).addScaledVector(dir, shaftLen);
        this.cones.push(headBase.x, headBase.y, headBase.z, tmpQ.x, tmpQ.y, tmpQ.z, tmpQ.w, headD / 2, headD / 2, headLen, r, g, b, a, e);
        break;
      }
    }
  }

  count() {
    return this.entries.size;
  }

  dispose() {
    this.clear();
    this.cubes.dispose();
    this.spheres.dispose();
    this.cylinders.dispose();
    this.cones.dispose();
  }
}

function disposeObject(o: THREE.Object3D) {
  o.traverse((c) => {
    if (c instanceof TextSprite || c instanceof CloudObject) {
      c.dispose();
      return;
    }
    const mesh = c as THREE.Mesh;
    if (mesh.geometry && mesh.geometry !== UNIT_BOX && mesh.geometry !== UNIT_SPHERE && mesh.geometry !== UNIT_CYLINDER_Z && mesh.geometry !== UNIT_CONE_Z) mesh.geometry.dispose?.();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else if (mat && mat !== LINE_MATERIAL && mat !== TRIANGLE_MATERIAL) mat.dispose?.();
  });
}

const tmpM = new THREE.Matrix4();
const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpDir = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const Z_AXIS = new THREE.Vector3(0, 0, 1);

/** Properties and behaviour shared by both marker displays. */
abstract class MarkerDisplayBase extends MessageFilterDisplayBase<DataMessage> {
  readonly namespaces: GroupProperty;
  protected scene: MarkerScene | null = null;
  private readonly nsProps = new Map<string, BoolPropertyImpl>();
  private readonly savedNamespaces = new Map<string, boolean>();

  constructor(info: DisplayClassInfo, decoder: 'marker' | 'marker_array') {
    super(info.classId, info.name, info.messageTypes, info.description);
    this.decoder = decoder;
    this.namespaces = new GroupProperty('Namespaces', this, { description: 'Marker namespaces; untick to hide a namespace.' });
  }

  protected override onInitialize() {
    this.scene = new MarkerScene(this.sceneNode, {
      setStatus: (l, n, t) => this.setStatus(l, n, t),
      deleteStatus: (n) => this.deleteStatus(n),
      tf: this.context!.tf,
      namespaceVisible: (ns) => this.nsProps.get(ns)?.value() ?? true,
      onNamespace: (ns) => this.ensureNamespace(ns),
      makePickable: (o) => this.makePickable(o),
      releasePickable: (o) => this.releasePickable(o),
    });
  }

  override describeSelection(hit: PickHit): Property | null {
    const found = this.scene?.entryForHit(hit);
    if (!found) return null;
    const { key, entry: e } = found;
    const n = e.msg.numeric;
    const o = e.o;
    const g = selectionGroup(`Marker ${key} [${this.name()}]`);
    roString(g, 'Type', MARKER_TYPE_NAMES[e.type] ?? String(e.type));
    roString(g, 'Frame', e.frameId);
    roVector(g, 'Position', e.pos);
    roQuaternion(g, 'Orientation', e.quat);
    roVector(g, 'Scale', { x: n[o + MarkerField.Sx], y: n[o + MarkerField.Sx + 1], z: n[o + MarkerField.Sx + 2] });
    roString(g, 'Color', `${n[o + MarkerField.R].toFixed(3)}; ${n[o + MarkerField.R + 1].toFixed(3)}; ${n[o + MarkerField.R + 2].toFixed(3)}; ${n[o + MarkerField.R + 3].toFixed(3)}`);
    if (e.type === CUBE_LIST || e.type === SPHERE_LIST) {
      const first = this.scene!.firstInstanceOf(hit, e);
      if (first >= 0) roString(g, 'Point', String(hit.instance - first));
    }
    return g;
  }
  override updateSelection(hit: PickHit, prop: Property) {
    const found = this.scene?.entryForHit(hit);
    if (!found) return;
    setVector(prop.child('Position'), found.entry.pos);
    setQuaternion(prop.child('Orientation'), found.entry.quat);
  }
  override selectionBounds(hit: PickHit, out: THREE.Box3): boolean {
    if (this.scene?.instanceBounds(hit, out)) return true;
    const found = this.scene?.entryForHit(hit);
    if (!found) return false;
    const e = found.entry;
    if (e.object) {
      out.setFromObject(e.object);
      return !out.isEmpty();
    }
    const n = e.msg.numeric;
    return boxAround(out, e.pos, Math.max(n[e.o + MarkerField.Sx], n[e.o + MarkerField.Sx + 1], n[e.o + MarkerField.Sx + 2]));
  }

  private ensureNamespace(ns: string) {
    if (this.nsProps.has(ns)) return;
    const p = new BoolPropertyImpl(ns, this.savedNamespaces.get(ns) ?? true, this.namespaces, { description: `Show markers in namespace "${ns}"` });
    p.onChange(() => this.scene?.update(performance.now()));
    this.nsProps.set(ns, p);
  }

  processMessage(msg: DataMessage) {
    if (!this.scene) return;
    this.scene.processMarkers(msg.data as MarkerArrayMsg, performance.now());
    this.setStatus('ok', 'Topic', `${this.scene.count()} markers`);
  }

  override update() {
    this.scene?.update(performance.now());
  }

  override reset() {
    super.reset();
    this.scene?.clear();
  }

  override load(yaml: YamlValue, source: ChangeSource = 'config') {
    super.load(yaml, source);
    const ns = (yaml as { Namespaces?: Record<string, unknown> } | null)?.Namespaces;
    if (ns && typeof ns === 'object') {
      for (const [k, v] of Object.entries(ns)) if (typeof v === 'boolean') this.savedNamespaces.set(k, v);
    }
  }

  override dispose() {
    this.scene?.dispose();
    super.dispose();
  }
}

export class MarkerDisplay extends MarkerDisplayBase {
  constructor() {
    super(MARKER_INFO, 'marker');
  }
}

/** MarkerArray is a plain RosTopicDisplay in rviz (no message filter), so no "Filter size". */
export class MarkerArrayDisplay extends MarkerDisplayBase {
  constructor() {
    super(MARKER_ARRAY_INFO, 'marker_array');
    this.topic.removeChild(this.topic.filterSize!);
  }
}
