import { onCleanup } from 'solid-js';
import type { PanelProps } from './solidPanel';
import { PropertyTree } from '../property/PropertyTree';
import { getApp } from '../app/store';

/** rviz_common/Displays: display tree, help area and Add / Duplicate / Remove / Rename. */
export function DisplaysPanel(_props: PanelProps) {
  const app = getApp();
  const splitterRatio = () => app.displaysPanel().splitterRatio;
  const setSplitterRatio = (r: number) => app.setDisplaysPanel({ ...app.displaysPanel(), splitterRatio: r });
  const helpHeight = () => app.displaysPanel().helpHeight;
  const selected = app.selectedProperty;
  const hasDisplay = () => app.selectedDisplay() !== null;

  const startHelpDrag = (e: PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = helpHeight();
    const move = (ev: PointerEvent) => app.setDisplaysPanel({ ...app.displaysPanel(), helpHeight: Math.max(0, startH - (ev.clientY - startY)) });
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  onCleanup(() => app.setSelectedProperty(null));

  const rename = () => {
    const d = app.selectedDisplay();
    if (!d) return;
    const name = window.prompt('Display name', d.name());
    if (name !== null) app.renameSelected(name);
  };

  return (
    <div class="wrl-displays" data-displays-panel>
      <PropertyTree
        root={app.manager.root}
        expanded={app.displaysExpanded}
        splitterRatio={splitterRatio}
        setSplitterRatio={setSplitterRatio}
        selected={selected}
        onSelect={app.setSelectedProperty}
      />
      <div class="wrl-help-handle" onPointerDown={startHelpDrag} />
      <div class="wrl-help" style={{ height: `${helpHeight()}px` }}>
        {selected() ? (
          <>
            <b>{selected()!.name()}</b>
            <div>{selected()!.description || 'No description'}</div>
          </>
        ) : (
          <span class="wrl-dim">Select a property to see its description.</span>
        )}
      </div>
      <div class="wrl-displays-buttons">
        <button type="button" onClick={() => app.setDialog('addDisplay')} title="Add Display (Ctrl+Alt+N)">Add</button>
        <button type="button" disabled={!hasDisplay()} onClick={() => app.duplicateSelected()} title="Duplicate (Ctrl+D)">Duplicate</button>
        <button type="button" disabled={!hasDisplay()} onClick={() => app.removeSelected()} title="Remove (Delete)">Remove</button>
        <button type="button" disabled={!hasDisplay()} onClick={rename} title="Rename (F2)">Rename</button>
      </div>
    </div>
  );
}
