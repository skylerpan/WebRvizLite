import { createDockview, themeDark, type DockviewApi, type IContentRenderer } from 'dockview';
import { solidPanel } from '../panels/solidPanel';
import { DisplaysPanel } from '../panels/DisplaysPanel';
import { ViewsPanel } from '../panels/ViewsPanel';
import { TimePanel } from '../panels/TimePanel';
import { View3DPanel } from '../render/View3DPanel';
import { DebugPanel } from '../panels/DebugPanel';

/**
 * Panel registry. Keys are dockview `component` names and will map 1:1 to the
 * `rviz_common/<Name>` panel classes once .rviz loading lands (M2).
 */
const PANELS: Record<string, () => IContentRenderer> = {
  view3d: () => new View3DPanel(),
  displays: () => solidPanel(DisplaysPanel, 'wrl-panel wrl-panel-flush'),
  views: () => solidPanel(ViewsPanel, 'wrl-panel wrl-panel-flush'),
  time: () => solidPanel(TimePanel),
  debug: () => solidPanel(DebugPanel),
};

export interface Layout {
  api: DockviewApi;
  /** Re-opens a closed panel (Panels menu) next to the 3D view. */
  showPanel(id: string, title: string): void;
  dispose(): void;
}

/** Builds the RViz default layout: Displays left, Views right, Time bottom, 3D view centre. */
export interface LayoutOptions {
  /** Also open the M1 topic debug panel next to Time. */
  debug?: boolean;
}

export function createLayout(container: HTMLElement, opts: LayoutOptions = {}): Layout {
  const api = createDockview(container, {
    theme: themeDark,
    createComponent: ({ name }) => {
      const factory = PANELS[name];
      if (!factory) throw new Error(`unknown panel component: ${name}`);
      return factory();
    },
  });

  const view3d = api.addPanel({ id: 'view3d', component: 'view3d', title: '3D View' });
  // The centre view is not a tab in RViz: hide its header and refuse drops into it.
  view3d.group.locked = 'no-drop-target';
  view3d.group.header.hidden = true;

  const width = container.clientWidth || 1200;
  const height = container.clientHeight || 800;

  api.addPanel({
    id: 'displays', component: 'displays', title: 'Displays',
    position: { referencePanel: 'view3d', direction: 'left' },
    initialWidth: Math.round(width * 0.22),
  });
  api.addPanel({
    id: 'views', component: 'views', title: 'Views',
    position: { referencePanel: 'view3d', direction: 'right' },
    initialWidth: Math.round(width * 0.22),
  });
  // Bottom dock spans the full width, as Qt's default corner layout does in RViz.
  api.addPanel({
    id: 'time', component: 'time', title: 'Time',
    position: { direction: 'below' },
    // Taller when the debug table is open so its rows are visible.
    initialHeight: Math.round(height * (opts.debug ? 0.3 : 0.1)),
  });
  if (opts.debug) {
    api.addPanel({
      id: 'debug', component: 'debug', title: 'Topics (debug)',
      position: { referencePanel: 'time', direction: 'within' },
    });
  }
  view3d.api.setActive();

  const sub = api.onDidLayoutChange(() => {
    // Layout persistence is Tier 1; for now just make it observable in dev.
    if (import.meta.env.DEV) console.debug('[layout] changed');
  });

  return {
    api,
    showPanel(id, title) {
      const existing = api.getPanel(id);
      if (existing) {
        existing.api.setActive();
        return;
      }
      const direction = id === 'displays' ? 'left' : id === 'views' ? 'right' : 'below';
      api.addPanel({ id, component: id, title, position: direction === 'below' ? { direction } : { referencePanel: 'view3d', direction } });
    },
    dispose() {
      sub.dispose();
      api.dispose();
    },
  };
}
