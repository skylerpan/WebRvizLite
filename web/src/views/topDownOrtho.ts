/**
 * rviz_default_plugins/TopDownOrtho (fixed_orientation_ortho_view_controller.cpp):
 * orthographic camera looking straight down -Z from z = 500, rotated by Angle
 * about Z. Left drag rotates, middle / shift+left pans, right drag or wheel
 * changes Scale (pixels per meter).
 */

import * as THREE from 'three/webgpu';
import { FloatPropertyImpl } from '../property/Property';
import { ViewControllerBase } from './ViewController';
import type { ViewClassInfo, ViewController, ViewportPointerEvent } from './types';

export const TOP_DOWN_ORTHO_INFO: ViewClassInfo = {
  classId: 'rviz_default_plugins/TopDownOrtho',
  name: 'TopDownOrtho',
  description: 'Orthographic top-down view (fixed orientation).',
};

const CAMERA_HEIGHT = 500;

export class TopDownOrthoViewController extends ViewControllerBase {
  readonly scale: FloatPropertyImpl;
  readonly angle: FloatPropertyImpl;
  readonly x: FloatPropertyImpl;
  readonly y: FloatPropertyImpl;

  constructor(fixedFrame: () => string, classId = TOP_DOWN_ORTHO_INFO.classId) {
    super(classId, fixedFrame, 'orthographic');
    this.scale = new FloatPropertyImpl('Scale', 10, this, { description: 'How much of the scene is visible (pixels per meter).' });
    this.angle = new FloatPropertyImpl('Angle', 0, this, { description: 'Angle around the Z axis to rotate.' });
    this.x = new FloatPropertyImpl('X', 0, this, { description: 'X component of camera position.' });
    this.y = new FloatPropertyImpl('Y', 0, this, { description: 'Y component of camera position.' });
    for (const p of [this.scale, this.angle, this.x, this.y]) p.onChange(() => this.updateCamera());
  }

  protected override onViewportResized() {
    this.updateCamera();
  }

  protected updateCamera() {
    const cam = this.camera as THREE.OrthographicCamera;
    const s = this.scale.value();
    cam.left = -this.width / s / 2;
    cam.right = this.width / s / 2;
    cam.top = this.height / s / 2;
    cam.bottom = -this.height / s / 2;
    cam.far = CAMERA_HEIGHT * 2;
    cam.updateProjectionMatrix();
    const a = this.angle.value();
    const px = this.x.value() + this.targetPosition.x;
    const py = this.y.value() + this.targetPosition.y;
    const z = this.invertZ.value() ? -CAMERA_HEIGHT : CAMERA_HEIGHT;
    cam.position.set(px, py, z);
    // Ogre: camera orientation = rotation about Z by Angle, so the view's up is the rotated +Y.
    cam.up.set(-Math.sin(a), Math.cos(a), 0);
    cam.lookAt(px, py, 0);
  }

  handleMouse(e: ViewportPointerEvent) {
    if (e.type === 'wheel') {
      // Qt wheel delta is 120 per notch; rviz multiplies Scale by (1 + delta * 0.001).
      this.scale.setValue(this.scale.value() * (1 + e.wheel * 0.12), 'user');
      return;
    }
    if (e.type !== 'move') return;
    const left = (e.buttons & 1) !== 0;
    const right = (e.buttons & 2) !== 0;
    const middle = (e.buttons & 4) !== 0;
    if (left && !e.shift) {
      // fixed_orientation_ortho_view_controller.cpp: angle_property_->add(diff_x * 0.005)
      this.angle.setValue(this.angle.value() + e.dx * 0.005, 'user');
    } else if (middle || (left && e.shift)) {
      this.move(-e.dx / this.scale.value(), e.dy / this.scale.value());
    } else if (right) {
      this.scale.setValue(this.scale.value() * (1 - e.dy * 0.01), 'user');
    }
  }

  /** Moves in the rotated view plane (rviz FixedOrientationOrthoViewController::move). */
  private move(dx: number, dy: number) {
    const a = this.angle.value();
    const wx = dx * Math.cos(a) - dy * Math.sin(a);
    const wy = dx * Math.sin(a) + dy * Math.cos(a);
    this.x.setValue(this.x.value() + wx, 'user');
    this.y.setValue(this.y.value() + wy, 'user');
  }

  reset() {
    this.scale.setValue(10, 'user');
    this.angle.setValue(0, 'user');
    this.x.setValue(0, 'user');
    this.y.setValue(0, 'user');
  }

  lookAt(point: THREE.Vector3) {
    this.x.setValue(point.x - this.targetPosition.x, 'user');
    this.y.setValue(point.y - this.targetPosition.y, 'user');
  }

  /** rviz: copies Scale/Angle/X/Y from another TopDownOrtho; else the source's focal point, else its camera XY. */
  mimic(previous: ViewController) {
    if (previous instanceof TopDownOrthoViewController) {
      this.scale.setValue(previous.scale.value(), 'program');
      this.angle.setValue(previous.angle.value(), 'program');
      this.x.setValue(previous.x.value(), 'program');
      this.y.setValue(previous.y.value(), 'program');
      return;
    }
    const focal = (previous as { focalPoint?: { value(): { x: number; y: number } } }).focalPoint?.value();
    const p = focal ?? previous.camera.position;
    this.x.setValue(p.x, 'program');
    this.y.setValue(p.y, 'program');
  }
}
