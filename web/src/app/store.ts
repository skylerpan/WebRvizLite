/**
 * App singleton: the three.js scene, the bridge, the VisualizationManager,
 * the currently loaded .rviz config and where it came from. Panels and the
 * 3D view read from here.
 */

import { createSignal, type Accessor } from 'solid-js';
import * as THREE from 'three/webgpu';
import { getBridge } from './bridge';
import { VisualizationManager } from '../displays/manager';
import { DEFAULT_DISPLAYS_PANEL_STATE, RvizConfig, type DisplaysPanelState, type TimePanelState, type TreePanelState } from '../config/rvizConfig';
import { RVIZ_PANELS, type Layout } from './layout';
import { SelectionManager } from './selection';
import type { Display, DisplayGroup } from '../displays/types';
import type { Property, YamlValue } from '../property/types';
import { DisplayGroupImpl } from '../displays/Display';
import type { ConfigSource } from './configIO';
import { ExpandedState } from '../property/PropertyTree';
import defaultRviz from '../../../fixtures/default.rviz?raw';

/** rviz default.rviz expands the three publishing tools in the Tool Properties panel. */
const DEFAULT_TOOL_PROPS_EXPANDED = ['/2D Pose Estimate1', '/2D Goal Pose1', '/Publish Point1'];

export class AppStore {
  readonly scene = new THREE.Scene();
  readonly bridge = getBridge();
  readonly manager = new VisualizationManager(this.scene, this.bridge);
  /** Last loaded config document; sections we own are replaced on save. */
  config = new RvizConfig();
  readonly displaysPanel: Accessor<DisplaysPanelState>;
  readonly setDisplaysPanel: (s: DisplaysPanelState) => void;
  readonly viewsPanel: Accessor<TreePanelState>;
  readonly setViewsPanel: (s: TreePanelState) => void;
  readonly toolPropsPanel: Accessor<TreePanelState>;
  readonly setToolPropsPanel: (s: TreePanelState) => void;
  readonly timePanel: Accessor<TimePanelState>;
  readonly setTimePanel: (s: TimePanelState) => void;
  /** The dockview layout once the main window is mounted. */
  readonly layout: Accessor<Layout | null>;
  readonly setLayout: (l: Layout | null) => void;
  readonly selection = new SelectionManager();
  readonly configName: Accessor<string>;
  readonly setConfigName: (s: string) => void;
  /** Expanded nodes of the Displays and Views trees (paths are computed at save time). */
  readonly displaysExpanded = new ExpandedState(DEFAULT_DISPLAYS_PANEL_STATE.expanded);
  readonly viewsExpanded = new ExpandedState(['/Current View1']);
  readonly toolPropsExpanded = new ExpandedState(DEFAULT_TOOL_PROPS_EXPANDED);
  readonly source: Accessor<ConfigSource>;
  readonly setSource: (s: ConfigSource) => void;
  /** Property selected in the Displays tree (drives Duplicate / Remove / Rename). */
  readonly selectedProperty: Accessor<Property | null>;
  readonly setSelectedProperty: (p: Property | null) => void;
  /** Open modal dialog, if any. */
  readonly dialog: Accessor<'addDisplay' | 'addTool' | 'about' | null>;
  readonly setDialog: (d: 'addDisplay' | 'addTool' | 'about' | null) => void;

  constructor() {
    const [dp, setDp] = createSignal<DisplaysPanelState>(DEFAULT_DISPLAYS_PANEL_STATE);
    this.displaysPanel = dp;
    this.setDisplaysPanel = setDp;
    const [vp, setVp] = createSignal<TreePanelState>({ expanded: ['/Current View1'], splitterRatio: 0.5 });
    this.viewsPanel = vp;
    this.setViewsPanel = setVp;
    const [tp, setTp] = createSignal<TreePanelState>({ expanded: DEFAULT_TOOL_PROPS_EXPANDED, splitterRatio: 0.5 });
    this.toolPropsPanel = tp;
    this.setToolPropsPanel = setTp;
    const [time, setTime] = createSignal<TimePanelState>({ experimental: false, syncMode: 0, syncSource: '' });
    this.timePanel = time;
    this.setTimePanel = setTime;
    const [layout, setLayout] = createSignal<Layout | null>(null);
    this.layout = layout;
    this.setLayout = setLayout;
    const [name, setName] = createSignal('default.rviz');
    this.configName = name;
    this.setConfigName = setName;
    const [source, setSource] = createSignal<ConfigSource>({ kind: 'embedded' });
    this.source = source;
    this.setSource = setSource;
    const [sel, setSel] = createSignal<Property | null>(null);
    this.selectedProperty = sel;
    this.setSelectedProperty = setSel;
    const [dialog, setDialog] = createSignal<'addDisplay' | 'addTool' | 'about' | null>(null);
    this.dialog = dialog;
    this.setDialog = setDialog;
  }

  /** Loads a .rviz document. Throws on YAML errors. */
  loadConfigText(text: string, name: string) {
    const cfg = RvizConfig.parse(text);
    this.config = cfg;
    if (cfg.visualizationManager !== undefined) this.manager.load(cfg.visualizationManager);
    this.setDisplaysPanel(cfg.displaysPanelState());
    this.setViewsPanel(cfg.treePanelState('rviz_common/Views', ['/Current View1']));
    this.setToolPropsPanel(cfg.treePanelState('rviz_common/Tool Properties', DEFAULT_TOOL_PROPS_EXPANDED));
    this.setTimePanel(cfg.timePanelState());
    this.displaysExpanded.load(this.displaysPanel().expanded);
    this.viewsExpanded.load(this.viewsPanel().expanded);
    this.toolPropsExpanded.load(this.toolPropsPanel().expanded);
    this.setConfigName(name);
    this.setSelectedProperty(null);
    this.selection.clear();
    this.manager.time.setPaused(false);
    document.title = `${name} - WebRvizLite`;
    this.applyLayoutFromConfig();
  }

