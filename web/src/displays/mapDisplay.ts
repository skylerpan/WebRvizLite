/**
 * rviz_default_plugins/Map (map_display.cpp): an OccupancyGrid as a textured
 * quad, coloured through a 256-entry palette texture in the fragment shader
 * (TSL node material, works on both WebGPU and WebGL2 backends). The map
 * follows its frame every render (frame-locked), and `<topic>_updates`
 * patches are applied in place.
 */

import * as THREE from 'three/webgpu';
import { float, texture, uv, vec2 } from 'three/tsl';
import { RosTopicDisplayBase } from './Display';
import {
  BoolPropertyImpl, EnumPropertyImpl, FloatPropertyImpl, IntPropertyImpl, QuaternionPropertyImpl, RosTopicPropertyImpl, VectorPropertyImpl,
} from '../property/Property';
import type { DisplayClassInfo } from './types';
import type { DataMessage } from '../worker/messages';
import type { OccupancyGridMsg, OccupancyGridUpdateMsg } from '../worker/decoders';
import { binarize, makePalette, type ColorScheme } from '../render/mapPalette';

export const MAP_INFO: DisplayClassInfo = {
  classId: 'rviz_default_plugins/Map',
  name: 'Map',
  description: 'Displays an occupancy grid on the ground plane from a nav_msgs::msg::OccupancyGrid.  This display can also handle map_msgs::msg::OccupancyGridUpdate messages.',
  messageTypes: ['nav_msgs/msg/OccupancyGrid'],
};

export class MapDisplay extends RosTopicDisplayBase<DataMessage> {
  readonly updateTopic: RosTopicPropertyImpl;
  readonly alpha: FloatPropertyImpl;
  readonly colorScheme: EnumPropertyImpl;
  readonly drawBehind: BoolPropertyImpl;
  readonly resolution: FloatPropertyImpl;
  readonly width: IntPropertyImpl;
  readonly height: IntPropertyImpl;
  readonly position: VectorPropertyImpl;
  readonly orientation: QuaternionPropertyImpl;
  readonly useTimestamp: BoolPropertyImpl;
  readonly binaryView: BoolPropertyImpl;
  readonly binaryThreshold: IntPropertyImpl;

  private mesh: THREE.Mesh | null = null;
  private material: THREE.MeshBasicNodeMaterial | null = null;
  private gridTexture: THREE.DataTexture | null = null;
  private paletteTexture: THREE.DataTexture | null = null;
  private raw: Uint8Array | null = null; // last received cells (for binarize re-apply)
  private shown: Uint8Array | null = null; // cells uploaded to the texture
  private mapFrame = '';
  private mapOrigin: Float64Array | null = null;
  private updateSubscriptionId: number | null = null;
  private updateTopicAuto = true;

  constructor() {
    super(MAP_INFO.classId, MAP_INFO.name, MAP_INFO.messageTypes, MAP_INFO.description, { depth: 1 });
    this.decoder = 'occupancy_grid';
    // rviz: the map topic is transient local by default so late joiners get the latched map.
    this.topic.durability.setValue('Transient Local');
    this.updateTopic = new RosTopicPropertyImpl('Update Topic', '', ['map_msgs/msg/OccupancyGridUpdate'], this, {
      description: 'map_msgs::OccupancyGridUpdate topic to subscribe to.',
      depth: 1,
    });
    this.alpha = new FloatPropertyImpl('Alpha', 0.7, this, { description: 'Amount of transparency to apply to the map.', min: 0, max: 1 });
    this.colorScheme = new EnumPropertyImpl('Color Scheme', 'map', ['map', 'costmap', 'raw'], this, { description: 'How to color the occupancy values.' });
    this.drawBehind = new BoolPropertyImpl('Draw Behind', false, this, { description: 'Rendering option, controls whether or not the map is always drawn behind everything else.' });
    this.resolution = new FloatPropertyImpl('Resolution', 0, this, { description: 'Resolution of the map. (not editable)', readOnly: true });
    this.width = new IntPropertyImpl('Width', 0, this, { description: 'Width of the map, in meters. (not editable)', readOnly: true });
    this.height = new IntPropertyImpl('Height', 0, this, { description: 'Height of the map, in meters. (not editable)', readOnly: true });
    this.position = new VectorPropertyImpl('Position', { x: 0, y: 0, z: 0 }, this, { description: 'Position of the bottom left corner of the map, in meters. (not editable)', readOnly: true });
    this.orientation = new QuaternionPropertyImpl('Orientation', { x: 0, y: 0, z: 0, w: 1 }, this, { description: 'Orientation of the map. (not editable)', readOnly: true });
    this.useTimestamp = new BoolPropertyImpl('Use Timestamp', false, this, { description: 'Use map header timestamp when transforming' });
    this.binaryView = new BoolPropertyImpl('Binary representation', false, this, { description: 'Enables the binary representation of the map' });
    this.binaryThreshold = new IntPropertyImpl('Binary threshold', 100, this, { description: 'Threshold for the binary representation', min: 0, max: 100 });

    this.topic.onChange((t) => {
      if (this.updateTopicAuto) this.updateTopic.setValue(t ? `${t}_updates` : '', 'program');
      this.resubscribeUpdates();
    });
    this.updateTopic.onChange((_v, source) => {
      if (source === 'user' || source === 'config') this.updateTopicAuto = false;
      this.resubscribeUpdates();
    });
    this.alpha.onChange(() => this.updateMaterial());
    this.colorScheme.onChange(() => this.updatePalette());
    this.drawBehind.onChange(() => this.updateMaterial());
    this.binaryView.onChange(() => this.uploadCells());
    this.binaryThreshold.onChange(() => this.uploadCells());
  }

