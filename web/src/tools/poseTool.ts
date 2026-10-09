/**
 * rviz_default_plugins::tools::PoseTool: press to set the position (projected
 * onto the fixed frame's z = 0 plane), drag to set the yaw, release to publish.
 * A click without a drag does nothing, as in rviz.
 */

import * as THREE from 'three/webgpu';
import { ToolBase } from './Tool';
import type { ViewportPointerEvent } from '../views/types';
import { Arrow } from '../render/primitives';

export abstract class PoseToolBase extends ToolBase {
  private state: 'idle' | 'position' | 'orientation' = 'idle';
  private readonly pos = new THREE.Vector3();
  private readonly cur = new THREE.Vector3();
  private angle = 0;
  private arrow: Arrow | null = null;

  /** Called with the pose in the fixed frame once the user releases the mouse. */
  protected abstract onPoseSet(x: number, y: number, yaw: number): void;

  override activate() {
    this.state = 'idle';
    const vp = this.ctx?.viewport();
    if (!vp) return;
    if (!this.arrow) {
      // rviz PoseTool arrow: shaft 2 m / 0.2, head 0.5 / 0.35, green, invisible until the drag starts.
      this.arrow = new Arrow(0x00ff00, 2, 0.2, 0.5, 0.35);
      this.arrow.userData.noPick = true;
    }
    this.arrow.visible = false;
    vp.helpers.add(this.arrow);
    vp.setCursor('crosshair');
    vp.setStatus(`Click and drag mouse to set ${this.poseLabel()}.`);
  }

  override deactivate() {
    this.state = 'idle';
    this.arrow?.removeFromParent();
    const vp = this.ctx?.viewport();
    vp?.setCursor('default');
    vp?.setStatus('');
  }

  /** Text for the status bar ("position/orientation" in rviz). */
  protected poseLabel(): string {
    return 'position/orientation';
  }

  override handleMouse(e: ViewportPointerEvent) {
    const vp = this.ctx?.viewport();
    if (!vp || !this.arrow) return;
    if (e.type === 'down' && e.button === 0) {
      if (vp.groundPoint(e.x, e.y, this.pos)) this.state = 'position';
      return;
    }
    if (e.type === 'move' && (e.buttons & 1) && this.state !== 'idle') {
      if (!vp.groundPoint(e.x, e.y, this.cur)) return;
      this.angle = Math.atan2(this.cur.y - this.pos.y, this.cur.x - this.pos.x);
      this.arrow.position.copy(this.pos);
      this.arrow.quaternion.setFromAxisAngle(Z_AXIS, this.angle);
      this.arrow.visible = true;
      this.state = 'orientation';
      return;
    }
    if (e.type === 'up' && e.button === 0) {
      if (this.state === 'orientation') {
        this.onPoseSet(this.pos.x, this.pos.y, this.angle);
        this.arrow.visible = false;
        this.state = 'idle';
        // rviz: flags |= Finished → the ToolManager reverts to the default tool.
        this.ctx?.revertToDefault();
      }
      this.state = 'idle';
    }
  }

  /** Quaternion for a yaw about Z, as rviz orientationAroundZAxis. */
  protected yawQuaternion(yaw: number) {
    return { x: 0, y: 0, z: Math.sin(yaw / 2), w: Math.cos(yaw / 2) };
  }
}

const Z_AXIS = new THREE.Vector3(0, 0, 1);
