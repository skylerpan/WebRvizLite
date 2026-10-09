/**
 * rviz_default_plugins/Camera (camera_display.cpp): the 3D scene rendered
 * through the camera's intrinsics (sensor_msgs/CameraInfo) over / under the
 * camera image, in its own panel. Visibility picks which displays appear.
 */

import * as THREE from 'three/webgpu';
import { DisplayGroupImpl, RosTopicDisplayBase } from './Display';
import { BoolPropertyImpl, EnumPropertyImpl, FloatPropertyImpl } from '../property/Property';
import type { Display, DisplayClassInfo, ExtraView } from './types';
import type { DataMessage } from '../worker/messages';
import type { CameraInfoMsg, ImageMsg } from '../worker/decoders';
import { CameraPanel, type ImageRendering } from '../panels/CameraPanel';

export const CAMERA_INFO_DISPLAY: DisplayClassInfo = {
  classId: 'rviz_default_plugins/Camera',
  name: 'Camera',
  description: 'Displays an image from a camera, with the visualized world rendered behind it.',
  messageTypes: ['sensor_msgs/msg/Image'],
};

/**
 * Upper bound for re-rendering the camera view when no new image arrived
 * (rviz redraws it every frame). The scene has no cheap "changed" signal, so
 * the view is refreshed at this rate to follow moving geometry; a new image
 * or CameraInfo redraws immediately.
 */
export const CAMERA_VIEW_MAX_HZ = 15;

let nextPanelId = 1;

/** rviz: `<image topic with its last element replaced>/camera_info`. */
export function cameraInfoTopic(imageTopic: string): string {
  const i = imageTopic.lastIndexOf('/');
  return (i > 0 ? imageTopic.slice(0, i) : '') + '/camera_info';
}

