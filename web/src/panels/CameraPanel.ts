/**
 * Dock panel of a Camera display (rviz CameraDisplay's render panel): its own
 * canvas and WebGPURenderer sharing the main THREE.Scene, drawing the camera
 * image as a background and/or an overlay around the 3D scene seen from the
 * camera's intrinsics. The display drives it through `CameraPanel.get(id)`.
 */

import * as THREE from 'three/webgpu';
import type { GroupPanelPartInitParameters, IContentRenderer } from 'dockview';
import type { ImageMsg } from '../worker/decoders';
import { isLayoutRebuilding } from '../app/layout';

export type ImageRendering = 'background' | 'overlay' | 'both';

export class CameraPanel implements IContentRenderer {
  private static readonly byId = new Map<string, CameraPanel>();
  /** Per-panel close handlers registered by the owning display. */
  static readonly closeHandlers = new Map<string, (byUser: boolean) => void>();
  readonly element = document.createElement('div');
  private readonly canvas = document.createElement('canvas');
  private renderer: THREE.WebGPURenderer | null = null;
  private ready = false;
  private id = '';
  private readonly quadScene = new THREE.Scene();
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly bgMaterial = new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false });
  private readonly overlayMaterial = new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false, transparent: true, opacity: 0.5 });
  private readonly quad: THREE.Mesh;
  private texture: THREE.DataTexture | null = null;
  private imageW = 0;
  private imageH = 0;
  private visible = true;

  constructor() {
    this.element.className = 'wrl-camera-panel';
    this.element.appendChild(this.canvas);
    // Full-screen quad; UVs flipped so row 0 of the image is at the top.
    const geometry = new THREE.PlaneGeometry(2, 2);
    const uv = geometry.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
    this.quad = new THREE.Mesh(geometry, this.bgMaterial);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  init(params: GroupPanelPartInitParameters) {
    this.id = params.api.id;
    CameraPanel.byId.set(this.id, this);
    params.api.onDidVisibilityChange((e) => {
      this.visible = e.isVisible;
    });
    const forceWebGL = new URLSearchParams(location.search).has('webgl');
    this.renderer = new THREE.WebGPURenderer({ canvas: this.canvas, antialias: true, forceWebGL });
    this.renderer.setPixelRatio(1);
    void this.renderer.init().then(() => {
      this.ready = true;
    });
  }

  static get(id: string): CameraPanel | undefined {
    return CameraPanel.byId.get(id);
  }

  /** Uploads a new image frame (RGBA8, transferred from the worker). */
  setImage(msg: ImageMsg) {
    if (!this.texture || this.imageW !== msg.width || this.imageH !== msg.height) {
      this.texture?.dispose();
      this.texture = new THREE.DataTexture(msg.rgba, msg.width, msg.height, THREE.RGBAFormat);
      this.texture.colorSpace = THREE.SRGBColorSpace;
      this.texture.minFilter = THREE.LinearFilter;
      this.texture.magFilter = THREE.LinearFilter;
      this.imageW = msg.width;
      this.imageH = msg.height;
      this.bgMaterial.map = this.texture;
      this.overlayMaterial.map = this.texture;
      this.bgMaterial.needsUpdate = true;
      this.overlayMaterial.needsUpdate = true;
    } else {
      this.texture.image.data = msg.rgba;
    }
    this.texture.needsUpdate = true;
  }

  get imageWidth() {
    return this.imageW;
  }

  get imageHeight() {
    return this.imageH;
  }

  /** False while the dock panel is hidden or the renderer is still initialising: rendering would be wasted. */
  isVisible() {
    return this.renderer !== null && this.ready && this.visible;
  }

  coordinateSystem(): THREE.CoordinateSystem {
    return this.renderer?.coordinateSystem ?? THREE.WebGLCoordinateSystem;
  }

  /**
   * Draws one frame: image behind and/or over the scene. Skipped while the
   * panel is hidden or the renderer is still initialising.
   */
  render(scene: THREE.Scene, camera: THREE.Camera, mode: ImageRendering, overlayAlpha: number) {
    const r = this.renderer;
    if (!r || !this.ready || !this.visible) return;
    const w = this.element.clientWidth;
    const h = this.element.clientHeight;
    if (w === 0 || h === 0) return;
    // Keep the image aspect: the canvas is letterboxed by CSS.
    let cw = w, ch = h;
    if (this.imageW && this.imageH) {
      const ar = this.imageW / this.imageH;
      if (w / h > ar) cw = Math.round(h * ar);
      else ch = Math.round(w / ar);
    }
    if (this.canvas.width !== cw || this.canvas.height !== ch) r.setSize(cw, ch, true);
    const hasImage = this.texture !== null;
    r.autoClear = true;
    if (hasImage && mode !== 'overlay') {
      this.quad.material = this.bgMaterial;
      r.render(this.quadScene, this.quadCamera);
      r.autoClear = false;
    }
    r.render(scene, camera);
    if (hasImage && mode !== 'background') {
      this.overlayMaterial.opacity = overlayAlpha;
      this.quad.material = this.overlayMaterial;
      r.autoClear = false;
      r.render(this.quadScene, this.quadCamera);
    }
    r.autoClear = true;
  }

  dispose() {
    CameraPanel.byId.delete(this.id);
    this.texture?.dispose();
    this.bgMaterial.dispose();
    this.overlayMaterial.dispose();
    this.quad.geometry.dispose();
    this.renderer?.dispose();
    this.renderer = null;
    CameraPanel.closeHandlers.get(this.id)?.(!isLayoutRebuilding());
  }
}
