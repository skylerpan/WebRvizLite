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
  private state: 'start' | 'end' = 'start';
  private line: THREE.Line | null = null;
  private material: THREE.LineBasicMaterial | null = null;
  private downX = 0;
  private downY = 0;

  constructor() {
    super(MEASURE_INFO.classId, MEASURE_INFO.shortcut);
    // measure_tool.cpp: Qt::darkYellow.
    this.lineColor = new ColorPropertyImpl('Line color', { r: 128, g: 128, b: 0 }, this.properties, { description: 'The color of the measurement line.' });
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
    this.state = 'start';
    vp.setCursor('crosshair');
    vp.setStatus('Click on two points to measure their distance. Right-click to reset.');
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
    if (e.type === 'down') {
      this.downX = e.x;
      this.downY = e.y;
      return;
    }
    if (e.type === 'up' && e.button === 2) {
      this.state = 'start';
      this.line.visible = false;
      vp.setStatus('Click on two points to measure their distance. Right-click to reset.');
      return;
    }
    if (e.type === 'up' && e.button === 0) {
      if (Math.abs(e.x - this.downX) > 3 || Math.abs(e.y - this.downY) > 3) return;
      void vp.pickPoint(e.x, e.y).then((hit) => {
        if (!hit || !this.line) return;
        if (this.state === 'start') {
          this.start.copy(hit.worldPos);
          this.state = 'end';
          this.line.visible = false;
          vp.setStatus(`First point: ${fmt(this.start)}. Click on the second point.`);
        } else {
          this.end.copy(hit.worldPos);
          this.state = 'start';
          const attr = this.line.geometry.getAttribute('position') as THREE.BufferAttribute;
          attr.setXYZ(0, this.start.x, this.start.y, this.start.z);
          attr.setXYZ(1, this.end.x, this.end.y, this.end.z);
          attr.needsUpdate = true;
          this.line.visible = true;
          vp.setStatus(`[Length: ${this.start.distanceTo(this.end).toFixed(3)} m]  ${fmt(this.start)} → ${fmt(this.end)}`);
        }
      });
      return;
    }
    if (e.type === 'wheel' || (e.type === 'move' && e.buttons)) ctx.views.current().handleMouse(e);
  }
}

const fmt = (v: THREE.Vector3) => `(${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)})`;
