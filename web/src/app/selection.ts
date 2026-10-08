/**
 * SelectionManager (rviz_common::SelectionManager, the panel-facing half):
 * holds what the Select tool picked and the property tree the Selection panel
 * shows. Picking itself (the render pass) is in render/picking.ts.
 */

import { createSignal, type Accessor } from 'solid-js';
import { GroupProperty } from '../property/Property';
import { ExpandedState } from '../property/PropertyTree';

export class SelectionManager {
  readonly treeRoot = new GroupProperty('Selection', null);
  readonly expanded = new ExpandedState();
  readonly count: Accessor<number>;
  protected readonly setCount: (n: number) => void;

  constructor() {
    [this.count, this.setCount] = createSignal(0);
  }

  clear() {
    for (const c of this.treeRoot.children().slice()) this.treeRoot.removeChild(c);
    this.setCount(0);
  }
}
