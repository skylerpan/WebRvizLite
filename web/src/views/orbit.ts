/**
 * rviz_default_plugins/Orbit (orbit_view_controller.cpp): the camera orbits a
 * focal point; left drag rotates (dragging down raises the camera, as in rviz2),
 * middle / shift+left pans the focal point, right drag or wheel changes the
 * distance, shift+wheel moves the focal point along the view direction.
 */

import * as THREE from 'three/webgpu';
import { BoolPropertyImpl, FloatPropertyImpl, VectorPropertyImpl } from '../property/Property';
import { ViewControllerBase } from './ViewController';
import type { ViewClassInfo, ViewController, ViewportPointerEvent } from './types';

export const ORBIT_INFO: ViewClassInfo = {
  classId: 'rviz_default_plugins/Orbit',
  name: 'Orbit',
  description: 'Orbits around a focal point.',
};

const HALF_PI = Math.PI / 2;
const PITCH_LIMIT = HALF_PI - 0.001;

export class OrbitViewController extends ViewControllerBase {
  readonly distance: FloatPropertyImpl;
  readonly focalShapeSize: FloatPropertyImpl;
  readonly focalShapeFixedSize: BoolPropertyImpl;
  readonly yaw: FloatPropertyImpl;
  readonly pitch: FloatPropertyImpl;
  readonly focalPoint: VectorPropertyImpl;
  /** Small sphere drawn at the focal point while dragging (rviz draws it always). */
  readonly focalShape: THREE.Mesh;
  private dragging = false;

