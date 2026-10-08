/**
 * rviz_default_plugins/Path (path_display.cpp): a ring buffer of nav_msgs/Path
 * messages drawn as lines, optionally with axes or arrows at each pose.
 * "Billboards" draws plain lines too (fat lines are not needed for a path).
 */

import * as THREE from 'three/webgpu';
import { MessageFilterDisplayBase } from './Display';
import { ColorPropertyImpl, EnumPropertyImpl, FloatPropertyImpl, IntPropertyImpl, VectorPropertyImpl } from '../property/Property';
import type { DisplayClassInfo } from './types';
import type { DataMessage } from '../worker/messages';
import type { PosesMsg } from '../worker/decoders';
import { InstancedArrows, InstancedAxes } from '../render/instanced';

export const PATH_INFO: DisplayClassInfo = {
  classId: 'rviz_default_plugins/Path',
  name: 'Path',
  description: 'Displays data from a nav_msgs::Path message as lines.',
  messageTypes: ['nav_msgs/msg/Path'],
};

class PathSlot {
  readonly line: THREE.Line;
  readonly axes = new InstancedAxes(4);
  readonly arrows = new InstancedArrows(0xff55ff, 4);
  data: PosesMsg | null = null;
  constructor(material: THREE.LineBasicMaterial) {
    this.line = new THREE.Line(new THREE.BufferGeometry(), material);
    this.line.frustumCulled = false;
  }
  dispose() {
    this.line.geometry.dispose();
    this.axes.dispose();
    this.arrows.dispose();
  }
}

export class PathDisplay extends MessageFilterDisplayBase<DataMessage> {
  readonly lineStyle: EnumPropertyImpl;
  readonly lineWidth: FloatPropertyImpl;
  readonly color: ColorPropertyImpl;
  readonly alpha: FloatPropertyImpl;
  readonly bufferLength: IntPropertyImpl;
  readonly offset: VectorPropertyImpl;
  readonly poseStyle: EnumPropertyImpl;
  readonly poseAxesLength: FloatPropertyImpl;
  readonly poseAxesRadius: FloatPropertyImpl;
  readonly poseArrowColor: ColorPropertyImpl;
  readonly poseArrowShaftLength: FloatPropertyImpl;
  readonly poseArrowHeadLength: FloatPropertyImpl;
  readonly poseArrowShaftDiameter: FloatPropertyImpl;
  readonly poseArrowHeadDiameter: FloatPropertyImpl;
  private readonly material = new THREE.LineBasicMaterial({ transparent: true });
  private slots: PathSlot[] = [];
  private next = 0;

  constructor() {
    super(PATH_INFO.classId, PATH_INFO.name, PATH_INFO.messageTypes, PATH_INFO.description);
    this.decoder = 'path';
    this.lineStyle = new EnumPropertyImpl('Line Style', 'Lines', ['Lines', 'Billboards'], this, { description: 'The rendering operation to use to draw the grid lines.' });
    // Unlike Grid, rviz's Path keeps Line Width as a sibling of Line Style (flat in the config).
    this.lineWidth = new FloatPropertyImpl('Line Width', 0.03, this, { description: 'The width, in meters, of each path line.  Only works with the \'Billboards\' style.', min: 0.001, hidden: true });
    this.color = new ColorPropertyImpl('Color', { r: 25, g: 255, b: 0 }, this, { description: 'Color to draw the path.' });
    this.alpha = new FloatPropertyImpl('Alpha', 1, this, { description: 'Amount of transparency to apply to the path.', min: 0, max: 1 });
    this.bufferLength = new IntPropertyImpl('Buffer Length', 1, this, { description: 'Number of paths to display.', min: 1 });
    this.offset = new VectorPropertyImpl('Offset', { x: 0, y: 0, z: 0 }, this, { description: 'Allows you to offset the path from the origin of the reference frame.  In meters.' });
    this.poseStyle = new EnumPropertyImpl('Pose Style', 'None', ['None', 'Axes', 'Arrows'], this, { description: 'Shape to display the pose as.' });
    this.poseAxesLength = new FloatPropertyImpl('Length', 0.3, this, { description: 'Length of the axes.', hidden: true });
    this.poseAxesRadius = new FloatPropertyImpl('Radius', 0.03, this, { description: 'Radius of the axes.', hidden: true });
    this.poseArrowColor = new ColorPropertyImpl('Pose Color', { r: 255, g: 85, b: 255 }, this, { description: 'Color to draw the poses.', hidden: true });
    this.poseArrowShaftLength = new FloatPropertyImpl('Shaft Length', 0.1, this, { description: 'Length of the arrow shaft.', hidden: true });
    this.poseArrowHeadLength = new FloatPropertyImpl('Head Length', 0.2, this, { description: 'Length of the arrow head.', hidden: true });
    this.poseArrowShaftDiameter = new FloatPropertyImpl('Shaft Diameter', 0.1, this, { description: 'Diameter of the arrow shaft.', hidden: true });
    this.poseArrowHeadDiameter = new FloatPropertyImpl('Head Diameter', 0.3, this, { description: 'Diameter of the arrow head.', hidden: true });

    this.lineStyle.onChange((v) => this.lineWidth.setHidden(v !== 'Billboards'));
    this.poseStyle.onChange(() => this.updatePoseStyle());
    this.color.onChange(() => this.updateMaterial());
    this.alpha.onChange(() => this.updateMaterial());
    this.bufferLength.onChange(() => this.resizeBuffer());
    this.offset.onChange(() => this.updateOffset());
    for (const p of [this.poseAxesLength, this.poseAxesRadius, this.poseArrowColor, this.poseArrowShaftLength, this.poseArrowHeadLength, this.poseArrowShaftDiameter, this.poseArrowHeadDiameter]) {
      p.onChange(() => this.redrawAll());
    }
  }

