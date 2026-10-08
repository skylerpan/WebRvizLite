import { createDockview, themeDark, type DockviewApi, type IContentRenderer, type SerializedDockview } from 'dockview';
import { solidPanel } from '../panels/solidPanel';
import { DisplaysPanel } from '../panels/DisplaysPanel';
import { ViewsPanel } from '../panels/ViewsPanel';
import { TimePanel } from '../panels/TimePanel';
import { ToolPropertiesPanel } from '../panels/ToolPropertiesPanel';
import { SelectionPanel } from '../panels/SelectionPanel';
import { View3DPanel } from '../render/View3DPanel';
import { DebugPanel } from '../panels/DebugPanel';
import type { YamlMap } from '../property/types';

/**
 * Panel registry. Keys are dockview `component` names; the RViz panels map
 * 1:1 to the `rviz_common/<Name>` classes of the .rviz `Panels` section.
 * Displays that own a panel (Image, Camera) register extra components with
 * `registerPanelComponent`.
 */
const PANELS: Record<string, () => IContentRenderer> = {
  view3d: () => new View3DPanel(),
  displays: () => solidPanel(DisplaysPanel, 'wrl-panel wrl-panel-flush'),
  views: () => solidPanel(ViewsPanel, 'wrl-panel wrl-panel-flush'),
  toolProps: () => solidPanel(ToolPropertiesPanel, 'wrl-panel wrl-panel-flush'),
  selection: () => solidPanel(SelectionPanel, 'wrl-panel wrl-panel-flush'),
  time: () => solidPanel(TimePanel),
  debug: () => solidPanel(DebugPanel),
};

export function registerPanelComponent(name: string, factory: () => IContentRenderer) {
  PANELS[name] = factory;
}

/** dockview component id ↔ rviz panel class / title. */
export const RVIZ_PANELS: { id: string; classId: string; title: string }[] = [
  { id: 'displays', classId: 'rviz_common/Displays', title: 'Displays' },
  { id: 'views', classId: 'rviz_common/Views', title: 'Views' },
  { id: 'toolProps', classId: 'rviz_common/Tool Properties', title: 'Tool Properties' },
  { id: 'selection', classId: 'rviz_common/Selection', title: 'Selection' },
  { id: 'time', classId: 'rviz_common/Time', title: 'Time' },
];

export const PANEL_TITLES: Record<string, string> = Object.fromEntries(RVIZ_PANELS.map((p) => [p.id, p.title]));
PANEL_TITLES.debug = 'Topics (debug)';

