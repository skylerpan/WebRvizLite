/**
 * SelectionManager (rviz_common::SelectionManager, the panel-facing half):
 * holds what the Select tool picked, the property tree the Selection panel
 * shows, and the highlight boxes drawn around the selected objects. The pick
 * render pass itself is in render/picking.ts.
 */

import { createSignal, type Accessor } from 'solid-js';
import * as THREE from 'three/webgpu';
import { GroupProperty } from '../property/Property';
import type { Property } from '../property/types';
import { ExpandedState } from '../property/PropertyTree';
import type { PickHit } from '../render/picking';

export type SelectMode = 'replace' | 'add' | 'remove';

interface Selected {
  hit: PickHit;
  prop: Property;
  helper: THREE.Box3Helper | null;
}

const MAX_HIGHLIGHTS = 2000;
const HIGHLIGHT_COLOR = 0xffff00;

export class SelectionManager {
  readonly treeRoot = new GroupProperty('Selection', null);
  readonly expanded = new ExpandedState();
  readonly count: Accessor<number>;
  private readonly setCount: (n: number) => void;
  /** Highlight geometry; hidden from the pick pass. */
  readonly highlight = new THREE.Group();
  private readonly items = new Map<number, Selected>();

  constructor() {
    [this.count, this.setCount] = createSignal(0);
    this.highlight.name = 'selection highlight';
    this.highlight.userData.noPick = true;
  }

  private key(hit: PickHit) {
    return hit.pickId * 16_777_216 + hit.instance;
  }

  /** Applies a pick result (rviz: replace, Shift = add, Ctrl = remove). Hits without an owner are ignored. */
  apply(hits: PickHit[], mode: SelectMode) {
    if (mode === 'replace') this.clear();
    for (const hit of hits) {
      if (!hit.owner || !hit.pickId) continue;
      const k = this.key(hit);
      if (mode === 'remove') {
        this.removeKey(k);
        continue;
      }
      if (this.items.has(k)) continue;
      const prop = hit.owner.describeSelection(hit);
      if (!prop) continue;
      this.treeRoot.addChild(prop);
      let helper: THREE.Box3Helper | null = null;
      if (this.items.size < MAX_HIGHLIGHTS) {
        const box = new THREE.Box3();
        if (this.boundsOf(hit, box)) {
          helper = new THREE.Box3Helper(box, HIGHLIGHT_COLOR);
          (helper.material as THREE.LineBasicMaterial).depthTest = false;
          helper.renderOrder = 999;
          this.highlight.add(helper);
        }
      }
      this.items.set(k, { hit, prop, helper });
    }
    this.setCount(this.items.size);
  }

  private boundsOf(hit: PickHit, box: THREE.Box3): boolean {
    if (hit.owner?.selectionBounds?.(hit, box)) return true;
    box.setFromCenterAndSize(hit.worldPos, DEFAULT_SIZE);
    return true;
  }

  private removeKey(k: number) {
    const item = this.items.get(k);
    if (!item) return;
    this.treeRoot.removeChild(item.prop);
    if (item.helper) {
      item.helper.removeFromParent();
      item.helper.dispose();
    }
    this.items.delete(k);
  }

  clear() {
    for (const k of [...this.items.keys()]) this.removeKey(k);
    this.setCount(0);
  }

  /** Once per frame: live values (poses of moving markers, etc.). */
  update() {
    for (const item of this.items.values()) {
      item.hit.owner?.updateSelection?.(item.hit, item.prop);
      if (item.helper && item.hit.owner?.selectionBounds) item.hit.owner.selectionBounds(item.hit, item.helper.box);
    }
  }

  /** Union of the selected bounds (rviz focusOnSelection target); false when empty. */
  bounds(out: THREE.Box3): boolean {
    out.makeEmpty();
    const box = new THREE.Box3();
    for (const item of this.items.values()) if (this.boundsOf(item.hit, box)) out.union(box);
    return !out.isEmpty();
  }

  /** Forgets selections owned by a display that is going away. */
  dropOwner(owner: unknown) {
    for (const [k, item] of [...this.items]) if (item.hit.owner === owner) this.removeKey(k);
    this.setCount(this.items.size);
  }
}

const DEFAULT_SIZE = new THREE.Vector3(0.1, 0.1, 0.1);