  protected override onInitialize() {
    this.updateMaterial();
    this.resizeBuffer();
    this.updatePoseStyle();
    this.updateOffset();
  }

  private updateMaterial() {
    const c = this.color.value();
    this.material.color.setRGB(c.r / 255, c.g / 255, c.b / 255, THREE.SRGBColorSpace);
    this.material.opacity = this.alpha.value();
  }

  private updateOffset() {
    const o = this.offset.value();
    this.sceneNode.position.set(o.x, o.y, o.z);
  }

  private updatePoseStyle() {
    const s = this.poseStyle.value();
    this.poseAxesLength.setHidden(s !== 'Axes');
    this.poseAxesRadius.setHidden(s !== 'Axes');
    for (const p of [this.poseArrowColor, this.poseArrowShaftLength, this.poseArrowHeadLength, this.poseArrowShaftDiameter, this.poseArrowHeadDiameter]) p.setHidden(s !== 'Arrows');
    this.redrawAll();
  }

  private resizeBuffer() {
    const n = this.bufferLength.value();
    while (this.slots.length > n) {
      const s = this.slots.pop()!;
      s.dispose();
      this.sceneNode.remove(s.line, s.axes, s.arrows);
    }
    while (this.slots.length < n) {
      const s = new PathSlot(this.material);
      this.sceneNode.add(s.line, s.axes, s.arrows);
      this.slots.push(s);
    }
    this.next %= Math.max(1, n);
  }

  private redrawAll() {
    for (const s of this.slots) this.drawSlot(s);
  }

  private drawSlot(s: PathSlot) {
    const d = s.data;
    const n = d?.count ?? 0;
    if (!d || n === 0) {
      s.line.visible = false;
      s.axes.visible = false;
      s.arrows.visible = false;
      return;
    }
    // Line: reuse the position attribute, grow ×2.
    let attr = s.line.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!attr || attr.count < n) {
      const cap = Math.max(n, (attr?.count ?? 0) * 2);
      s.line.geometry.dispose();
      s.line.geometry = new THREE.BufferGeometry();
      attr = new THREE.BufferAttribute(new Float32Array(cap * 3), 3);
      s.line.geometry.setAttribute('position', attr);
    }
    (attr.array as Float32Array).set(d.positions.subarray(0, n * 3));
    attr.addUpdateRange(0, n * 3);
    attr.needsUpdate = true;
    s.line.geometry.setDrawRange(0, n);
    s.line.visible = true;

    const style = this.poseStyle.value();
    s.axes.visible = style === 'Axes';
    s.arrows.visible = style === 'Arrows';
    if (style === 'Axes') {
      s.axes.set(n, d.positions, d.orientations, this.poseAxesLength.value(), this.poseAxesRadius.value());
    } else if (style === 'Arrows') {
      const c = this.poseArrowColor.value();
      s.arrows.setColor(c.r, c.g, c.b, this.alpha.value());
      s.arrows.set(n, d.positions, d.orientations, this.poseArrowShaftLength.value(), this.poseArrowShaftDiameter.value() / 2, this.poseArrowHeadLength.value(), this.poseArrowHeadDiameter.value() / 2);
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
    if (this.slots.length === 0) return;
    const slot = this.slots[this.next];
    this.next = (this.next + 1) % this.slots.length;
    slot.data = d;
    this.drawSlot(slot);
  }

  override reset() {
    super.reset();
    for (const s of this.slots) {
      s.data = null;
      this.drawSlot(s);
    }
  }

  override dispose() {
    for (const s of this.slots) s.dispose();
    this.material.dispose();
    super.dispose();
  }
}
