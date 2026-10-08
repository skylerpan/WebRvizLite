/**
 * Colour-ID picking (spec §7.3, rviz SelectionManager's render pass).
 *
 * One extra render of the scene into a small float render target that covers
 * only the picked viewport box (camera view offset). A TSL multi-render-target
 * writes `vec4(pickId, instanceIndex, depth, 1)` per fragment: `pickId` is a
 * per-object uniform looked up from `userData.pickId` (walking up parents, so
 * registering a Group tags everything under it), `instanceIndex` is the
 * instanced-shape / point / InstancedMesh index. The pixels are read back and
 * the world position is recovered by un-projecting the depth, which works for
 * every object kind (meshes, lines, instanced sprites) on both backends.
 */

import * as THREE from 'three/webgpu';
import { depth, float, instanceIndex, mrt, uniform, vec4 } from 'three/tsl';
import type { Property } from '../property/types';

export interface PickHit {
  /** Registered pick id (0 = unregistered surface, e.g. the map or grid). */
  pickId: number;
  /** Instance / point index within the picked object (0 for plain meshes). */
  instance: number;
  /** Normalised depth in [0, 1] (smaller = closer). */
  depth: number;
  /** Surface point in the fixed frame. */
  worldPos: THREE.Vector3;
  /** The registered root object, if any. */
  object: THREE.Object3D | null;
  owner: Pickable | null;
}

/** Implemented by displays whose objects can be selected. */
export interface Pickable {
  /** Read-only property subtree for the Selection panel, or null to ignore the hit. */
  describeSelection(hit: PickHit): Property | null;
  /** Bounding box of the hit for focus / highlight; false if unknown. */
  selectionBounds?(hit: PickHit, out: THREE.Box3): boolean;
  /** Refreshes live values of a description made earlier (once per frame). */
  updateSelection?(hit: PickHit, prop: Property): void;
}

/** Object id lookup. Ids start at 1; 0 means "not selectable but occluding". */
export class PickRegistry {
  private readonly entries = new Map<number, { owner: Pickable; object: THREE.Object3D }>();
  private readonly free: number[] = [];
  private next = 1;

  register(owner: Pickable, object: THREE.Object3D): number {
    this.unregister(object);
    const id = this.free.pop() ?? this.next++;
    this.entries.set(id, { owner, object });
    object.userData.pickId = id;
    return id;
  }

  unregister(object: THREE.Object3D) {
    const id = object.userData.pickId as number | undefined;
    if (!id) return;
    if (this.entries.get(id)?.object === object) {
      this.entries.delete(id);
      this.free.push(id);
    }
    delete object.userData.pickId;
  }

  resolve(id: number) {
    return this.entries.get(id);
  }
}

/** Per-object id for the pick pass: the nearest ancestor's userData.pickId. */
export const pickIdUniform = uniform(0).onObjectUpdate(({ object }) => {
  let o: THREE.Object3D | null = object as THREE.Object3D;
  while (o) {
    const id = o.userData.pickId as number | undefined;
    if (id) return id;
    o = o.parent;
  }
  return 0;
});

export const PICK_OUTPUT = 'pick';
export const PICK_MRT = mrt({ [PICK_OUTPUT]: vec4(pickIdUniform, float(instanceIndex), depth, 1) });
PICK_MRT.setClearColor(PICK_OUTPUT, 0x000000, 0);

const MAX_PICK_PIXELS = 1_000_000;

export class Picker {
  private readonly target: THREE.RenderTarget;
  private readonly hidden: THREE.Object3D[] = [];
  private readonly occluders: THREE.Material[] = [];
  private busy: Promise<unknown> = Promise.resolve();

  constructor(private readonly renderer: THREE.WebGPURenderer, private readonly scene: THREE.Scene, private readonly registry: PickRegistry) {
    this.target = new THREE.RenderTarget(1, 1, {
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
      depthBuffer: true,
      stencilBuffer: false,
      samples: 0,
    });
    this.target.texture.name = PICK_OUTPUT;
  }

  /** All hits in the viewport box (x, y, w, h in CSS pixels of a vw × vh viewport), nearest per (id, instance). */
  pick(camera: THREE.Camera, x: number, y: number, w: number, h: number, vw: number, vh: number): Promise<PickHit[]> {
    // Serialise picks: one render target.
    const run = this.busy.then(() => this.doPick(camera, x, y, w, h, vw, vh));
    this.busy = run.catch(() => undefined);
    return run;
  }

