/**
 * rviz_default_plugins/Grid (grid_display.cpp). Properties match RViz; the
 * grid is a LineSegments object positioned at the Reference Frame's pose.
 * "Billboards" style renders as plain lines too (line width is not supported
 * by WebGL/WebGPU core lines; fat lines are not worth it for a grid).
 */

import * as THREE from 'three/webgpu';
import { DisplayBase } from './Display';
import { ColorPropertyImpl, EnumPropertyImpl, FloatPropertyImpl, IntPropertyImpl, TfFramePropertyImpl, VectorPropertyImpl, FIXED_FRAME_STRING } from '../property/Property';
import type { DisplayClassInfo } from './types';
import { buildGridGeometry } from '../render/primitives';

export const GRID_INFO: DisplayClassInfo = {
  classId: 'rviz_default_plugins/Grid',
  name: 'Grid',
  description: 'Displays a grid along the ground plane, centered at the origin of the target frame of reference.',
  messageTypes: [],
};

export class GridDisplay extends DisplayBase {
  readonly referenceFrame: TfFramePropertyImpl;
  readonly planeCellCount: IntPropertyImpl;
  readonly normalCellCount: IntPropertyImpl;
  readonly cellSize: FloatPropertyImpl;
  readonly lineStyle: EnumPropertyImpl;
  readonly lineWidth: FloatPropertyImpl;
  readonly color: ColorPropertyImpl;
  readonly alpha: FloatPropertyImpl;
  readonly plane: EnumPropertyImpl;
  readonly offset: VectorPropertyImpl;
  private lines: THREE.LineSegments | null = null;
  private readonly material = new THREE.LineBasicMaterial({ transparent: true });
  private geometryDirty = true;

  constructor(fixedFrame: () => string = () => '') {
    super(GRID_INFO.classId, GRID_INFO.name, GRID_INFO.description);
    this.referenceFrame = new TfFramePropertyImpl('Reference Frame', FIXED_FRAME_STRING, this, fixedFrame, {
      description: 'The TF frame this grid will use for its origin.',
    });
    this.planeCellCount = new IntPropertyImpl('Plane Cell Count', 10, this, { description: 'The number of cells to draw in the plane of the grid.', min: 1 });
    this.normalCellCount = new IntPropertyImpl('Normal Cell Count', 0, this, {
      description: 'The number of cells to draw along the normal vector of the grid.  Setting to anything but 0 makes the grid 3D.',
      min: 0,
    });
    this.cellSize = new FloatPropertyImpl('Cell Size', 1.0, this, { description: 'The length, in meters, of the side of each cell.', min: 0.0001 });
    this.lineStyle = new EnumPropertyImpl('Line Style', 'Lines', ['Lines', 'Billboards'], this, { description: 'The rendering operation to use to draw the grid lines.' });
    this.lineWidth = new FloatPropertyImpl('Line Width', 0.03, this.lineStyle, { description: 'The width, in meters, of each grid line.', min: 0.001, hidden: true });
    this.color = new ColorPropertyImpl('Color', { r: 160, g: 160, b: 164 }, this, { description: 'The color of the grid lines.' });
    this.alpha = new FloatPropertyImpl('Alpha', 0.5, this, { description: 'The amount of transparency to apply to the grid lines.', min: 0, max: 1 });
    this.plane = new EnumPropertyImpl('Plane', 'XY', ['XY', 'XZ', 'YZ'], this, { description: 'The plane to draw the grid along.' });
    this.offset = new VectorPropertyImpl('Offset', { x: 0, y: 0, z: 0 }, this, {
      description: 'Allows you to offset the grid from the origin of the reference frame.  In meters.',
    });
    this.lineStyle.onChange((v) => this.lineWidth.setHidden(v !== 'Billboards'));
    for (const p of [this.planeCellCount, this.normalCellCount, this.cellSize, this.plane]) p.onChange(() => (this.geometryDirty = true));
    this.color.onChange(() => this.updateMaterial());
    this.alpha.onChange(() => this.updateMaterial());
  }

  protected override onInitialize() {
    this.updateMaterial();
  }

  private updateMaterial() {
    const c = this.color.value();
    this.material.color.setRGB(c.r / 255, c.g / 255, c.b / 255, THREE.SRGBColorSpace);
    this.material.opacity = this.alpha.value();
  }

  private rebuildGeometry() {
    this.lines?.geometry.dispose();
    this.lines?.removeFromParent();
    const geometry = buildGridGeometry(this.planeCellCount.value(), this.normalCellCount.value(), this.cellSize.value(), this.plane.value() as 'XY' | 'XZ' | 'YZ');
    this.lines = new THREE.LineSegments(geometry, this.material);
    this.sceneNode.add(this.lines);
    this.geometryDirty = false;
  }

  override update(_wallDt: number, _rosDt: number) {
    if (!this.context) return;
    if (this.geometryDirty) this.rebuildGeometry();
    const o = this.offset.value();
    const frame = this.referenceFrame.frameId();
    if (this.referenceFrame.value() === FIXED_FRAME_STRING || frame === this.context.fixedFrame()) {
      this.sceneNode.position.set(o.x, o.y, o.z);
      this.sceneNode.quaternion.identity();
      this.setStatus('ok', 'Transform', 'Transform OK');
      this.lines!.visible = true;
    } else if (this.context.tf.lookup(frame, tmpM, tmpPos, tmpQuat)) {
      this.sceneNode.quaternion.copy(tmpQuat);
      this.sceneNode.position.copy(tmpPos).add(tmpOff.set(o.x, o.y, o.z).applyQuaternion(tmpQuat));
      this.setStatus('ok', 'Transform', 'Transform OK');
      this.lines!.visible = true;
    } else {
      this.setStatus('error', 'Transform', `Could not transform from [${frame}] to Fixed Frame [${this.context.fixedFrame()}]`);
      this.lines!.visible = false;
    }
  }

  override dispose() {
    this.lines?.geometry.dispose();
    this.material.dispose();
    super.dispose();
  }
}

const tmpM = new THREE.Matrix4();
const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpOff = new THREE.Vector3();
