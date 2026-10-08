/** rviz_default_plugins/Pose (pose_display.cpp): one PoseStamped as an arrow or axes. */

import * as THREE from 'three/webgpu';
import { MessageFilterDisplayBase } from './Display';
import { ColorPropertyImpl, EnumPropertyImpl, FloatPropertyImpl } from '../property/Property';
import type { DisplayClassInfo } from './types';
import type { DataMessage } from '../worker/messages';
import type { PosesMsg } from '../worker/decoders';
import { Arrow, Axes } from '../render/primitives';
import { boxAround, roQuaternion, roVector, selectionGroup, setQuaternion, setVector } from './selectionInfo';
import type { PickHit } from '../render/picking';
import type { Property } from '../property/types';


export const POSE_INFO: DisplayClassInfo = {
  classId: 'rviz_default_plugins/Pose',
  name: 'Pose',
  description: 'Displays a geometry_msgs::PoseStamped message.',
  messageTypes: ['geometry_msgs/msg/PoseStamped'],
};

export class PoseDisplay extends MessageFilterDisplayBase<DataMessage> {
  readonly shape: EnumPropertyImpl;
  readonly color: ColorPropertyImpl;
  readonly alpha: FloatPropertyImpl;
  readonly shaftLength: FloatPropertyImpl;
  readonly shaftRadius: FloatPropertyImpl;
  readonly headLength: FloatPropertyImpl;
  readonly headRadius: FloatPropertyImpl;
  readonly axesLength: FloatPropertyImpl;
  readonly axesRadius: FloatPropertyImpl;
  private arrow: Arrow | null = null;
  private axes: Axes | null = null;
  private hasPose = false;

  constructor() {
    super(POSE_INFO.classId, POSE_INFO.name, POSE_INFO.messageTypes, POSE_INFO.description);
    this.shape = new EnumPropertyImpl('Shape', 'Arrow', ['Arrow', 'Axes'], this, { description: 'Shape to display the pose as.' });
    this.color = new ColorPropertyImpl('Color', { r: 255, g: 25, b: 0 }, this, { description: 'Color to draw the arrow.' });
    this.alpha = new FloatPropertyImpl('Alpha', 1, this, { description: 'Amount of transparency to apply to the arrow.', min: 0, max: 1 });
    this.shaftLength = new FloatPropertyImpl('Shaft Length', 1, this, { description: 'Length of the arrow\'s shaft, in meters.' });
    this.shaftRadius = new FloatPropertyImpl('Shaft Radius', 0.05, this, { description: 'Radius of the arrow\'s shaft, in meters.' });
    this.headLength = new FloatPropertyImpl('Head Length', 0.3, this, { description: 'Length of the arrow\'s head, in meters.' });
    this.headRadius = new FloatPropertyImpl('Head Radius', 0.1, this, { description: 'Radius of the arrow\'s head, in meters.' });
    this.axesLength = new FloatPropertyImpl('Axes Length', 1, this, { description: 'Length of each axis, in meters.', hidden: true });
    this.axesRadius = new FloatPropertyImpl('Axes Radius', 0.1, this, { description: 'Radius of each axis, in meters.', hidden: true });
    this.shape.onChange(() => this.updateShape());
    for (const p of [this.color, this.alpha, this.shaftLength, this.shaftRadius, this.headLength, this.headRadius, this.axesLength, this.axesRadius]) {
      p.onChange(() => this.updateGeometry());
    }
  }

  protected override onInitialize() {
    this.arrow = new Arrow();
    this.axes = new Axes();
    this.sceneNode.add(this.arrow, this.axes);
    this.makePickable(this.sceneNode);
    this.updateShape();
  }

  override describeSelection(_hit: PickHit): Property | null {
    if (!this.hasPose) return null;
    const g = selectionGroup(`Pose [${this.name()}]`);
    roVector(g, 'Position', this.sceneNode.position);
    roQuaternion(g, 'Orientation', this.sceneNode.quaternion);
    return g;
  }
  override updateSelection(_hit: PickHit, prop: Property) {
    setVector(prop.child('Position'), this.sceneNode.position);
    setQuaternion(prop.child('Orientation'), this.sceneNode.quaternion);
  }
  override selectionBounds(_hit: PickHit, out: THREE.Box3): boolean {
    const len = this.shape.value() === 'Arrow' ? this.shaftLength.value() + this.headLength.value() : this.axesLength.value();
    return boxAround(out, this.sceneNode.position, len);
  }

  private updateShape() {
    const arrow = this.shape.value() === 'Arrow';
    for (const p of [this.color, this.alpha, this.shaftLength, this.shaftRadius, this.headLength, this.headRadius]) p.setHidden(!arrow);
    this.axesLength.setHidden(arrow);
    this.axesRadius.setHidden(arrow);
    this.updateGeometry();
  }

  private updateGeometry() {
    if (!this.arrow || !this.axes) return;
    const arrow = this.shape.value() === 'Arrow';
    this.arrow.visible = arrow && this.hasPose;
    this.axes.visible = !arrow && this.hasPose;
    const c = this.color.value();
    this.arrow.setColor(c.r, c.g, c.b, this.alpha.value());
    this.arrow.set(this.shaftLength.value(), this.shaftRadius.value(), this.headLength.value(), this.headRadius.value());
    this.axes.set(this.axesLength.value(), this.axesRadius.value());
  }

  processMessage(msg: DataMessage) {
    const d = msg.data as PosesMsg;
    if (!msg.inFixedFrame) {
      this.setStatus('error', 'Transform', msg.tfError ?? 'transform failed');
      this.hasPose = false;
      this.updateGeometry();
      return;
    }
    this.setStatus(msg.tfError ? 'warn' : 'ok', 'Transform', msg.tfError ?? 'Transform OK');
    if (![...d.positions, ...d.orientations].every(Number.isFinite)) {
      this.setStatus('error', 'Pose', 'Message contains invalid floating point values (nans or infs)');
      return;
    }
    this.deleteStatus('Pose');
    tmpQuat.set(d.orientations[0], d.orientations[1], d.orientations[2], d.orientations[3]).normalize();
    this.sceneNode.position.set(d.positions[0], d.positions[1], d.positions[2]);
    this.sceneNode.quaternion.copy(tmpQuat);
    this.hasPose = true;
    this.updateGeometry();
  }

  override reset() {
    super.reset();
    this.hasPose = false;
    this.updateGeometry();
  }

  override dispose() {
    this.arrow?.dispose();
    this.axes?.dispose();
    super.dispose();
  }
}

const tmpQuat = new THREE.Quaternion();
