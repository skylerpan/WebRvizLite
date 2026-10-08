/** rviz_default_plugins/Polygon (polygon_display.cpp): a closed line through the polygon's vertices. */

import * as THREE from 'three/webgpu';
import { MessageFilterDisplayBase } from './Display';
import { ColorPropertyImpl, FloatPropertyImpl } from '../property/Property';
import type { DisplayClassInfo } from './types';
import type { DataMessage } from '../worker/messages';
import type { PointsMsg } from '../worker/decoders';

export const POLYGON_INFO: DisplayClassInfo = {
  classId: 'rviz_default_plugins/Polygon',
  name: 'Polygon',
  description: 'Displays data from a geometry_msgs::PolygonStamped message as lines.',
  messageTypes: ['geometry_msgs/msg/PolygonStamped'],
};

export class PolygonDisplay extends MessageFilterDisplayBase<DataMessage> {
  readonly color: ColorPropertyImpl;
  readonly alpha: FloatPropertyImpl;
  private readonly material = new THREE.LineBasicMaterial({ transparent: true });
  private line: THREE.Line | null = null;
  private capacity = 0;

  constructor() {
    super(POLYGON_INFO.classId, POLYGON_INFO.name, POLYGON_INFO.messageTypes, POLYGON_INFO.description);
    this.decoder = 'polygon';
    this.color = new ColorPropertyImpl('Color', { r: 25, g: 255, b: 0 }, this, { description: 'Color to draw the polygon.' });
    this.alpha = new FloatPropertyImpl('Alpha', 1, this, { description: 'Amount of transparency to apply to the polygon.', min: 0, max: 1 });
    this.color.onChange(() => this.updateMaterial());
    this.alpha.onChange(() => this.updateMaterial());
  }

  private updateMaterial() {
    const c = this.color.value();
    this.material.color.setRGB(c.r / 255, c.g / 255, c.b / 255, THREE.SRGBColorSpace);
    this.material.opacity = this.alpha.value();
    this.material.transparent = this.alpha.value() < 1;
  }

  protected override onInitialize() {
    // WebGPURenderer has no LineLoop: close the loop by repeating the first vertex.
    this.line = new THREE.Line(new THREE.BufferGeometry(), this.material);
    this.line.frustumCulled = false;
    this.line.visible = false;
    this.sceneNode.add(this.line);
    this.updateMaterial();
  }

  processMessage(msg: DataMessage) {
    const d = msg.data as PointsMsg;
    if (!msg.inFixedFrame) {
      this.setStatus('error', 'Transform', msg.tfError ?? 'transform failed');
      return;
    }
    this.setStatus(msg.tfError ? 'warn' : 'ok', 'Transform', msg.tfError ?? 'Transform OK');
    if (!this.line) return;
    if (!d.positions.every(Number.isFinite)) {
      this.setStatus('error', 'Topic', 'Message contained invalid floating point values (nans or infs)');
      return;
    }
    const n = d.count;
    this.setStatus('ok', 'Topic', `${n} points`);
    if (n === 0) {
      this.line.visible = false;
      return;
    }
    const needed = n + 1;
    if (needed > this.capacity) {
      this.capacity = Math.max(needed, this.capacity * 2, 16);
      this.line.geometry.dispose();
      this.line.geometry = new THREE.BufferGeometry();
      this.line.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.capacity * 3), 3));
    }
    const attr = this.line.geometry.getAttribute('position') as THREE.BufferAttribute;
    (attr.array as Float32Array).set(d.positions.subarray(0, n * 3));
    (attr.array as Float32Array).set(d.positions.subarray(0, 3), n * 3);
    attr.addUpdateRange(0, needed * 3);
    attr.needsUpdate = true;
    this.line.geometry.setDrawRange(0, needed);
    this.line.visible = true;
  }

  override reset() {
    super.reset();
    if (this.line) this.line.visible = false;
  }

  override dispose() {
    this.line?.geometry.dispose();
    this.material.dispose();
    super.dispose();
  }
}
