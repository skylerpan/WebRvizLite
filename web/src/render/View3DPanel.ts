import type { IContentRenderer } from 'dockview';
import { Viewport } from './Renderer';

/** The centre dock panel hosting the three.js canvas. */
export class View3DPanel implements IContentRenderer {
  readonly element = document.createElement('div');
  private viewport: Viewport | null = null;

  constructor() {
    this.element.className = 'wrl-view3d';
    this.element.tabIndex = 0; // keyboard focus target for tool shortcuts later
  }

  init() {
    this.viewport = new Viewport(this.element);
  }

  dispose() {
    this.viewport?.dispose();
    this.viewport = null;
  }
}