  protected override onInitialize() {
    this.paletteTexture = new THREE.DataTexture(makePalette('map'), 256, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.paletteTexture.colorSpace = THREE.SRGBColorSpace;
    this.paletteTexture.magFilter = THREE.NearestFilter;
    this.paletteTexture.minFilter = THREE.NearestFilter;
    this.paletteTexture.needsUpdate = true;
    this.updateMaterial();
  }

  override onEnable() {
    super.onEnable();
    this.resubscribeUpdates();
  }

  override onDisable() {
    super.onDisable();
    this.unsubscribeUpdates();
  }

  private resubscribeUpdates() {
    this.unsubscribeUpdates();
    if (!this.context || !this.enabled() || !this.updateTopic.value()) return;
    this.updateSubscriptionId = this.context.bridge.subscribe(
      this.updateTopic.value(), 'map_msgs/msg/OccupancyGridUpdate', this.updateTopic.qos(), 'occupancy_grid_update',
      (m) => this.processUpdate(m),
      undefined,
      // Nav2 sends most costmap changes only on this topic (always_send_full_costmap
      // is false by default), so a failed subscription must be visible, not just logged.
      (message) => this.setStatus('error', 'Update Topic', message),
    );
    this.setStatus('ok', 'Update Topic', 'OK');
  }

  private unsubscribeUpdates() {
    if (this.updateSubscriptionId !== null && this.context) {
      this.context.bridge.unsubscribe(this.updateSubscriptionId);
      this.updateSubscriptionId = null;
      this.deleteStatus('Update Topic');
      this.deleteStatus('Update');
    }
  }

  private updatePalette() {
    if (!this.paletteTexture) return;
    (this.paletteTexture.image.data as Uint8Array).set(makePalette(this.colorScheme.value() as ColorScheme));
    this.paletteTexture.needsUpdate = true;
  }

  private updateMaterial() {
    if (!this.paletteTexture) return;
    if (!this.material) {
      this.material = new THREE.MeshBasicNodeMaterial({ transparent: true, side: THREE.DoubleSide, depthWrite: false });
    }
    if (this.gridTexture) {
      // index = cell value / 255 → palette column (sampled at texel centres)
      const index = texture(this.gridTexture, uv()).r;
      const column = index.mul(255 / 256).add(0.5 / 256);
      const color = texture(this.paletteTexture, vec2(column, float(0.5)));
      this.material.colorNode = color.rgb;
      this.material.opacityNode = color.a.mul(float(this.alpha.value()));
      this.material.needsUpdate = true;
    }
    this.material.depthTest = !this.drawBehind.value();
    if (this.mesh) this.mesh.renderOrder = this.drawBehind.value() ? -1000 : 0;
  }

  private ensureTexture(width: number, height: number) {
    if (this.gridTexture && this.gridTexture.image.width === width && this.gridTexture.image.height === height) return;
    this.gridTexture?.dispose();
    this.shown = new Uint8Array(width * height);
    this.gridTexture = new THREE.DataTexture(this.shown, width, height, THREE.RedFormat, THREE.UnsignedByteType);
    this.gridTexture.magFilter = THREE.NearestFilter;
    this.gridTexture.minFilter = THREE.NearestFilter;
    this.gridTexture.flipY = false;
    if (!this.mesh) {
      this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material!);
      // PlaneGeometry is centred; move its origin to the bottom-left corner (cell 0,0).
      this.mesh.geometry.translate(0.5, 0.5, 0);
      this.sceneNode.add(this.mesh);
    }
    this.updateMaterial();
  }

