import { createSignal } from 'solid-js';
import type { PanelProps } from './solidPanel';
import { PropertyTree } from '../property/PropertyTree';
import type { Property } from '../property/types';
import { getApp } from '../app/store';

/** rviz_common/Tool Properties: one row per toolbar tool that has properties. */
export function ToolPropertiesPanel(_props: PanelProps) {
  const app = getApp();
  const [selected, setSelected] = createSignal<Property | null>(null);
  const splitterRatio = () => app.toolPropsPanel().splitterRatio;
  const setSplitterRatio = (r: number) => app.setToolPropsPanel({ ...app.toolPropsPanel(), splitterRatio: r });

  return (
    <div class="wrl-displays">
      <PropertyTree
        root={app.manager.tools.propertiesRoot}
        expanded={app.toolPropsExpanded}
        splitterRatio={splitterRatio}
        setSplitterRatio={setSplitterRatio}
        selected={selected}
        onSelect={setSelected}
      />
      <div class="wrl-help wrl-dim" style={{ height: '40px' }}>{selected()?.description ?? ''}</div>
    </div>
  );
}