  private async doPick(camera: THREE.Camera, x: number, y: number, w: number, h: number, vw: number, vh: number): Promise<PickHit[]> {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(vw, Math.ceil(x + w));
    const y1 = Math.min(vh, Math.ceil(y + h));
    const pw = Math.max(1, x1 - x0);
    const ph = Math.max(1, y1 - y0);
    if (pw * ph > MAX_PICK_PIXELS || vw < 1 || vh < 1) return [];
    const dpr = this.renderer.getPixelRatio();
    const tw = Math.max(1, Math.round(pw * dpr));
    const th = Math.max(1, Math.round(ph * dpr));
    if (this.target.width !== tw || this.target.height !== th) this.target.setSize(tw, th);

    const cam = camera as THREE.PerspectiveCamera | THREE.OrthographicCamera;
    cam.setViewOffset(vw, vh, x0, y0, pw, ph);
    cam.updateMatrixWorld();
    const projInv = tmpProjInv.copy(cam.projectionMatrixInverse);
    const world = tmpWorld.copy(cam.matrixWorld);

    this.prepareScene();
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevMrt = r.getMRT();
    const background = this.scene.background;
    this.scene.background = null;
    try {
      r.setRenderTarget(this.target);
      r.setMRT(PICK_MRT);
      r.render(this.scene, cam);
    } finally {
      r.setMRT(prevMrt);
      r.setRenderTarget(prevTarget);
      this.scene.background = background;
      this.restoreScene();
      cam.clearViewOffset();
    }

    const px = await this.readPixels(tw, th);
    const flipY = !(r.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend;
    const webgpuDepth = r.coordinateSystem === THREE.WebGPUCoordinateSystem;
    const hits = new Map<number, PickHit>();
    for (let row = 0; row < th; row++) {
      const rowTop = flipY ? th - 1 - row : row;
      for (let col = 0; col < tw; col++) {
        const i = (row * tw + col) * 4;
        if (px[i + 3] < 0.5) continue;
        const id = Math.round(px[i]);
        const instance = Math.round(px[i + 1]);
        const d = px[i + 2];
        const key = id * 16_777_216 + instance;
        const prev = hits.get(key);
        if (prev && prev.depth <= d) continue;
        const ndcX = ((col + 0.5) / tw) * 2 - 1;
        const ndcY = 1 - ((rowTop + 0.5) / th) * 2;
        const ndcZ = webgpuDepth ? d : d * 2 - 1;
        const worldPos = prev ? prev.worldPos : new THREE.Vector3();
        worldPos.set(ndcX, ndcY, ndcZ).applyMatrix4(projInv).applyMatrix4(world);
        if (prev) {
          prev.depth = d;
        } else {
          const entry = id ? this.registry.resolve(id) : undefined;
          hits.set(key, { pickId: id, instance, depth: d, worldPos, object: entry?.object ?? null, owner: entry?.owner ?? null });
        }
      }
    }
    return [...hits.values()];
  }

  /**
   * Reads the pick target back. The WebGL2 backend's async path polls a GPU
   * fence with requestAnimationFrame, which never fires in a background tab,
   * so there we read synchronously through the context instead.
   */
  private async readPixels(tw: number, th: number): Promise<Float32Array> {
    const backend = this.renderer.backend as unknown as {
      isWebGPUBackend?: boolean;
      gl?: WebGL2RenderingContext;
      get?: (t: THREE.Texture) => { textureGPU: WebGLTexture };
      state?: { bindFramebuffer: (target: number, fb: WebGLFramebuffer | null) => void };
    };
    if (backend.isWebGPUBackend || !backend.gl || !backend.get || !backend.state) {
      return (await this.renderer.readRenderTargetPixelsAsync(this.target, 0, 0, tw, th)) as Float32Array;
    }
    const gl = backend.gl;
    const { textureGPU } = backend.get(this.target.texture);
    const fb = gl.createFramebuffer();
    backend.state.bindFramebuffer(gl.READ_FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, textureGPU, 0);
    const out = new Float32Array(tw * th * 4);
    gl.readPixels(0, 0, tw, th, gl.RGBA, gl.FLOAT, out);
    backend.state.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    return out;
  }

  /** The nearest surface under one pixel (registered or not); null when nothing was rendered there. */
  async pickPoint(camera: THREE.Camera, x: number, y: number, vw: number, vh: number): Promise<PickHit | null> {
    const hits = await this.pick(camera, x, y, 1, 1, vw, vh);
    let best: PickHit | null = null;
    for (const h of hits) if (!best || h.depth < best.depth) best = h;
    return best;
  }

  /** Hides non-pickable helpers and makes occluders (e.g. the map plane) write depth. */
  private prepareScene() {
    this.scene.traverse((o) => {
      if (o.userData.noPick && o.visible) {
        o.visible = false;
        this.hidden.push(o);
      }
      if (o.userData.pickOccluder) {
        const m = (o as THREE.Mesh).material as THREE.Material | undefined;
        if (m && !m.depthWrite) {
          m.depthWrite = true;
          this.occluders.push(m);
        }
      }
    });
  }

  private restoreScene() {
    for (const o of this.hidden) o.visible = true;
    this.hidden.length = 0;
    for (const m of this.occluders) m.depthWrite = false;
    this.occluders.length = 0;
  }

  dispose() {
    this.target.dispose();
  }
}

const tmpProjInv = new THREE.Matrix4();
const tmpWorld = new THREE.Matrix4();
