/** rviz_default_plugins/PoseArray (pose_array_display.cpp): instanced flat/3D arrows or axes. */

import { MessageFilterDisplayBase } from './Display';
import { ColorPropertyImpl, EnumPropertyImpl, FloatPropertyImpl } from '../property/Property';
import type { DisplayClassInfo } from './types';
import type { DataMessage } from '../worker/messages';
import type { PosesMsg } from '../worker/decoders';
import { FlatArrows, InstancedArrows, InstancedAxes } from '../render/instanced';
import { addPoseRows, boxAround, selectionGroup } from './selectionInfo';
import type { PickHit } from '../render/picking';
import type * as THREE from 'three/webgpu';
import type { Property } from '../property/types';


export const POSE_ARRAY_INFO: DisplayClassInfo = {
  classId: 'rviz_default_plugins/PoseArray',
  name: 'PoseArray',
  description: 'Displays a geometry_msgs/PoseArray message as a bunch of line-drawn arrows.',
  messageTypes: ['geometry_msgs/msg/PoseArray'],
};

export class PoseArrayDisplay extends MessageFilterDisplayBase<DataMessage> {
  readonly shape: EnumPropertyImpl;
  readonly color: ColorPropertyImpl;
  readonly alpha: FloatPropertyImpl;
  readonly arrowLength: FloatPropertyImpl;
  readonly headRadius: FloatPropertyImpl;
  readonly headLength: FloatPropertyImpl;
  readonly shaftRadius: FloatPropertyImpl;
  readonly shaftLength: FloatPropertyImpl;
  readonly axesLength: FloatPropertyImpl;
  readonly axesRadius: FloatPropertyImpl;
  private flat: FlatArrows | null = null;
  private arrows3d: InstancedArrows | null = null;
  private axes: InstancedAxes | null = null;
  private last: PosesMsg | null = null;

  constructor() {
    super(POSE_ARRAY_INFO.classId, POSE_ARRAY_INFO.name, POSE_ARRAY_INFO.messageTypes, POSE_ARRAY_INFO.description);
    this.shape = new EnumPropertyImpl('Shape', 'Arrow (Flat)', ['Arrow (Flat)', 'Arrow (3D)', 'Axes'], this, { description: 'Shape to display the pose as.' });
    this.color = new ColorPropertyImpl('Color', { r: 255, g: 25, b: 0 }, this, { description: 'Color to draw the arrows.' });
    this.alpha = new FloatPropertyImpl('Alpha', 1, this, { description: 'Amount of transparency to apply to the displayed poses.', min: 0, max: 1 });
    this.arrowLength = new FloatPropertyImpl('Arrow Length', 0.3, this, { description: 'Length of the arrows.', min: 0 });
    this.headRadius = new FloatPropertyImpl('Head Radius', 0.03, this, { description: 'Radius of the arrow\'s head, in meters.', hidden: true });
    this.headLength = new FloatPropertyImpl('Head Length', 0.07, this, { description: 'Length of the arrow\'s head, in meters.', hidden: true });
    this.shaftRadius = new FloatPropertyImpl('Shaft Radius', 0.01, this, { description: 'Radius of the arrow\'s shaft, in meters.', hidden: true });
    this.shaftLength = new FloatPropertyImpl('Shaft Length', 0.23, this, { description: 'Length of the arrow\'s shaft, in meters.', hidden: true });
    this.axesLength = new FloatPropertyImpl('Axes Length', 0.3, this, { description: 'Length of each axis, in meters.', hidden: true });
    this.axesRadius = new FloatPropertyImpl('Axes Radius', 0.01, this, { description: 'Radius of each axis, in meters.', hidden: true });
    this.shape.onChange(() => this.updateShape());
    for (const p of [this.color, this.alpha, this.arrowLength, this.headRadius, this.headLength, this.shaftRadius, this.shaftLength, this.axesLength, this.axesRadius]) {
      p.onChange(() => this.redraw());
    }
  }

