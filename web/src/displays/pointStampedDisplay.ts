/** rviz_default_plugins/PointStamped (point_stamped_display.cpp): spheres for the last History Length points. */

import * as THREE from 'three/webgpu';
import { MessageFilterDisplayBase } from './Display';
import { ColorPropertyImpl, FloatPropertyImpl, IntPropertyImpl } from '../property/Property';
import type { DisplayClassInfo } from './types';
import type { DataMessage } from '../worker/messages';
import type { PosesMsg } from '../worker/decoders';
import { InstancedShapes } from '../render/instancedShapes';
import { UNIT_SPHERE } from '../render/primitives';
import { boxAround, roVector, selectionGroup } from './selectionInfo';
import type { PickHit } from '../render/picking';
import type { Property } from '../property/types';

export const POINT_STAMPED_INFO: DisplayClassInfo = {
  classId: 'rviz_default_plugins/PointStamped',
  name: 'PointStamped',
  description: 'Displays a geometry_msgs::PointStamped message as a sphere.',
  messageTypes: ['geometry_msgs/msg/PointStamped'],
};

export class PointStampedDisplay extends MessageFilterDisplayBase<DataMessage> {
  readonly color: ColorPropertyImpl;
  readonly alpha: FloatPropertyImpl;
  readonly radius: FloatPropertyImpl;
  readonly historyLength: IntPropertyImpl;
  private spheres: InstancedShapes | null = null;
  /** Oldest first, flat xyz. */
  private readonly points: number[] = [];

  constructor() {
    super(POINT_STAMPED_INFO.classId, POINT_STAMPED_INFO.name, POINT_STAMPED_INFO.messageTypes, POINT_STAMPED_INFO.description);
    this.decoder = 'point_stamped';
    this.color = new ColorPropertyImpl('Color', { r: 204, g: 41, b: 204 }, this, { description: 'Color of a point' });
    this.alpha = new FloatPropertyImpl('Alpha', 1, this, { description: '0 is fully transparent, 1.0 is fully opaque.', min: 0, max: 1 });
    this.radius = new FloatPropertyImpl('Radius', 0.2, this, { description: 'Radius of a point', min: 0 });
    this.historyLength = new IntPropertyImpl('History Length', 1, this, { description: 'Number of prior measurements to display.', min: 1, max: 100000 });
    for (const p of [this.color, this.alpha, this.radius]) p.onChange(() => this.redraw());
    this.historyLength.onChange(() => {
      this.trim();
      this.redraw();
    });
  }

  protected override onInitialize() {
    this.spheres = new InstancedShapes(UNIT_SPHERE);
    this.sceneNode.add(this.spheres);
    this.makePickable(this.spheres);
    this.redraw();
  }

  private trim() {
    while (this.points.length > this.historyLength.value() * 3) this.points.splice(0, 3);
  }

  private redraw() {
    if (!this.spheres) return;
    const c = this.color.value();
    const r = this.radius.value();
    const a = this.alpha.value() * 255;
    this.spheres.begin();
    for (let i = 0; i < this.points.length; i += 3) this.spheres.push(this.points[i], this.points[i + 1], this.points[i + 2], 0, 0, 0, 1, r, r, r, c.r, c.g, c.b, a);
    this.spheres.end();
  }

  processMessage(msg: DataMessage) {
    const d = msg.data as PosesMsg;
    if (!msg.inFixedFrame) {
      this.setStatus('error', 'Transform', msg.tfError ?? 'transform failed');
      return;
    }
    this.setStatus(msg.tfError ? 'warn' : 'ok', 'Transform', msg.tfError ?? 'Transform OK');
    if (!Number.isFinite(d.positions[0]) || !Number.isFinite(d.positions[1]) || !Number.isFinite(d.positions[2])) {
      this.setStatus('error', 'Topic', 'Message contained invalid floating point values (nans or infs)');
      return;
    }
    this.setStatus('ok', 'Topic', 'OK');
    this.points.push(d.positions[0], d.positions[1], d.positions[2]);
    this.trim();
    this.redraw();
  }

  override describeSelection(hit: PickHit): Property | null {
    const i = hit.instance * 3;
    if (i + 2 >= this.points.length) return null;
    const g = selectionGroup(`Point ${hit.instance} [${this.name()}]`);
    roVector(g, 'Position', { x: this.points[i], y: this.points[i + 1], z: this.points[i + 2] });
    return g;
  }
  override selectionBounds(hit: PickHit, out: THREE.Box3): boolean {
    const i = hit.instance * 3;
    if (i + 2 >= this.points.length) return false;
    return boxAround(out, { x: this.points[i], y: this.points[i + 1], z: this.points[i + 2] }, this.radius.value() * 2);
  }

  override reset() {
    super.reset();
    this.points.length = 0;
    this.redraw();
  }

  override dispose() {
    this.spheres?.dispose();
    super.dispose();
  }
}
