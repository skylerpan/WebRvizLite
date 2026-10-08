/**
 * rviz_default_plugins/Select (selection_tool.cpp): rubber-band selection.
 * Left drag selects, Shift adds, Ctrl removes, Alt hands the mouse to the
 * camera, F focuses the camera on the selection.
 */

import * as THREE from 'three/webgpu';
import { ToolBase } from './Tool';
import type { ToolClassInfo } from './types';
import type { ViewportPointerEvent } from '../views/types';

export const SELECT_INFO: ToolClassInfo = {
  classId: 'rviz_default_plugins/Select',
  name: 'Select',
  description: 'Drag with the left button to select objects in the 3D scene. Hold the Alt key to change viewpoint as in the Move tool.',
  shortcut: 's',
};

export class SelectTool extends ToolBase {
  private dragging = false;
  private moved = false;
  private x0 = 0;
  private y0 = 0;

  constructor() {
    super(SELECT_INFO.classId, SELECT_INFO.shortcut);
  }

  override activate() {
    const vp = this.ctx?.viewport();
    vp?.setCursor('crosshair');
    vp?.setStatus('Click and drag to select objects on the screen.');
  }

  override deactivate() {
    const vp = this.ctx?.viewport();
    this.dragging = false;
    vp?.setSelectBox(null);
    vp?.setCursor('default');
    vp?.setStatus('');
  }

  override handleMouse(e: ViewportPointerEvent) {
    const ctx = this.ctx;
    const vp = ctx?.viewport();
    if (!ctx || !vp) return;
    if (e.alt) {
      // rviz: Alt turns the Select tool into the Move Camera tool.
      if (this.dragging) {
        this.dragging = false;
        vp.setSelectBox(null);
      }
      ctx.views.current().handleMouse(e);
      return;
    }
    if (e.type === 'down' && e.button === 0) {
      this.dragging = true;
      this.moved = false;
      this.x0 = e.x;
      this.y0 = e.y;
      vp.setSelectBox({ x: e.x, y: e.y, w: 0, h: 0 });
      return;
    }
    if (e.type === 'move' && this.dragging) {
      this.moved = true;
      vp.setSelectBox({ x: this.x0, y: this.y0, w: e.x - this.x0, h: e.y - this.y0 });
      return;
    }
    if (e.type === 'up' && e.button === 0 && this.dragging) {
      this.dragging = false;
      vp.setSelectBox(null);
      const x = Math.min(this.x0, e.x);
      const y = Math.min(this.y0, e.y);
      const w = this.moved ? Math.abs(e.x - this.x0) : 1;
      const h = this.moved ? Math.abs(e.y - this.y0) : 1;
      const mode = e.shift ? 'add' : e.ctrl ? 'remove' : 'replace';
      void vp.pick(x, y, Math.max(1, w), Math.max(1, h)).then((hits) => {
        ctx.selection.apply(hits, mode);
        const n = ctx.selection.count();
        vp.setStatus(n ? `${n} object${n === 1 ? '' : 's'} selected.` : 'Click and drag to select objects on the screen.');
      });
      return;
    }
    if (e.type === 'wheel') ctx.views.current().handleMouse(e);
  }

  override handleKey(key: string): boolean {
    if (key === 'f' || key === 'F') {
      const ctx = this.ctx;
      if (!ctx) return false;
      const box = new THREE.Box3();
      if (ctx.selection.bounds(box)) ctx.views.current().lookAt(box.getCenter(new THREE.Vector3()));
      return true;
    }
    return false;
  }
}
