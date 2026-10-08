/**
 * rviz_default_plugins/FPS (fps_view_controller.cpp): first-person camera.
 * Left drag turns (yaw / pitch), middle or shift+left strafes in the camera
 * plane, right drag and the wheel move along the view direction.
 */

import * as THREE from 'three/webgpu';
import { FloatPropertyImpl, VectorPropertyImpl } from '../property/Property';
import { ViewControllerBase } from './ViewController';
import type { ViewClassInfo, ViewController, ViewportPointerEvent } from './types';

export const FPS_INFO: ViewClassInfo = {
  classId: 'rviz_default_plugins/FPS',
  name: 'FPS',
  description: 'First-person camera: look around and move through the scene.',
};

const PITCH_LIMIT = Math.PI / 2 - 0.001;

export class FpsViewController extends ViewControllerBase {
  readonly position: VectorPropertyImpl;
  readonly yaw: FloatPropertyImpl;
  readonly pitch: FloatPropertyImpl;

  constructor(fixedFrame: () => string, classId = FPS_INFO.classId) {
    super(classId, fixedFrame, 'perspective');
    this.position = new VectorPropertyImpl('Position', { x: 0, y: 0, z: 0 }, this, { description: 'Position of the camera.' });
    this.yaw = new FloatPropertyImpl('Yaw', 0, this, { description: 'Rotation of the camera around the Z (up) axis.' });
    this.pitch = new FloatPropertyImpl('Pitch', 0, this, { description: 'How much the camera is tipped downward.', min: -PITCH_LIMIT, max: PITCH_LIMIT });
    for (const p of [this.position, this.yaw, this.pitch]) p.onChange(() => this.updateCamera());
    // rviz constructs with zeros and reset() places the camera at (5, 5, 10) looking at the origin.
    this.reset();
  }

  protected updateCamera() {
    const p = this.position.value();
    const yaw = this.yaw.value();
    const pitch = this.pitch.value();
    const px = p.x + this.targetPosition.x;
    const py = p.y + this.targetPosition.y;
    const pz = p.z + this.targetPosition.z;
    this.camera.position.set(px, py, pz);
    this.camera.up.set(0, 0, this.invertZ.value() ? -1 : 1);
    this.camera.lookAt(px + Math.cos(yaw) * Math.cos(pitch), py + Math.sin(yaw) * Math.cos(pitch), pz + Math.sin(pitch));
  }

  handleMouse(e: ViewportPointerEvent) {
    if (e.type === 'wheel') {
      // Qt wheel delta is 120 per notch; rviz moves by -delta * 0.01 along the camera's -Z.
      this.move(0, 0, -e.wheel * 1.2);
      return;
    }
    if (e.type !== 'move') return;
    const left = (e.buttons & 1) !== 0;
    const right = (e.buttons & 2) !== 0;
    const middle = (e.buttons & 4) !== 0;
    if (left && !e.shift) {
      this.yaw.setValue(this.yaw.value() - e.dx * 0.005, 'user');
      this.pitch.setValue(this.pitch.value() - e.dy * 0.005, 'user');
    } else if (middle || (left && e.shift)) {
      this.move(e.dx * 0.01, -e.dy * 0.01, 0);
    } else if (right) {
      this.move(0, 0, e.dy * 0.1);
    }
  }

  /** Moves in camera coordinates (x right, y up, z backward), as rviz FPSViewController::move. */
  private move(x: number, y: number, z: number) {
    tmp.set(x, y, z).applyQuaternion(this.camera.quaternion);
    const p = this.position.value();
    this.position.setValue({ x: p.x + tmp.x, y: p.y + tmp.y, z: p.z + tmp.z }, 'user');
  }

  /** Yaw/pitch so the camera at its position looks at `point` (rviz setPropertiesFromCamera after lookAt). */
  private lookTowards(point: THREE.Vector3, source: 'user' | 'program') {
    const p = this.position.value();
    tmp.set(point.x - p.x - this.targetPosition.x, point.y - p.y - this.targetPosition.y, point.z - p.z - this.targetPosition.z);
    const len = tmp.length();
    if (len < 1e-9) return;
    this.yaw.setValue(Math.atan2(tmp.y, tmp.x), source);
    this.pitch.setValue(Math.asin(THREE.MathUtils.clamp(tmp.z / len, -1, 1)), source);
  }

  reset() {
    this.position.setValue({ x: 5, y: 5, z: 10 }, 'user');
    this.lookTowards(ORIGIN, 'user');
  }

  lookAt(point: THREE.Vector3) {
    this.lookTowards(point, 'user');
  }

  /** Copies the previous camera's pose (rviz FPS::mimic). */
  mimic(previous: ViewController) {
    const cam = previous.camera;
    this.position.setValue({ x: cam.position.x - this.targetPosition.x, y: cam.position.y - this.targetPosition.y, z: cam.position.z - this.targetPosition.z }, 'program');
    cam.getWorldDirection(tmp);
    this.yaw.setValue(Math.atan2(tmp.y, tmp.x), 'program');
    this.pitch.setValue(Math.asin(THREE.MathUtils.clamp(tmp.z, -1, 1)), 'program');
  }
}

const tmp = new THREE.Vector3();
const ORIGIN = new THREE.Vector3(0, 0, 0);