  protected override onInitialize() {
    this.flat = new FlatArrows();
    this.arrows3d = new InstancedArrows();
    this.axes = new InstancedAxes();
    this.sceneNode.add(this.flat, this.arrows3d, this.axes);
    this.makePickable(this.sceneNode);
    this.updateShape();
  }

  override describeSelection(hit: PickHit): Property | null {
    const d = this.last;
    if (!d || hit.instance >= d.count) return null;
    const g = selectionGroup(`Pose ${hit.instance} [${this.name()}]`);
    addPoseRows(g, d.positions, d.orientations, hit.instance);
    return g;
  }
  override selectionBounds(hit: PickHit, out: THREE.Box3): boolean {
    const d = this.last;
    if (!d || hit.instance >= d.count) return false;
    const i = hit.instance;
    const s = this.shape.value();
    const len = s === 'Arrow (Flat)' ? this.arrowLength.value() : s === 'Arrow (3D)' ? this.shaftLength.value() + this.headLength.value() : this.axesLength.value();
    return boxAround(out, { x: d.positions[i * 3], y: d.positions[i * 3 + 1], z: d.positions[i * 3 + 2] }, len);
  }

  private updateShape() {
    const s = this.shape.value();
    const flat = s === 'Arrow (Flat)';
    const arrow3d = s === 'Arrow (3D)';
    this.arrowLength.setHidden(!flat);
    for (const p of [this.headRadius, this.headLength, this.shaftRadius, this.shaftLength]) p.setHidden(!arrow3d);
    this.axesLength.setHidden(s !== 'Axes');
    this.axesRadius.setHidden(s !== 'Axes');
    this.color.setHidden(s === 'Axes');
    this.redraw();
  }

  private redraw() {
    if (!this.flat || !this.arrows3d || !this.axes) return;
    const s = this.shape.value();
    const d = this.last;
    const n = d?.count ?? 0;
    const c = this.color.value();
    this.flat.visible = s === 'Arrow (Flat)';
    this.arrows3d.visible = s === 'Arrow (3D)';
    this.axes.visible = s === 'Axes';
    if (!d) {
      this.flat.set(0, EMPTY, EMPTY, 0, 0, 0);
      this.arrows3d.set(0, EMPTY, EMPTY, 0, 0, 0, 0);
      this.axes.set(0, EMPTY, EMPTY, 0, 0);
      return;
    }
    if (this.flat.visible) {
      this.flat.setColor(c.r, c.g, c.b, this.alpha.value());
      const len = this.arrowLength.value();
      this.flat.set(n, d.positions, d.orientations, len, len * 0.3, len * 0.2);
    } else if (this.arrows3d.visible) {
      this.arrows3d.setColor(c.r, c.g, c.b, this.alpha.value());
      this.arrows3d.set(n, d.positions, d.orientations, this.shaftLength.value(), this.shaftRadius.value(), this.headLength.value(), this.headRadius.value());
    } else {
      this.axes.setOpacity(this.alpha.value());
      this.axes.set(n, d.positions, d.orientations, this.axesLength.value(), this.axesRadius.value());
    }
  }

  processMessage(msg: DataMessage) {
    const d = msg.data as PosesMsg;
    if (!msg.inFixedFrame) {
      this.setStatus('error', 'Transform', msg.tfError ?? 'transform failed');
      return;
    }
    this.setStatus(msg.tfError ? 'warn' : 'ok', 'Transform', msg.tfError ?? 'Transform OK');
    for (let i = 0; i < d.positions.length; i++) {
      if (!Number.isFinite(d.positions[i])) {
        this.setStatus('error', 'Topic', 'Message contained invalid floating point values (nans or infs)');
        return;
      }
    }
    this.setStatus('ok', 'Topic', `${d.count} poses`);
    this.last = d;
    this.redraw();
  }

  override reset() {
    super.reset();
    this.last = null;
    this.redraw();
  }

  override dispose() {
    this.flat?.dispose();
    this.arrows3d?.dispose();
    this.axes?.dispose();
    super.dispose();
  }
}

const EMPTY = new Float32Array(0);
