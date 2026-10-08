/** rviz_default_plugins/Axes (axes_display.cpp): an axis triad at the Reference Frame's origin. */

import * as THREE from 'three/webgpu';
import { DisplayBase } from './Display';
import { FIXED_FRAME_STRING, FloatPropertyImpl, TfFramePropertyImpl } from '../property/Property';
import { Axes } from '../render/primitives';
import type { DisplayClassInfo } from './types';

export const AXES_INFO: DisplayClassInfo = {
  classId: 'rviz_default_plugins/Axes',
  name: 'Axes',
  description: "Displays an axis at the Target Frame's origin.",
  messageTypes: [],
};

export class AxesDisplay extends DisplayBase {
  readonly referenceFrame: TfFramePropertyImpl;
  readonly length: FloatPropertyImpl;
  readonly radius: FloatPropertyImpl;
  private axes: Axes | null = null;

  constructor(fixedFrame: () => string = () => '') {
    super(AXES_INFO.classId, AXES_INFO.name, AXES_INFO.description);
    this.referenceFrame = new TfFramePropertyImpl('Reference Frame', FIXED_FRAME_STRING, this, fixedFrame, {
      description: 'The TF frame these axes will use for their origin.',
    });
    this.length = new FloatPropertyImpl('Length', 1.0, this, { description: 'Length of each axis, in meters.', min: 0.0001 });
    this.radius = new FloatPropertyImpl('Radius', 0.1, this, { description: 'Radius of each axis, in meters.', min: 0.0001 });
    const resize = () => this.axes?.set(this.length.value(), this.radius.value());
    this.length.onChange(resize);
    this.radius.onChange(resize);
  }

  protected override onInitialize() {
    this.axes = new Axes(this.length.value(), this.radius.value());
    this.sceneNode.add(this.axes);
  }

  override update() {
    if (!this.context || !this.axes) return;
    const frame = this.referenceFrame.frameId();
    if (this.referenceFrame.value() === FIXED_FRAME_STRING || frame === this.context.fixedFrame()) {
      this.sceneNode.position.set(0, 0, 0);
      this.sceneNode.quaternion.identity();
      this.axes.visible = true;
      this.setStatus('ok', 'Transform', 'Transform OK');
    } else if (this.context.tf.lookup(frame, tmpM, this.sceneNode.position, this.sceneNode.quaternion)) {
      this.axes.visible = true;
      this.setStatus('ok', 'Transform', 'Transform OK');
    } else {
      this.axes.visible = false;
      this.setStatus('error', 'Transform', `Could not transform from [${frame}] to Fixed Frame [${this.context.fixedFrame()}]`);
    }
  }

  override dispose() {
    this.axes?.dispose();
    super.dispose();
  }
}

const tmpM = new THREE.Matrix4();