  /**
   * Panels: the saved dockview layout (`WebRvizLite Layout`) if present, else
   * the RViz default built from the `Panels` list. Safe to call before the
   * layout exists (then it runs when the window mounts).
   */
  applyLayoutFromConfig() {
    const l = this.layout();
    if (!l) return;
    const saved = this.config.layout;
    if (saved && l.restore(saved)) return;
    const panels = this.config.panels();
    l.buildDefault(panels.length ? panels : null);
  }

  loadDefaultConfig() {
    this.loadConfigText(defaultRviz, 'default.rviz');
    this.setSource({ kind: 'embedded' });
  }

  /** Serializes the current state back into the loaded document. */
  saveConfigText(): string {
    this.config.setVisualizationManager(this.manager.save());
    this.config.setDisplaysPanelState({ ...this.displaysPanel(), expanded: this.displaysExpanded.paths(this.manager.root) });
    const l = this.layout();
    const open = l ? l.openPanels() : RVIZ_PANELS.map((p) => p.id);
    const openClasses = RVIZ_PANELS.filter((p) => open.includes(p.id)).map((p) => p.classId);
    this.config.prunePanels(RVIZ_PANELS.map((p) => p.classId), openClasses);
    if (open.includes('views')) this.config.setTreePanelState('rviz_common/Views', 'Views', { ...this.viewsPanel(), expanded: this.viewsExpanded.paths(this.manager.views.treeRoot) });
    if (open.includes('toolProps')) this.config.setTreePanelState('rviz_common/Tool Properties', 'Tool Properties', { ...this.toolPropsPanel(), expanded: this.toolPropsExpanded.paths(this.manager.tools.propertiesRoot) });
    if (open.includes('selection')) this.config.setPanelPresent('rviz_common/Selection', 'Selection');
    if (open.includes('time')) this.config.setTimePanelState(this.timePanel());
    this.config.setWindowGeometry(RVIZ_PANELS.filter((p) => open.includes(p.id)).map((p) => p.title));
    if (l) this.config.setLayout(l.serialize() as unknown as YamlValue);
    return this.config.stringify();
  }

  /** Startup: `-d` config from the server if any, else the built-in default. */
  async loadStartupConfig(displayConfigPath: string | null) {
    if (displayConfigPath) {
      try {
        const res = await fetch('/api/display-config');
        if (res.ok) {
          this.loadConfigText(await res.text(), displayConfigPath.split('/').pop() ?? displayConfigPath);
          this.setSource({ kind: 'server', path: displayConfigPath });
          return;
        }
        console.warn('[config] server config unavailable:', res.status);
      } catch (e) {
        console.warn('[config] server config failed:', e);
      }
    }
    this.loadDefaultConfig();
  }

  /** Keys pressed while the 3D view has focus (spec §5.1 view/tool shortcuts). */
  handleViewportKey(key: string, e: KeyboardEvent): boolean {
    if (this.manager.tools.handleKey(key, e)) return true;
    if (key === 'z' || key === 'Z') {
      this.manager.views.current().reset();
      return true;
    }
    return false;
  }

  // --- Displays panel actions --------------------------------------------

  /** The Display that owns the selected property (or the selection itself). */
  selectedDisplay(): Display | null {
    let p: Property | null = this.selectedProperty();
    while (p) {
      if ('classId' in p && 'status' in p && p !== this.manager.root) return p as Display;
      p = p.parent;
    }
    return null;
  }

  /** Group that new displays go into: the selected group, or the selected display's parent, or root. */
  targetGroup(): DisplayGroup {
    const d = this.selectedDisplay();
    if (d instanceof DisplayGroupImpl) return d;
    if (d?.parent instanceof DisplayGroupImpl) return d.parent;
    return this.manager.root;
  }

  addDisplay(classId: string, name: string, topic?: string): Display {
    const d = this.manager.registry.create(classId);
    d.setName(name);
    const topicProp = d.child('Topic');
    if (topic && topicProp) topicProp.setValue(topic, 'program');
    this.targetGroup().addDisplay(d);
    this.setSelectedProperty(d);
    return d;
  }

  duplicateSelected(): Display | null {
    const d = this.selectedDisplay();
    if (!d || !(d.parent instanceof DisplayGroupImpl)) return null;
    const copy = d.parent.duplicateDisplay(d);
    this.setSelectedProperty(copy);
    return copy;
  }

  removeSelected(): boolean {
    const d = this.selectedDisplay();
    if (!d || !(d.parent instanceof DisplayGroupImpl)) return false;
    d.parent.removeDisplay(d);
    this.setSelectedProperty(null);
    return true;
  }

  renameSelected(name: string): boolean {
    const d = this.selectedDisplay();
    if (!d || !name.trim()) return false;
    d.setName(name.trim());
    return true;
  }
}

let instance: AppStore | null = null;
export function getApp(): AppStore {
  if (!instance) instance = new AppStore();
  return instance;
}
