/**
 * Turns DOM pointer/wheel/keyboard events on the 3D view into
 * ViewportPointerEvents for the active tool, with pointer capture so drags
 * continue outside the canvas (rviz RenderPanel semantics).
 */

import type { ViewportPointerEvent } from '../views/types';

export interface InputTarget {
  handleMouse(e: ViewportPointerEvent): void;
  /** Return true when consumed (prevents default). */
  handleKey(key: string, e: KeyboardEvent): boolean;
}

export class ViewportInput {
  private lastX = 0;
  private lastY = 0;
  private readonly off: Array<() => void> = [];

  constructor(private readonly el: HTMLElement, private readonly target: InputTarget) {
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (ev: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      el.addEventListener(type, fn, opts);
      this.off.push(() => el.removeEventListener(type, fn, opts));
    };
    on('pointerdown', (ev) => {
      el.focus();
      el.setPointerCapture(ev.pointerId);
      this.lastX = ev.clientX;
      this.lastY = ev.clientY;
      this.target.handleMouse(this.make('down', ev, 0, 0));
      ev.preventDefault();
    });
    on('pointermove', (ev) => {
      const dx = ev.clientX - this.lastX;
      const dy = ev.clientY - this.lastY;
      this.lastX = ev.clientX;
      this.lastY = ev.clientY;
      this.target.handleMouse(this.make('move', ev, dx, dy));
    });
    on('pointerup', (ev) => {
      if (el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId);
      this.target.handleMouse(this.make('up', ev, 0, 0));
    });
    on('pointerleave', (ev) => this.target.handleMouse(this.make('leave', ev, 0, 0)));
    on('contextmenu', (ev) => ev.preventDefault());
    on(
      'wheel',
      (ev) => {
        const notches = -Math.sign(ev.deltaY) * Math.max(1, Math.min(3, Math.abs(ev.deltaY) / 100));
        const rect = el.getBoundingClientRect();
        this.target.handleMouse({
          type: 'wheel', x: ev.clientX - rect.left, y: ev.clientY - rect.top, dx: 0, dy: 0,
          buttons: ev.buttons, button: -1, shift: ev.shiftKey, ctrl: ev.ctrlKey, alt: ev.altKey,
          wheel: notches, width: rect.width, height: rect.height,
        });
        ev.preventDefault();
      },
      { passive: false },
    );
    on('keydown', (ev) => {
      if (this.target.handleKey(ev.key, ev)) ev.preventDefault();
    });
  }

  private make(type: ViewportPointerEvent['type'], ev: PointerEvent, dx: number, dy: number): ViewportPointerEvent {
    const rect = this.el.getBoundingClientRect();
    return {
      type, x: ev.clientX - rect.left, y: ev.clientY - rect.top, dx, dy,
      buttons: ev.buttons, button: ev.button, shift: ev.shiftKey, ctrl: ev.ctrlKey, alt: ev.altKey,
      wheel: 0, width: rect.width, height: rect.height,
    };
  }

  dispose() {
    for (const f of this.off) f();
    this.off.length = 0;
  }
}
