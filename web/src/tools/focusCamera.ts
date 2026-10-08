/** rviz_default_plugins/FocusCamera (focus_tool.cpp): click a point, the camera looks at it, back to the default tool. */

import { ToolBase } from './Tool';
import type { ToolClassInfo } from './types';
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

  constructor() {
    super(FOCUS_CAMERA_INFO.classId, FOCUS_CAMERA_INFO.shortcut);
  }

  override activate() {
    const vp = this.ctx?.viewport();
    vp?.setCursor('crosshair');
    vp?.setStatus('Click on a point to focus the camera on it.');
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
    if (e.type === 'up' && e.button === 0) {
      // Allow a small drag so the click is not mistaken for a camera move.
      if (Math.abs(e.x - this.downX) > 3 || Math.abs(e.y - this.downY) > 3) return;
      void vp.pickPoint(e.x, e.y).then((hit) => {
        if (hit) ctx.views.current().lookAt(hit.worldPos);
        ctx.revertToDefault();
      });
      return;
    }
    if (e.type === 'wheel') ctx.views.current().handleMouse(e);
  }
}
