/**
 * Dock panel of an Image display: a 2D canvas showing the latest RGBA frame
 * (rviz ImageDisplay's render panel). The display pushes frames through
 * `ImagePanel.draw(id, msg)`; the panel is looked up by its dockview id.
 */

import type { GroupPanelPartInitParameters, IContentRenderer } from 'dockview';
import type { ImageMsg } from '../worker/decoders';
import { isLayoutRebuilding } from '../app/layout';

export class ImagePanel implements IContentRenderer {
  private static readonly byId = new Map<string, ImagePanel>();
  readonly element = document.createElement('div');
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private id = '';
  /** Invoked when the user closes the panel (the display disables itself, as in rviz). */
  /** Per-panel close handlers registered by the owning display. */
  static readonly closeHandlers = new Map<string, (byUser: boolean) => void>();

  constructor() {
    this.element.className = 'wrl-image-panel';
    this.canvas.width = 1;
    this.canvas.height = 1;
    this.element.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
  }

  init(params: GroupPanelPartInitParameters) {
    this.id = params.api.id;
    ImagePanel.byId.set(this.id, this);
  }

  static draw(id: string, msg: ImageMsg) {
    ImagePanel.byId.get(id)?.draw(msg);
  }

  draw(msg: ImageMsg) {
    if (this.canvas.width !== msg.width || this.canvas.height !== msg.height) {
      this.canvas.width = msg.width;
      this.canvas.height = msg.height;
    }
    // The buffer was transferred from the worker: wrap it, no copy.
    const data = new ImageData(new Uint8ClampedArray(msg.rgba.buffer as ArrayBuffer, msg.rgba.byteOffset, msg.width * msg.height * 4), msg.width, msg.height);
    this.ctx.putImageData(data, 0, 0);
  }

  dispose() {
    ImagePanel.byId.delete(this.id);
    ImagePanel.closeHandlers.get(this.id)?.(!isLayoutRebuilding());
  }
}
