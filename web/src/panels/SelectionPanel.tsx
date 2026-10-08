import { Show, createSignal } from 'solid-js';
import type { PanelProps } from './solidPanel';
import { PropertyTree } from '../property/PropertyTree';
import type { Property } from '../property/types';
import { getApp } from '../app/store';

/** rviz_common/Selection: property tree of what the Select tool picked. */
export function SelectionPanel(_props: PanelProps) {
  const app = getApp();
  const sel = app.selection;
  const [selected, setSelected] = createSignal<Property | null>(null);
  const [splitterRatio, setSplitterRatio] = createSignal(0.5);

  return (
    <div class="wrl-displays">
      <Show when={sel.count() > 0} fallback={<div class="wrl-panel-placeholder" style={{ padding: '8px' }}>Nothing selected. Use the Select tool (s) in the 3D view.</div>}>
        <PropertyTree root={sel.treeRoot} expanded={sel.expanded} splitterRatio={splitterRatio} setSplitterRatio={setSplitterRatio} selected={selected} onSelect={setSelected} />
      </Show>
    </div>
  );
}
