/** rviz_default_plugins/Measure (measure_tool.cpp): click two points, the distance shows in the status bar. */

import * as THREE from 'three/webgpu';
import { ToolBase } from './Tool';
import { ColorPropertyImpl } from '../property/Property';
import type { ToolClassInfo } from './types';
import type { ViewportPointerEvent } from '../views/types';

export const MEASURE_INFO: ToolClassInfo = {
  classId: 'rviz_default_plugins/Measure',
  name: 'Measure',
  description: 'Measure the distance between two points.',
  shortcut: 'n',
};

export class MeasureTool extends ToolBase {
  readonly lineColor: ColorPropertyImpl;
  private readonly start = new THREE.Vector3();
  private readonly end = new THREE.Vector3();
  private lineStarted = false;
  private length = 0;
  private line: THREE.Line | null = null;
  private material: THREE.LineBasicMaterial | null = null;
  private downX = 0;
  private downY = 0;
  private lastHoverMs = 0;

  constructor() {
    super(MEASURE_INFO.classId, MEASURE_INFO.shortcut);
    // measure_tool.cpp: Qt::darkYellow.
    // measure_tool.cpp keeps this (copy-pasted) description verbatim.
    this.lineColor = new ColorPropertyImpl('Line color', { r: 128, g: 128, b: 0 }, this.properties, { description: 'The topic on which to publish points.' });
    this.lineColor.onChange(() => this.applyColor());
  }

  private applyColor() {
    const c = this.lineColor.value();
    this.material?.color.setRGB(c.r / 255, c.g / 255, c.b / 255, THREE.SRGBColorSpace);
  }

  override activate() {
    const vp = this.ctx?.viewport();
    if (!vp) return;
    if (!this.line) {
      this.material = new THREE.LineBasicMaterial({ depthTest: false });
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      this.line = new THREE.Line(geometry, this.material);
      this.line.renderOrder = 998;
      this.line.frustumCulled = false;
      this.line.userData.noPick = true;
      this.applyColor();
    }
    this.line.visible = false;
    vp.helpers.add(this.line);
    // measure_tool.cpp activate(): only resets the line; the status is set on mouse events.
    this.lineStarted = false;
    vp.setCursor('crosshair');
  }

  private status(): string {
    return `${this.length > 0 ? `[Length: ${this.length.toFixed(3)}m] ` : ''}Click on two points to measure their distance. Right-click to reset.`;
  }

  private setLine(end: THREE.Vector3) {
    if (!this.line) return;
    const attr = this.line.geometry.getAttribute('position') as THREE.BufferAttribute;
    attr.setXYZ(0, this.start.x, this.start.y, this.start.z);
    attr.setXYZ(1, end.x, end.y, end.z);
    attr.needsUpdate = true;
    this.line.visible = true;
    this.length = this.start.distanceTo(end);
  }

  override deactivate() {
    this.line?.removeFromParent();
    const vp = this.ctx?.viewport();
    vp?.setCursor('default');
    vp?.setStatus('');
  }

  override handleMouse(e: ViewportPointerEvent) {
    const ctx = this.ctx;
    const vp = ctx?.viewport();
    if (!ctx || !vp || !this.line) return;
    vp.setStatus(this.status());
    if (e.type === 'down') {
      this.downX = e.x;
      this.downY = e.y;
      return;
    }
    if (e.type === 'up' && e.button === 2) {
      // rviz: right-click hides the line; the measured length stays in the status.
      this.lineStarted = false;
      this.line.visible = false;
      return;
    }
    if (e.type === 'move' && !e.buttons && this.lineStarted) {
      // Live preview while choosing the second point (throttled picks).
      const now = performance.now();
      if (now - this.lastHoverMs < 50) return;
      this.lastHoverMs = now;
      void vp.pickPoint(e.x, e.y).then((hit) => {
        if (hit && this.lineStarted) {
          this.setLine(hit.worldPos);
          vp.setStatus(this.status());
        }
      });
      return;
    }
    if (e.type === 'up' && e.button === 0) {
      if (Math.abs(e.x - this.downX) > 3 || Math.abs(e.y - this.downY) > 3) return;
      void vp.pickPoint(e.x, e.y).then((hit) => {
        if (!hit || !this.line) return;
        if (!this.lineStarted) {
          this.start.copy(hit.worldPos);
          this.lineStarted = true;
        } else {
          this.end.copy(hit.worldPos);
          this.setLine(this.end);
          this.lineStarted = false;
        }
        vp.setStatus(this.status());
      });
      return;
    }
    if (e.type === 'wheel' || (e.type === 'move' && e.buttons)) ctx.views.current().handleMouse(e);
  }
}
