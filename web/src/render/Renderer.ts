import { createEffect, createRoot, createSignal } from 'solid-js';
import * as THREE from 'three/webgpu';
import { getApp } from '../app/store';
import { ViewportInput } from './input';
import { enablePerf, measure } from './perf';
import type { ViewportServices } from '../tools/types';
import type { PickHit } from './picking';

/** Status bar text set by the active tool (rviz Tool::setStatus). */
export const [toolStatus, setToolStatus] = createSignal('');

/** Which backend the renderer ended up on; shown in the status bar. */
export const [renderBackend, setRenderBackend] = createSignal<string>('initializing');

/** Measured frames per second over the last second (status bar / perf checks). */
export const [measuredFps, setMeasuredFps] = createSignal(0);
/** Frames whose render step took longer than 16 ms since the last reset, and the worst one (ms). */
export const [longFrames, setLongFrames] = createSignal(0);
export const [worstFrameMs, setWorstFrameMs] = createSignal(0);
export function resetPerfCounters() {
  setLongFrames(0);
  setWorstFrameMs(0);
}

/**
 * Owns the three.js renderer and the render loop for the 3D view. The scene
 * belongs to the app store, the camera to the current ViewController, input
 * goes to the ToolManager. WebGPU by default, automatic WebGL2 fallback (or
 * `?webgl` to force it).
 */
export class Viewport implements ViewportServices {
  readonly renderer: THREE.WebGPURenderer;
  readonly scene: THREE.Scene;
  /** Tool-drawn geometry (never pickable). */
  readonly helpers = new THREE.Group();
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private mouseX = 0;
  private mouseY = 0;
  private readonly resizeObserver: ResizeObserver;
  private readonly input: ViewportInput;
  private disposed = false;
  private lastFrameMs = 0;
  private targetFps = 30;
  private fpsCount = 0;
  private fpsWindowStart = 0;
  private disposeEffects: (() => void) | null = null;
  private width = 1;
  private height = 1;

  constructor(private readonly container: HTMLElement) {
    const forceWebGL = new URLSearchParams(location.search).has('webgl');
    enablePerf(new URLSearchParams(location.search).has('perf'));
    this.renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    const app = getApp();
    this.scene = app.scene;
    this.scene.background = new THREE.Color();
    this.disposeEffects = createRoot((dispose) => {
      // Global Options → Background Color / Frame Rate.
      createEffect(() => {
        const c = app.manager.backgroundColor.value();
        (this.scene.background as THREE.Color).setRGB(c.r / 255, c.g / 255, c.b / 255, THREE.SRGBColorSpace);
      });
      createEffect(() => {
        this.targetFps = app.manager.frameRate.value();
      });
      return dispose;
    });

    this.helpers.name = 'tool helpers';
    this.helpers.userData.noPick = true;
    this.scene.add(this.helpers);
    this.input = new ViewportInput(container, {
      handleMouse: (e) => {
        if (e.type !== 'wheel') {
          this.mouseX = e.x;
          this.mouseY = e.y;
        }
        app.manager.tools.handleMouse(e);
      },
      handleKey: (key, e) => app.handleViewportKey(key, e),
    });
    app.manager.tools.attachViewport(this);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    void this.start();
  }

  private async start() {
    await this.renderer.init();
    if (this.disposed) return;
    const backend = this.renderer.backend as { isWebGPUBackend?: boolean };
    setRenderBackend(backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2');
    void this.renderer.setAnimationLoop((t) => this.frame(t));
  }

  private frame(timeMs: number) {
    // rAF throttling to Global Options → Frame Rate.
    const minInterval = 1000 / this.targetFps;
    if (timeMs - this.lastFrameMs < minInterval - 1) return;
    const dt = this.lastFrameMs ? (timeMs - this.lastFrameMs) / 1000 : 0;
    this.lastFrameMs = timeMs;
    this.fpsCount++;
    if (timeMs - this.fpsWindowStart >= 1000) {
      setMeasuredFps(Math.round((this.fpsCount * 1000) / (timeMs - this.fpsWindowStart)));
      this.fpsCount = 0;
      this.fpsWindowStart = timeMs;
    }
    // Per-frame work must not allocate; displays update GPU buffers in place (spec §9.7).
    const manager = getApp().manager;
    const t0 = performance.now();
    manager.views.setAspect(this.width / this.height);
    measure('update', () => manager.update(dt));
    measure('render', () => this.renderer.render(this.scene, manager.views.current().camera));
    const took = performance.now() - t0;
    if (took > 16) setLongFrames(longFrames() + 1);
    if (took > worstFrameMs()) setWorstFrameMs(Math.round(took * 10) / 10);
  }

  private resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
  }

  // --- ViewportServices (tools) ---------------------------------------------

  camera(): THREE.Camera {
    return getApp().manager.views.current().camera;
  }
  size() {
    return { width: this.width, height: this.height };
  }
  lastMouse() {
    return { x: this.mouseX, y: this.mouseY };
  }
  ray(x: number, y: number, out: THREE.Ray): THREE.Ray {
    this.ndc.set((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera());
    out.copy(this.raycaster.ray);
    return out;
  }
  groundPoint(x: number, y: number, out: THREE.Vector3): boolean {
    this.ray(x, y, tmpRay);
    return tmpRay.intersectPlane(GROUND, out) !== null;
  }
  async pick(_x: number, _y: number, _w: number, _h: number): Promise<PickHit[]> {
    return [];
  }
  async pickPoint(_x: number, _y: number): Promise<PickHit | null> {
    return null;
  }
  setCursor(cursor: 'default' | 'crosshair' | 'move' | 'grab' | 'pointer') {
    this.container.style.cursor = cursor;
  }
  setStatus(text: string) {
    setToolStatus(text);
  }

  dispose() {
    this.disposed = true;
    getApp().manager.tools.attachViewport(null);
    this.helpers.removeFromParent();
    this.disposeEffects?.();
    this.input.dispose();
    this.resizeObserver.disconnect();
    void this.renderer.setAnimationLoop(null);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

const GROUND = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const tmpRay = new THREE.Ray();
