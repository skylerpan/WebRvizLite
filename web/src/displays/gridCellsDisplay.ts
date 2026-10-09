/** rviz_default_plugins/GridCells (grid_cells_display.cpp): one flat square per cell. */

import { MessageFilterDisplayBase } from './Display';
import { ColorPropertyImpl, FloatPropertyImpl } from '../property/Property';
import type { DisplayClassInfo } from './types';
import type { DataMessage } from '../worker/messages';
import type { GridCellsMsg } from '../worker/decoders';
import { CloudBuffer, CloudObject } from '../render/pointCloud';

export const GRID_CELLS_INFO: DisplayClassInfo = {
  classId: 'rviz_default_plugins/GridCells',
  name: 'GridCells',
  description: 'Displays data from a nav_msgs::GridCells message as billboards.',
  messageTypes: ['nav_msgs/msg/GridCells'],
};

export class GridCellsDisplay extends MessageFilterDisplayBase<DataMessage> {
  readonly color: ColorPropertyImpl;
  readonly alpha: FloatPropertyImpl;
  private buffer: CloudBuffer | null = null;
  private cloud: CloudObject | null = null;
  private colors = new Uint8Array(0);
  private cellSize = 0.1;

  constructor() {
    super(GRID_CELLS_INFO.classId, GRID_CELLS_INFO.name, GRID_CELLS_INFO.messageTypes, GRID_CELLS_INFO.description);
    this.decoder = 'grid_cells';
    this.color = new ColorPropertyImpl('Color', { r: 25, g: 255, b: 0 }, this, { description: 'Color of the grid cells.' });
    this.alpha = new FloatPropertyImpl('Alpha', 1, this, { description: 'Amount of transparency to apply to the cells.', min: 0, max: 1 });
    this.color.onChange(() => this.recolor());
    this.alpha.onChange(() => this.cloud?.setStyle('Tiles', this.cellSize, 1, this.alpha.value()));
  }

  protected override onInitialize() {
    this.buffer = new CloudBuffer(256);
    this.cloud = new CloudObject(this.buffer);
    this.cloud.visible = false;
    this.sceneNode.add(this.cloud);
  }

  private recolor() {
    if (!this.buffer || !this.cloud) return;
    const c = this.color.value();
    const n = this.buffer.count;
    const arr = this.buffer.colors.array as Uint8Array;
    for (let i = 0; i < n; i++) {
      arr[i * 3] = c.r;
      arr[i * 3 + 1] = c.g;
      arr[i * 3 + 2] = c.b;
    }
    this.buffer.colors.addUpdateRange(0, n * 3);
    this.buffer.colors.needsUpdate = true;
  }

  processMessage(msg: DataMessage) {
    const d = msg.data as GridCellsMsg;
    if (!msg.inFixedFrame) {
      this.setStatus('error', 'Transform', msg.tfError ?? 'transform failed');
      return;
    }
    this.setStatus(msg.tfError ? 'warn' : 'ok', 'Transform', msg.tfError ?? 'Transform OK');
    if (!this.buffer || !this.cloud) return;
    if (!d.positions.every(Number.isFinite) || !Number.isFinite(d.cellWidth) || !Number.isFinite(d.cellHeight)) {
      this.setStatus('error', 'Topic', 'Message contained invalid floating point values (nans or infs)');
      return;
    }
    if (d.cellWidth === 0 || d.cellHeight === 0) this.setStatus('error', 'Topic', "One of the Cell's dimension is zero, cells will be invisible.");
    else if (d.count === 0) this.setStatus('warn', 'Topic', 'Message is empty: there are no cells to be shown.');
    else this.setStatus('ok', 'Topic', `${d.count} cells`);
    const c = this.color.value();
    if (this.colors.length < d.count * 3) this.colors = new Uint8Array(Math.max(d.count * 3, this.colors.length * 2));
    for (let i = 0; i < d.count; i++) {
      this.colors[i * 3] = c.r;
      this.colors[i * 3 + 1] = c.g;
      this.colors[i * 3 + 2] = c.b;
    }
    const realloc = this.buffer.set(d.count, d.positions, this.colors);
    // rviz draws cell_width × cell_height tiles in the XY plane; our tiles are square (max of the two).
    this.cellSize = Math.max(d.cellWidth, d.cellHeight);
    this.cloud.setStyle('Tiles', this.cellSize, 1, this.alpha.value());
    this.cloud.refresh(realloc);
    this.cloud.visible = d.count > 0;
  }

  override reset() {
    super.reset();
    if (this.cloud) this.cloud.visible = false;
  }

  override dispose() {
    this.cloud?.dispose();
    super.dispose();
  }
}