  constructor(fixedFrame: () => string, classId = ORBIT_INFO.classId) {
    super(classId, fixedFrame, 'perspective');
    this.distance = new FloatPropertyImpl('Distance', 10, this, { description: 'Distance from the focal point.', min: 0.001 });
    this.focalShapeSize = new FloatPropertyImpl('Focal Shape Size', 0.05, this, { description: 'Focal shape size.', min: 0.001 });
    this.focalShapeFixedSize = new BoolPropertyImpl('Focal Shape Fixed Size', true, this, { description: 'Focal shape size.' });
    this.yaw = new FloatPropertyImpl('Yaw', HALF_PI * 0.5, this, { description: 'Rotation of the camera around the Z (up) axis.' });
    this.pitch = new FloatPropertyImpl('Pitch', HALF_PI * 0.5, this, { description: 'How much the camera is tipped downward.', min: -PITCH_LIMIT, max: PITCH_LIMIT });
    this.focalPoint = new VectorPropertyImpl('Focal Point', { x: 0, y: 0, z: 0 }, this, { description: 'The center point which the camera orbits.' });
    this.focalShape = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffff00, transparent: true, opacity: 0.6 }));
    this.focalShape.visible = false;
    for (const p of [this.distance, this.yaw, this.pitch, this.focalPoint]) p.onChange(() => this.updateCamera());
  }

  protected updateCamera() {
    const d = this.distance.value();
    const yaw = this.yaw.value();
    const pitch = this.pitch.value();
    const f = this.focalPoint.value();
    const fx = f.x + this.targetPosition.x;
    const fy = f.y + this.targetPosition.y;
    const fz = f.z + this.targetPosition.z;
    this.camera.position.set(d * Math.cos(yaw) * Math.cos(pitch) + fx, d * Math.sin(yaw) * Math.cos(pitch) + fy, d * Math.sin(pitch) + fz);
    this.camera.up.set(0, 0, this.invertZ.value() ? -1 : 1);
    this.camera.lookAt(fx, fy, fz);
    this.focalShape.position.set(fx, fy, fz);
    const size = this.focalShapeFixedSize.value() ? this.focalShapeSize.value() * d * 0.1 : this.focalShapeSize.value();
    this.focalShape.scale.setScalar(size);
  }

  handleMouse(e: ViewportPointerEvent) {
    if (e.type === 'down') {
      this.dragging = true;
      this.focalShape.visible = true;
      return;
    }
    if (e.type === 'up' || e.type === 'leave') {
      this.dragging = false;
      this.focalShape.visible = false;
      if (e.type === 'leave') return;
    }
    if (e.type === 'wheel') {
      if (e.shift) this.moveAlongView(e.wheel * 0.1 * this.distance.value());
      else this.zoom(e.wheel * 0.1 * this.distance.value());
      return;
    }
    if (e.type !== 'move' || !this.dragging) return;
    const left = (e.buttons & 1) !== 0;
    const right = (e.buttons & 2) !== 0;
    const middle = (e.buttons & 4) !== 0;
    if (left && !e.shift) {
      this.yaw.setValue(this.yaw.value() - e.dx * 0.005, 'user');
      // rviz2: pitch(-dy * ROTATION_SPEED) -> pitch_property_->add(+dy * ROTATION_SPEED); dragging down raises the camera.
      this.pitch.setValue(this.pitch.value() + e.dy * 0.005, 'user');
    } else if (middle || (left && e.shift)) {
      const fovY = THREE.MathUtils.degToRad((this.camera as THREE.PerspectiveCamera).fov);
      const fovX = 2 * Math.atan(Math.tan(fovY / 2) * this.aspect);
      const d = this.distance.value();
      this.pan(-(e.dx / e.width) * d * Math.tan(fovX / 2) * 2, (e.dy / e.height) * d * Math.tan(fovY / 2) * 2);
    } else if (right) {
      this.zoom(-e.dy * 0.1 * (this.distance.value() / 10));
    }
  }

  /** Moves the focal point in the camera's local X/Y plane. */
  private pan(dx: number, dy: number) {
    tmpVec.set(dx, dy, 0).applyQuaternion(this.camera.quaternion);
    const f = this.focalPoint.value();
    this.focalPoint.setValue({ x: f.x + tmpVec.x, y: f.y + tmpVec.y, z: f.z + tmpVec.z }, 'user');
  }

  private moveAlongView(amount: number) {
    this.camera.getWorldDirection(tmpVec).multiplyScalar(amount);
    const f = this.focalPoint.value();
    this.focalPoint.setValue({ x: f.x + tmpVec.x, y: f.y + tmpVec.y, z: f.z + tmpVec.z }, 'user');
  }

  private zoom(amount: number) {
    this.distance.setValue(Math.max(0.01, this.distance.value() - amount), 'user');
  }

  reset() {
    this.distance.setValue(10, 'user');
    this.yaw.setValue(HALF_PI * 0.5, 'user');
    this.pitch.setValue(HALF_PI * 0.5, 'user');
    this.focalPoint.setValue({ x: 0, y: 0, z: 0 }, 'user');
    // rviz quirk: reset() sets Focal Shape Fixed Size to false.
    this.focalShapeFixedSize.setValue(false, 'user');
  }

  lookAt(point: THREE.Vector3) {
    tmpVec.copy(point).sub(this.targetPosition);
    this.focalPoint.setValue({ x: tmpVec.x, y: tmpVec.y, z: tmpVec.z }, 'user');
  }

  /**
   * Reconstructs distance/yaw/pitch from the previous controller's camera
   * (rviz Orbit::mimic: Distance is copied from another Orbit, otherwise it is
   * the camera's distance from the origin).
   */
  mimic(previous: ViewController) {
    const cam = previous.camera;
    const dir = new THREE.Vector3();
    cam.getWorldDirection(dir);
    const prevDistance = previous instanceof OrbitViewController ? previous.distance.value() : cam.position.length();
    const d = Math.max(0.01, prevDistance);
    this.distance.setValue(d, 'program');
    const focal = cam.position.clone().addScaledVector(dir, d);
    this.focalPoint.setValue({ x: focal.x, y: focal.y, z: focal.z }, 'program');
    const rel = cam.position.clone().sub(focal);
    this.pitch.setValue(Math.asin(THREE.MathUtils.clamp(rel.z / d, -1, 1)), 'program');
    this.yaw.setValue(Math.atan2(rel.y, rel.x), 'program');
  }
}

const tmpVec = new THREE.Vector3();