export interface Layout {
  api: DockviewApi;
  /** Re-opens a closed panel (Panels menu) in its default dock position. */
  showPanel(id: string, title?: string): void;
  /** Rebuilds the RViz-style default layout from a .rviz `Panels` list (no list → Displays, Views, Time). */
  buildDefault(panels: YamlMap[] | null): void;
  /** dockview layout JSON for the `WebRvizLite Layout` config key. */
  serialize(): SerializedDockview;
  /** Restores a layout saved by `serialize()`; false (and the default layout) if it cannot be applied. */
  restore(json: unknown): boolean;
  /** Ids of the open panels (dockview component ids). */
  openPanels(): string[];
  /** Opens (or activates) a panel owned by a display, floating by default. */
  openDisplayPanel(id: string, component: string, title: string, size?: { width: number; height: number }): void;
  closePanel(id: string): void;
  setPanelTitle(id: string, title: string): void;
  dispose(): void;
}

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

  const lockCentre = () => {
    const view3d = api.getPanel('view3d');
    if (!view3d) return false;
    // The centre view is not a tab in RViz: hide its header and refuse drops into it.
    view3d.group.locked = 'no-drop-target';
    view3d.group.header.hidden = true;
    return true;
  };

  const clear = () => {
    for (const p of api.panels.slice()) api.removePanel(p);
  };

  const size = () => ({ width: container.clientWidth || 1200, height: container.clientHeight || 800 });

  /** Default dock position of a panel, relative to what is already open (RViz corner layout). */
  const defaultPosition = (id: string) => {
    const { width, height } = size();
    const has = (p: string) => !!api.getPanel(p);
    switch (id) {
      case 'displays':
        return { position: { referencePanel: 'view3d', direction: 'left' as const }, initialWidth: Math.round(width * 0.22) };
      case 'views':
        return { position: { referencePanel: 'view3d', direction: 'right' as const }, initialWidth: Math.round(width * 0.22) };
      case 'toolProps':
        return has('views')
          ? { position: { referencePanel: 'views', direction: 'below' as const }, initialHeight: Math.round(height * 0.3) }
          : { position: { referencePanel: 'view3d', direction: 'right' as const }, initialWidth: Math.round(width * 0.22) };
      case 'selection':
        return has('toolProps')
          ? { position: { referencePanel: 'toolProps', direction: 'within' as const } }
          : has('views')
            ? { position: { referencePanel: 'views', direction: 'below' as const }, initialHeight: Math.round(height * 0.3) }
            : { position: { referencePanel: 'view3d', direction: 'right' as const }, initialWidth: Math.round(width * 0.22) };
      case 'debug':
        return has('time')
          ? { position: { referencePanel: 'time', direction: 'within' as const } }
          : { position: { direction: 'below' as const }, initialHeight: Math.round(height * 0.3) };
      default:
        // Bottom dock spans the full width, as Qt's default corner layout does in RViz.
        return { position: { direction: 'below' as const }, initialHeight: Math.round(height * 0.1) };
    }
  };

  const addPanel = (id: string, title?: string) => {
    const existing = api.getPanel(id);
    if (existing) {
      existing.api.setActive();
      return;
    }
    api.addPanel({ id, component: id, title: title ?? PANEL_TITLES[id] ?? id, ...defaultPosition(id) });
  };

  const buildDefault = (panels: YamlMap[] | null) => {
    clear();
    api.addPanel({ id: 'view3d', component: 'view3d', title: '3D View' });
    lockCentre();
    const wanted: string[] = [];
    if (panels) {
      for (const p of panels) {
        const entry = RVIZ_PANELS.find((r) => r.classId === p.Class);
        if (entry && !wanted.includes(entry.id)) wanted.push(entry.id);
      }
    } else {
      wanted.push('displays', 'views', 'time');
    }
    // Build in dock order so later panels can reference earlier ones.
    const order = ['displays', 'views', 'toolProps', 'selection', 'time'];
    for (const id of order) if (wanted.includes(id)) addPanel(id);
    if (opts.debug) addPanel('debug');
    api.getPanel('view3d')?.api.setActive();
  };

  buildDefault(null);

  const sub = api.onDidLayoutChange(() => {
    if (import.meta.env.DEV) console.debug('[layout] changed');
  });

  return {
    api,
    showPanel: addPanel,
    buildDefault,
    serialize() {
      return api.toJSON();
    },
    restore(json) {
      if (!json || typeof json !== 'object') return false;
      try {
        api.fromJSON(json as SerializedDockview);
        if (!lockCentre()) throw new Error('layout has no 3D view');
        if (opts.debug) addPanel('debug');
        return true;
      } catch (e) {
        console.warn('[layout] could not restore the saved layout, using the default:', e);
        buildDefault(null);
        return false;
      }
    },
    openPanels() {
      return api.panels.map((p) => p.id);
    },
    openDisplayPanel(id, component, title, sz) {
      const existing = api.getPanel(id);
      if (existing) {
        existing.api.setActive();
        return;
      }
      const panel = api.addPanel({ id, component, title, floating: { width: sz?.width ?? 480, height: sz?.height ?? 360, position: { left: 80, top: 80 } } });
      panel.api.setActive();
    },
    closePanel(id) {
      api.getPanel(id)?.api.close();
    },
    setPanelTitle(id, title) {
      api.getPanel(id)?.api.setTitle(title);
    },
    dispose() {
      sub.dispose();
      api.dispose();
    },
  };
}
