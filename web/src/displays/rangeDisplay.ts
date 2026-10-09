/** rviz_default_plugins/Range (range_display.cpp): a cone from the sensor along +X for the last Buffer Length readings. */

import * as THREE from 'three/webgpu';
import { MessageFilterDisplayBase } from './Display';
import { ColorPropertyImpl, FloatPropertyImpl, IntPropertyImpl } from '../property/Property';
import type { DisplayClassInfo } from './types';
import type { DataMessage } from '../worker/messages';
import type { RangeMsg } from '../worker/decoders';
import { InstancedShapes } from '../render/instancedShapes';
import { UNIT_CONE_Z } from '../render/primitives';
import { boxAround, roString, roVector, selectionGroup } from './selectionInfo';
import type { PickHit } from '../render/picking';
import type { Property } from '../property/types';

export const RANGE_INFO: DisplayClassInfo = {
  classId: 'rviz_default_plugins/Range',
  name: 'Range',
  description: 'Displays the data from sensor_msgs::Range messages as cones.',
  messageTypes: ['sensor_msgs/msg/Range'],
};

export class RangeDisplay extends MessageFilterDisplayBase<DataMessage> {
  readonly color: ColorPropertyImpl;
  readonly alpha: FloatPropertyImpl;
  readonly bufferLength: IntPropertyImpl;
  private cones: InstancedShapes | null = null;
  private readonly history: RangeMsg[] = [];

  constructor() {
    super(RANGE_INFO.classId, RANGE_INFO.name, RANGE_INFO.messageTypes, RANGE_INFO.description);
    this.decoder = 'range';
    this.color = new ColorPropertyImpl('Color', { r: 255, g: 255, b: 255 }, this, { description: 'Color to draw the range.' });
    this.alpha = new FloatPropertyImpl('Alpha', 0.5, this, { description: 'Amount of transparency to apply to the range.' });
    this.bufferLength = new IntPropertyImpl('Buffer Length', 1, this, { description: 'Number of prior measurements to display.', min: 1 });
    for (const p of [this.color, this.alpha]) p.onChange(() => this.redraw());
    this.bufferLength.onChange(() => {
      this.trim();
      this.redraw();
      this.updateDecoderOptions();
    });
  }

  protected override onInitialize() {
    this.cones = new InstancedShapes(UNIT_CONE_Z);
    this.sceneNode.add(this.cones);
    this.makePickable(this.cones);
  }

  private trim() {
    while (this.history.length > this.bufferLength.value()) this.history.shift();
  }

  private redraw() {
    if (!this.cones) return;
    const c = this.color.value();
    const a = this.alpha.value() * 255;
    this.cones.begin();
    for (const d of this.history) {
      const range = displayedRange(d);
      if (range <= 0) continue;
      // UNIT_CONE_Z: base at z=0, tip at z=1. Put the tip at the sensor and open the cone along the sensor's +X:
      // local +Z → -X, placed `range` ahead of the sensor.
      tmpQ.set(d.orientations[0], d.orientations[1], d.orientations[2], d.orientations[3]);
      tmpPos.set(range, 0, 0).applyQuaternion(tmpQ);
      tmpPos.x += d.positions[0];
      tmpPos.y += d.positions[1];
      tmpPos.z += d.positions[2];
      tmpQ.multiply(Z_TO_NEG_X);
      const r = range * Math.tan(d.fieldOfView / 2);
      this.cones.push(tmpPos.x, tmpPos.y, tmpPos.z, tmpQ.x, tmpQ.y, tmpQ.z, tmpQ.w, r, r, range, c.r, c.g, c.b, a);
    }
    this.cones.end();
  }

  protected override latestOnly() {
    return this.bufferLength.value() === 1;
  }

  processMessage(msg: DataMessage) {
    const d = msg.data as RangeMsg;
    if (!msg.inFixedFrame) {
      this.setStatus('error', 'Transform', msg.tfError ?? 'transform failed');
      return;
    }
    this.setStatus(msg.tfError ? 'warn' : 'ok', 'Transform', msg.tfError ?? 'Transform OK');
    if (!Number.isFinite(d.fieldOfView) || ![...d.positions, ...d.orientations].every(Number.isFinite)) {
      this.setStatus('error', 'Topic', 'Message contained invalid floating point values (nans or infs)');
      return;
    }
    this.setStatus('ok', 'Topic', `range ${d.range.toFixed(3)} m`);
    this.history.push(d);
    this.trim();
    this.redraw();
  }

  override describeSelection(hit: PickHit): Property | null {
    const d = this.history[hit.instance];
    if (!d) return null;
    const g = selectionGroup(`Range ${hit.instance} [${this.name()}]`);
    roVector(g, 'Position', { x: d.positions[0], y: d.positions[1], z: d.positions[2] });
    roString(g, 'Range', `${d.range.toFixed(3)} m (fov ${d.fieldOfView.toFixed(3)} rad, min ${d.minRange}, max ${d.maxRange})`);
    return g;
  }
  override selectionBounds(hit: PickHit, out: THREE.Box3): boolean {
    const d = this.history[hit.instance];
    if (!d) return false;
    return boxAround(out, { x: d.positions[0], y: d.positions[1], z: d.positions[2] }, d.range * 2);
  }

  override reset() {
    super.reset();
    this.history.length = 0;
    this.redraw();
  }

  override dispose() {
    this.cones?.dispose();
    super.dispose();
  }
}

/**
 * range_display.cpp: show `range` when it is within [min, max]; a fixed-distance
 * ranger (min == max) reporting −inf shows min; anything else draws nothing.
 */
function displayedRange(d: RangeMsg): number {
  if (d.minRange <= d.range && d.range <= d.maxRange) return d.range;
  if (d.minRange === d.maxRange && d.range === -Infinity) return d.minRange;
  return 0;
}

const tmpQ = new THREE.Quaternion();
const tmpPos = new THREE.Vector3();
const Z_TO_NEG_X = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(-1, 0, 0));
