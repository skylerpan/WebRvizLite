import { For, Show, createSignal } from 'solid-js';
import type { PanelProps } from './solidPanel';
import { PropertyTree } from '../property/PropertyTree';
import type { Property } from '../property/types';
import { getApp } from '../app/store';

/**
 * rviz_common/Views: view type selector, Current View property tree, saved
 * views list and the Save / Remove / Rename / Zero buttons.
 */
export function ViewsPanel(_props: PanelProps) {
  const app = getApp();
  const views = app.manager.views;
  const [selected, setSelectedRaw] = createSignal<Property | null>(null);
  const splitterRatio = () => app.viewsPanel().splitterRatio;
  const setSplitterRatio = (r: number) => app.setViewsPanel({ ...app.viewsPanel(), splitterRatio: r });
  const selectedSaved = () => views.savedOf(selected());

  // rviz: clicking a saved view makes a copy of it the current view.
  const setSelected = (p: Property | null) => {
    setSelectedRaw(p);
    const saved = views.savedOf(p);
    if (saved && p === saved) views.setCurrentFrom(saved);
  };

  const save = () => views.saveCurrent();
  const remove = () => {
    const v = selectedSaved();
    if (v) {
      views.removeSaved(v);
      setSelectedRaw(null);
    }
  };
  const rename = () => {
    const v = selectedSaved();
    if (!v) return;
    // rviz ViewsPanel::onRenameClicked: QInputDialog "Rename View" / "New Name?"; empty or unchanged is ignored.
    const name = window.prompt('Rename View\nNew Name?', v.name());
    if (name !== null && name.trim() && name.trim() !== v.name()) views.renameSaved(v, name.trim());
  };

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
      <div class="wrl-help wrl-dim" style={{ height: '40px' }}>{selected()?.description ?? 'Save keeps the current view in the list below; click a saved view to switch to it.'}</div>
      <div class="wrl-displays-buttons">
        <button type="button" onClick={save} title="Save the current view">Save</button>
        <button type="button" disabled={!selectedSaved()} onClick={remove} title="Remove the selected saved view">Remove</button>
        <button type="button" disabled={!selectedSaved()} onClick={rename} title="Rename the selected saved view">Rename</button>
      </div>
    </div>
  );
}
