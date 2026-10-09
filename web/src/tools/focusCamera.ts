/** rviz_default_plugins/FocusCamera (focus_tool.cpp): click a point, the camera looks at it, back to the default tool. */

import * as THREE from 'three/webgpu';
import { ToolBase } from './Tool';
import { HOVER_INTERVAL_MS, type ToolClassInfo } from './types';
import type { ViewportPointerEvent } from '../views/types';

export const FOCUS_CAMERA_INFO: ToolClassInfo = {
  classId: 'rviz_default_plugins/FocusCamera',
  name: 'Focus Camera',
  description: 'Click on a point in the 3D view to make the camera look at it.',
  shortcut: 'c',
};

export class FocusCameraTool extends ToolBase {
  private downX = 0;
  private downY = 0;
  private lastHoverMs = 0;
  private hoverSeq = 0;
  private readonly ray = new THREE.Ray();

  constructor() {
    super(FOCUS_CAMERA_INFO.classId, FOCUS_CAMERA_INFO.shortcut);
  }

  override activate() {
    const vp = this.ctx?.viewport();
    vp?.setCursor('crosshair');
    vp?.setStatus('<b>Left-Click:</b> Look in this direction.');
  }

  override deactivate() {
    const vp = this.ctx?.viewport();
    vp?.setCursor('default');
    vp?.setStatus('');
  }

  override handleMouse(e: ViewportPointerEvent) {
    const ctx = this.ctx;
    const vp = ctx?.viewport();
    if (!ctx || !vp) return;
    if (e.type === 'down' && e.button === 0) {
      this.downX = e.x;
      this.downY = e.y;
      return;
    }
    if (e.type === 'move' && !e.buttons) {
      const now = performance.now();
      if (now - this.lastHoverMs < HOVER_INTERVAL_MS || vp.pickBusy()) return;
      this.lastHoverMs = now;
      const seq = ++this.hoverSeq;
      void vp.pickPoint(e.x, e.y).then((hit) => {
        if (seq !== this.hoverSeq) return;
        vp.setStatus(hit ? `<b>Left-Click:</b> Focus on this point. [${hit.worldPos.x.toFixed(3)},${hit.worldPos.y.toFixed(3)},${hit.worldPos.z.toFixed(3)}]` : '<b>Left-Click:</b> Look in this direction.');
      });
      return;
    }
    if (e.type === 'up' && e.button === 0) {
      // Allow a small drag so the click is not mistaken for a camera move.
      if (Math.abs(e.x - this.downX) > 3 || Math.abs(e.y - this.downY) > 3) return;
      void vp.pickPoint(e.x, e.y).then((hit) => {
        // focus_tool.cpp: without a hit, look at the point 1 m along the mouse ray.
        const target = hit ? hit.worldPos : vp.ray(e.x, e.y, this.ray).at(1, new THREE.Vector3());
        ctx.views.current().lookAt(target);
        ctx.revertToDefault();
      });
      return;
    }
    if (e.type === 'wheel') ctx.views.current().handleMouse(e);
  }
}