  /** Copies raw → shown (binarized if enabled) and uploads. */
  private uploadCells() {
    if (!this.raw || !this.shown || !this.gridTexture) return;
    if (this.binaryView.value()) binarize(this.raw, this.binaryThreshold.value(), this.shown);
    else this.shown.set(this.raw);
    this.gridTexture.needsUpdate = true;
  }

  processMessage(msg: DataMessage) {
    const g = msg.data as OccupancyGridMsg;
    if (g.width === 0 || g.height === 0) {
      this.setStatus('warn', 'Map', 'Map is zero-sized');
      return;
    }
    if (![...g.origin].every(Number.isFinite) || !Number.isFinite(g.resolution)) {
      this.setStatus('error', 'Map', 'Message contained invalid floating point values (nans or infs)');
      return;
    }
    this.mapFrame = msg.frameId;
    this.mapOrigin = g.origin;
    this.ensureTexture(g.width, g.height);
    this.raw = g.data;
    this.uploadCells();
    this.mesh!.scale.set(g.width * g.resolution, g.height * g.resolution, 1);
    this.resolution.setValue(g.resolution);
    this.width.setValue(g.width);
    this.height.setValue(g.height);
    this.position.setValue({ x: g.origin[0], y: g.origin[1], z: g.origin[2] });
    this.orientation.setValue({ x: g.origin[3], y: g.origin[4], z: g.origin[5], w: g.origin[6] });
    this.setStatus('ok', 'Message', `Received map ${g.width} x ${g.height}`);
  }

  private processUpdate(msg: DataMessage) {
    const u = msg.data as OccupancyGridUpdateMsg;
    if (!this.raw || !this.gridTexture) return;
    const W = this.gridTexture.image.width;
    const H = this.gridTexture.image.height;
    if (u.x < 0 || u.y < 0 || u.x + u.width > W || u.y + u.height > H) {
      this.setStatus('error', 'Update', `Update area outside of original map area`);
      return;
    }
    for (let row = 0; row < u.height; row++) {
      this.raw.set(u.data.subarray(row * u.width, (row + 1) * u.width), (u.y + row) * W + u.x);
    }
    this.uploadCells();
    this.setStatus('ok', 'Update', `Received update ${u.width} x ${u.height} at (${u.x}, ${u.y})`);
  }

  override update() {
    if (!this.context || !this.mesh || !this.mapOrigin) return;
    const fixed = this.context.fixedFrame();
    const o = this.mapOrigin;
    tmpOriginPos.set(o[0], o[1], o[2]);
    tmpOriginQuat.set(o[3], o[4], o[5], o[6]);
    if (this.mapFrame === fixed) {
      this.sceneNode.position.copy(tmpOriginPos);
      this.sceneNode.quaternion.copy(tmpOriginQuat);
      this.mesh.visible = true;
      this.setStatus('ok', 'Transform', 'Transform OK');
    } else if (this.context.tf.lookup(this.mapFrame, tmpM, tmpPos, tmpQuat)) {
      this.sceneNode.quaternion.copy(tmpQuat).multiply(tmpOriginQuat);
      this.sceneNode.position.copy(tmpPos).add(tmpOriginPos.applyQuaternion(tmpQuat));
      this.mesh.visible = true;
      this.setStatus('ok', 'Transform', 'Transform OK');
    } else {
      this.mesh.visible = false;
      this.setStatus('error', 'Transform', `Could not transform map from [${this.mapFrame}] to Fixed Frame [${fixed}]`);
    }
  }

  override reset() {
    super.reset();
    if (this.mesh) this.mesh.visible = false;
    this.raw = null;
    this.mapOrigin = null;
  }

  override dispose() {
    this.unsubscribeUpdates();
    this.gridTexture?.dispose();
    this.paletteTexture?.dispose();
    this.material?.dispose();
    this.mesh?.geometry.dispose();
    super.dispose();
  }
}

const tmpM = new THREE.Matrix4();
const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpOriginPos = new THREE.Vector3();
const tmpOriginQuat = new THREE.Quaternion();
