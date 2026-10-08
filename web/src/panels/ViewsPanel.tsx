import { For, Show, createSignal } from 'solid-js';
import type { PanelProps } from './solidPanel';
import { PropertyTree } from '../property/PropertyTree';
import type { Property } from '../property/types';
import { getApp } from '../app/store';

/**
 * rviz_common/Views: view type selector, Current View property tree, saved
 * views list (Tier 1) and the Save / Remove / Rename / Zero buttons.
 */
export function ViewsPanel(_props: PanelProps) {
  const app = getApp();
  const views = app.manager.views;
  const [selected, setSelected] = createSignal<Property | null>(null);
  const splitterRatio = () => app.viewsPanel().splitterRatio;
  const setSplitterRatio = (r: number) => app.setViewsPanel({ ...app.viewsPanel(), splitterRatio: r });

  return (
    <div class="wrl-displays">
      <div class="wrl-views-toolbar">
        <label>
          Type:
          <select class="wrl-edit" value={views.current().classId} onChange={(e) => views.setCurrentClass(e.currentTarget.value)}>
            <For each={views.classInfos()}>{(c) => <option value={c.classId} selected={c.classId === views.current().classId}>{c.name}</option>}</For>
            <Show when={!views.classInfos().some((c) => c.classId === views.current().classId)}>
              <option value={views.current().classId} selected>{views.current().classId.split('/').pop()} (not implemented, driven as Orbit)</option>
            </Show>
          </select>
        </label>
        <button type="button" onClick={() => views.current().reset()} title="Reset the current view (Z)">Zero</button>
      </div>
      <PropertyTree
        root={views.treeRoot}
        expanded={app.viewsExpanded}
        splitterRatio={splitterRatio}
        setSplitterRatio={setSplitterRatio}
        selected={selected}
        onSelect={setSelected}
      />
      <div class="wrl-help wrl-dim" style={{ height: '40px' }}>{selected()?.description ?? 'Saved views are a Tier 1 feature.'}</div>
      <div class="wrl-displays-buttons">
        <button type="button" disabled title="Tier 1">Save</button>
        <button type="button" disabled title="Tier 1">Remove</button>
        <button type="button" disabled title="Tier 1">Rename</button>
      </div>
    </div>
  );
}