export class CameraDisplay extends RosTopicDisplayBase<DataMessage> implements ExtraView {
  readonly imageRendering: EnumPropertyImpl;
  readonly overlayAlpha: FloatPropertyImpl;
  readonly zoomFactor: FloatPropertyImpl;
  readonly farPlane: FloatPropertyImpl;
  readonly visibility: BoolPropertyImpl;
  readonly panelId = `camera:${nextPanelId++}`;
  private panelOpen = false;
  private infoSubscription: number | null = null;
  private info: CameraInfoMsg | null = null;
  private infoFrame = '';
  private imageFrame = '';
  private readonly camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.01, 100);
  private readonly visProps = new Map<Display, BoolPropertyImpl>();
  private savedVisibility: Record<string, boolean> = {};
  /** Display list the Visibility rows were last synced against (the signal hands out a new array on change). */
  private syncedDisplays: readonly Display[] | null = null;
  /** A new image or CameraInfo arrived since the last render. */
  private viewDirty = false;
  private lastRenderMs = -Infinity;
  private lastTransformOk: boolean | null = null;
  /** Objects hidden for the duration of one camera render (reused, no per-frame allocation). */
  private readonly hiddenNodes: THREE.Object3D[] = [];

  constructor() {
    super(CAMERA_INFO_DISPLAY.classId, CAMERA_INFO_DISPLAY.name, CAMERA_INFO_DISPLAY.messageTypes, CAMERA_INFO_DISPLAY.description, { depth: 5 });
    this.decoder = 'image';
    this.imageRendering = new EnumPropertyImpl('Image Rendering', 'background and overlay', ['background', 'overlay', 'background and overlay'], this, { description: 'Render the image behind all other geometry or overlay it on top, or both.' });
    this.overlayAlpha = new FloatPropertyImpl('Overlay Alpha', 0.5, this, { description: 'The amount of transparency to apply to the camera image when rendered as overlay.', min: 0, max: 1 });
    this.zoomFactor = new FloatPropertyImpl('Zoom Factor', 1, this, { description: 'Set a zoom factor below 1 to see a larger part of the world, above 1 to magnify the image.', min: 0.00001, max: 100000 });
    this.farPlane = new FloatPropertyImpl('Far Plane Distance', 100, this, { description: "Geometry beyond the camera's far plane will not be rendered.", min: 0.00001, max: 100000 });
    // camera_display.cpp inserts Visibility as the first row.
    this.visibility = new BoolPropertyImpl('Visibility', true, null, { description: 'Changes the visibility of other Displays in the camera view.' });
    this.addChild(this.visibility, 0);
    this.camera.matrixAutoUpdate = true;
    this.topic.onChange(() => this.resubscribeInfo());
    for (const c of this.topic.children()) c.onChange(() => this.resubscribeInfo());
    for (const p of [this.imageRendering, this.overlayAlpha, this.zoomFactor, this.farPlane, this.visibility]) p.onChange(() => (this.viewDirty = true));
    CameraPanel.closeHandlers.set(this.panelId, (byUser) => {
      this.panelOpen = false;
      if (byUser && this.enabled()) this.setEnabled(false);
    });
  }

  protected override onInitialize() {
    this.context!.extraViews.add(this);
  }

  // --- panel ---------------------------------------------------------------

  private ensurePanel() {
    const host = this.context?.panels();
    if (!host || this.panelOpen) return;
    host.openDisplayPanel(this.panelId, 'camera', this.name(), { width: 480, height: 360 });
    this.panelOpen = true;
  }

  private closePanel() {
    if (!this.panelOpen) return;
    this.panelOpen = false;
    this.context?.panels()?.closePanel(this.panelId);
  }

  override setName(name: string) {
    super.setName(name);
    if (this.panelOpen) this.context?.panels()?.setPanelTitle(this.panelId, name);
  }

  // --- subscriptions -------------------------------------------------------

  override onEnable() {
    super.onEnable();
    this.resubscribeInfo();
    this.ensurePanel();
  }

  override onDisable() {
    super.onDisable();
    this.unsubscribeInfo();
    this.closePanel();
  }

  private resubscribeInfo() {
    this.unsubscribeInfo();
    if (!this.context || !this.enabled()) return;
    const topic = this.topic.value();
    if (!topic) return;
    const infoTopic = cameraInfoTopic(topic);
    this.infoSubscription = this.context.bridge.subscribe(
      // camera_display.cpp subscribes CameraInfo with rclcpp::SensorDataQoS (best effort, depth 5).
      infoTopic, 'sensor_msgs/msg/CameraInfo', { depth: 5, history: 'keep_last', reliability: 'best_effort', durability: 'volatile' }, 'camera_info',
      (m) => {
        this.info = (m as DataMessage).data as CameraInfoMsg;
        this.infoFrame = (m as DataMessage).frameId;
        this.viewDirty = true;
        this.setStatus('ok', 'Camera Info', `OK (${infoTopic})`);
      },
      {},
      (message) => this.setStatus('error', 'Camera Info', message),
    );
    this.setStatus('warn', 'Camera Info', `Expecting Camera Info on topic [${infoTopic}]. No CameraInfo received. Topic may not exist.`);
  }

  private unsubscribeInfo() {
    if (this.infoSubscription !== null && this.context) {
      this.context.bridge.unsubscribe(this.infoSubscription);
      this.infoSubscription = null;
    }
  }

  processMessage(msg: DataMessage) {
    const d = msg.data as ImageMsg;
    this.imageFrame = msg.frameId;
    this.viewDirty = true;
    this.setStatus('ok', 'Image', `${d.width} x ${d.height} ${d.encoding}`);
    CameraPanel.get(this.panelId)?.setImage(d);
  }

  // --- visibility list -----------------------------------------------------

  /** Rebuilds the Visibility rows for a changed top-level display list. */
  private syncVisibility(displays: readonly Display[]) {
    const present = new Set(displays);
    for (const [d, p] of this.visProps) {
      if (!present.has(d)) {
        this.visibility.removeChild(p);
        this.visProps.delete(d);
      }
    }
    for (const d of displays) {
      if (d === this || this.visProps.has(d)) continue;
      const p = new BoolPropertyImpl(d.name(), this.savedVisibility[d.name()] ?? true, this.visibility, { description: `Show "${d.name()}" in this camera view.` });
      p.onChange(() => (this.viewDirty = true));
      this.visProps.set(d, p);
    }
  }

  /**
   * Hides the displays unticked in Visibility (and this display itself) for
   * the camera render. Group children are hidden with their group: a child's
   * scene node hangs directly under the scene, not under the group's node.
   */
  private hideForRender(displays: readonly Display[], hideAll: boolean) {
    for (const d of displays) {
      const hide = hideAll || d === this || this.visProps.get(d)?.value() === false;
      if (d instanceof DisplayGroupImpl) {
        this.hideForRender(d.displays(), hide);
        continue;
      }
      if (hide && d.sceneNode.visible) {
        d.sceneNode.visible = false;
        this.hiddenNodes.push(d.sceneNode);
      }
    }
  }

  // --- rendering -----------------------------------------------------------

  override update() {
    if (!this.panelOpen) this.ensurePanel();
    const displays = this.context?.rootDisplays();
    if (displays && displays !== this.syncedDisplays) {
      this.syncedDisplays = displays;
      this.syncVisibility(displays);
    }
  }

  private setTransformStatus(ok: boolean, text: string) {
    if (this.lastTransformOk === ok && ok) return;
    this.lastTransformOk = ok;
    this.setStatus(ok ? 'ok' : 'error', 'Transform', text);
  }

  /** Called by the main render loop after the 3D view (ExtraView). */
  render() {
    const panel = CameraPanel.get(this.panelId);
    const ctx = this.context;
    if (!panel || !ctx || !this.enabled() || !panel.isVisible()) return;
    const now = performance.now();
    if (!this.viewDirty && now - this.lastRenderMs < 1000 / CAMERA_VIEW_MAX_HZ) return;
    const frame = this.infoFrame || this.imageFrame;
    if (!frame) return;
    if (!ctx.tf.lookup(frame, tmpM, this.camera.position, tmpQ)) {
      this.setTransformStatus(false, `No transform from [${frame}] to [${ctx.fixedFrame()}]`);
      return;
    }
    this.setTransformStatus(true, 'Transform OK');
    // ROS optical frame (z forward, y down) → three camera (-z forward, y up): 180° about x.
    this.camera.quaternion.copy(tmpQ).multiply(OPTICAL_TO_CAMERA);
    this.camera.updateMatrixWorld();
    const info = this.info;
    const w = info?.width || panel.imageWidth || 640;
    const h = info?.height || panel.imageHeight || 480;
    // camera_display.cpp uses the projection matrix P (binning and ROI are ignored).
    const fx = info?.p[0] || w;
    const fy = info?.p[5] || fx;
    const cx = info?.p[2] || w / 2;
    const cy = info?.p[6] || h / 2;
    if (info && !(Number.isFinite(fx) && Number.isFinite(fy) && Number.isFinite(cx) && Number.isFinite(cy))) {
      this.setStatus('error', 'Camera Info', 'Contains invalid floating point values (nans or infs)');
      return;
    }
    // Stereo right camera: P[3] / P[7] shift the projection centre (translatePosition in rviz).
    const tx = info ? -info.p[3] / fx : 0;
    const ty = info ? -info.p[7] / fy : 0;
    if (tx || ty) {
      tmpV.set(tx, -ty, 0).applyQuaternion(this.camera.quaternion);
      this.camera.position.add(tmpV);
      this.camera.updateMatrixWorld();
    }
    const near = 0.01;
    const far = this.farPlane.value();
    // Zoom keeps the image aspect: only the axis that would distort is shrunk.
    let zx = this.zoomFactor.value();
    let zy = zx;
    const panelAspect = panel.imageWidth && panel.imageHeight ? panel.imageWidth / panel.imageHeight : w / h;
    const imgAspect = w / fx / (h / fy);
    if (imgAspect > panelAspect) zy = (zy / imgAspect) * panelAspect;
    else zx = (zx * imgAspect) / panelAspect;
    // Off-axis frustum from the intrinsics (rviz CameraDisplay::updateCamera).
    const left = (-cx / fx) * near / zx;
    const right = ((w - cx) / fx) * near / zx;
    const top = (cy / fy) * near / zy;
    const bottom = (-(h - cy) / fy) * near / zy;
    const coord = panel.coordinateSystem();
    this.camera.near = near;
    this.camera.far = far;
    this.camera.projectionMatrix.makePerspective(left, right, top, bottom, near, far, coord);
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
    const mode = this.imageRendering.value();
    const rendering: ImageRendering = mode === 'background' ? 'background' : mode === 'overlay' ? 'overlay' : 'both';
    // Visibility: hide the unticked displays and the main-view-only helpers for this render.
    this.hideForRender(ctx.rootDisplays(), false);
    for (const o of ctx.scene.children) {
      if (o.userData.mainViewOnly && o.visible) {
        o.visible = false;
        this.hiddenNodes.push(o);
      }
    }
    try {
      panel.render(ctx.scene, this.camera, rendering, this.overlayAlpha.value());
    } finally {
      for (const o of this.hiddenNodes) o.visible = true;
      this.hiddenNodes.length = 0;
    }
    this.viewDirty = false;
    this.lastRenderMs = now;
  }

  override save() {
    return super.save();
  }

  override load(yaml: import('../property/types').YamlValue, source: import('../property/types').ChangeSource = 'config') {
    const vis = (yaml as { Visibility?: Record<string, unknown> } | null)?.Visibility;
    if (vis && typeof vis === 'object') {
      for (const [k, v] of Object.entries(vis)) if (typeof v === 'boolean' && k !== 'Value') this.savedVisibility[k] = v;
    }
    super.load(yaml, source);
  }

  override dispose() {
    CameraPanel.closeHandlers.delete(this.panelId);
    this.closePanel();
    this.unsubscribeInfo();
    this.context?.extraViews.delete(this);
    super.dispose();
  }
}

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();
const OPTICAL_TO_CAMERA = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
