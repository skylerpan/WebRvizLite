/**
 * rviz_default_plugins/Camera (camera_display.cpp): the 3D scene rendered
 * through the camera's intrinsics (sensor_msgs/CameraInfo) over / under the
 * camera image, in its own panel. Visibility picks which displays appear.
 */

import * as THREE from 'three/webgpu';
import { RosTopicDisplayBase } from './Display';
import { BoolPropertyImpl, EnumPropertyImpl, FloatPropertyImpl } from '../property/Property';
import type { Display, DisplayClassInfo, ExtraView } from './types';
import type { DataMessage } from '../worker/messages';
import type { CameraInfoMsg, ImageMsg } from '../worker/decoders';
import { CameraPanel, type ImageRendering } from '../panels/CameraPanel';
import { allocLayer, releaseLayer } from '../render/layers';

export const CAMERA_INFO_DISPLAY: DisplayClassInfo = {
  classId: 'rviz_default_plugins/Camera',
  name: 'Camera',
  description: 'Displays an image from a camera, with the visualized world rendered behind it.',
  messageTypes: ['sensor_msgs/msg/Image'],
};

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
  private layer = 0;
  private readonly visProps = new Map<Display, BoolPropertyImpl>();
  private savedVisibility: Record<string, boolean> = {};

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
    CameraPanel.closeHandlers.set(this.panelId, (byUser) => {
      this.panelOpen = false;
      if (byUser && this.enabled()) this.setEnabled(false);
    });
  }

  protected override onInitialize() {
    this.layer = allocLayer();
    this.camera.layers.set(this.layer);
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
    this.setStatus('ok', 'Image', `${d.width} x ${d.height} ${d.encoding}`);
    CameraPanel.get(this.panelId)?.setImage(d);
  }

  // --- visibility list -----------------------------------------------------

  private syncVisibility() {
    const displays = this.context?.rootDisplays() ?? [];
    for (const [d, p] of [...this.visProps]) {
      if (!displays.includes(d)) {
        this.visibility.removeChild(p);
        this.visProps.delete(d);
      }
    }
    for (const d of displays) {
      if (d === this || this.visProps.has(d)) continue;
      const p = new BoolPropertyImpl(d.name(), this.savedVisibility[d.name()] ?? true, this.visibility, { description: `Show "${d.name()}" in this camera view.` });
      this.visProps.set(d, p);
    }
  }

  // --- rendering -----------------------------------------------------------

  override update() {
    if (!this.panelOpen) this.ensurePanel();
    this.syncVisibility();
  }

  /** Called by the main render loop after the 3D view (ExtraView). */
  render() {
    const panel = CameraPanel.get(this.panelId);
    const ctx = this.context;
    if (!panel || !ctx || !this.enabled()) return;
    const frame = this.infoFrame || this.imageFrame;
    if (!frame) return;
    if (!ctx.tf.lookup(frame, tmpM, this.camera.position, tmpQ)) {
      this.setStatus('error', 'Transform', `No transform from [${frame}] to [${ctx.fixedFrame()}]`);
      return;
    }
    this.setStatus('ok', 'Transform', 'Transform OK');
    // ROS optical frame (z forward, y down) → three camera (-z forward, y up): 180° about x.
    this.camera.quaternion.copy(tmpQ).multiply(OPTICAL_TO_CAMERA);
    this.camera.updateMatrixWorld();
    const info = this.info;
    const imageSize = panel.imageSize();
    const w = info?.width || imageSize.width || 640;
    const h = info?.height || imageSize.height || 480;
    // camera_display.cpp uses the projection matrix P (binning and ROI are ignored).
    const fx = info?.p[0] || w;
    const fy = info?.p[5] || fx;
    const cx = info?.p[2] || w / 2;
    const cy = info?.p[6] || h / 2;
    if (info && ![fx, fy, cx, cy].every(Number.isFinite)) {
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
    const size = panel.imageSize();
    let zx = this.zoomFactor.value();
    let zy = zx;
    const panelAspect = size.width && size.height ? size.width / size.height : w / h;
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
    // Visibility: enable this view's layer bit on the chosen displays only.
    for (const d of ctx.rootDisplays()) {
      const on = d !== this && (this.visProps.get(d)?.value() ?? true);
      d.sceneNode.traverse((o) => (on ? o.layers.enable(this.layer) : o.layers.disable(this.layer)));
    }
    const mode = this.imageRendering.value();
    const rendering: ImageRendering = mode === 'background' ? 'background' : mode === 'overlay' ? 'overlay' : 'both';
    panel.render(ctx.scene, this.camera, rendering, this.overlayAlpha.value());
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
    if (this.layer) {
      for (const d of this.context?.rootDisplays() ?? []) d.sceneNode.traverse((o) => o.layers.disable(this.layer));
      releaseLayer(this.layer);
      this.layer = 0;
    }
    super.dispose();
  }
}

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();
const OPTICAL_TO_CAMERA = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
