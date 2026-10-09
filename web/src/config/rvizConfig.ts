/**
 * .rviz file codec (spec §4.4). Top-level sections: Panels, Visualization
 * Manager, Window Geometry. Everything we do not model is preserved verbatim.
 */

import YAML from 'yaml';
import { isYamlMap } from '../property/Property';
import type { YamlMap, YamlValue } from '../property/types';

export interface DisplaysPanelState {
  expanded: string[];
  splitterRatio: number;
  treeHeight: number;
  helpHeight: number;
}

export const DEFAULT_DISPLAYS_PANEL_STATE: DisplaysPanelState = {
  expanded: ['/Global Options1', '/Status1'],
  splitterRatio: 0.5,
  treeHeight: 464,
  helpHeight: 78,
};

/** Expanded + Splitter Ratio, as saved by the Views and Tool Properties panels. */
export interface TreePanelState {
  expanded: string[];
  splitterRatio: number;
}

export class RvizConfig {
  /** Full document; sections we own are replaced on save, the rest is kept. */
  private doc: YamlMap;

  constructor(doc: YamlMap = {}) {
    this.doc = doc;
  }

  static parse(text: string): RvizConfig {
    const parsed = YAML.parse(text) as YamlValue;
    if (!isYamlMap(parsed)) throw new Error('.rviz file must be a YAML map');
    return new RvizConfig(parsed);
  }

  /** Serializes like rviz (sorted keys, `~` for null, no line folding of the hex blob). */
  stringify(): string {
    return YAML.stringify(this.doc, { lineWidth: 0, sortMapEntries: true, nullStr: '~', indentSeq: true });
  }

  get visualizationManager(): YamlValue | undefined {
    return this.doc['Visualization Manager'];
  }
  setVisualizationManager(v: YamlMap) {
    this.doc['Visualization Manager'] = v;
  }

  /** Our dockview layout (Tier 1); kept separate from Qt's `QMainWindow State`. */
  get layout(): YamlValue | undefined {
    return this.doc['WebRvizLite Layout'];
  }
  setLayout(v: YamlValue) {
    this.doc['WebRvizLite Layout'] = v;
  }

  get windowGeometry(): YamlMap {
    const wg = this.doc['Window Geometry'];
    return isYamlMap(wg) ? wg : {};
  }

  panels(): YamlMap[] {
    const p = this.doc.Panels;
    return Array.isArray(p) ? p.filter(isYamlMap) : [];
  }

  panel(classId: string): YamlMap | undefined {
    return this.panels().find((p) => p.Class === classId);
  }

  displaysPanelState(): DisplaysPanelState {
    const p = this.panel('rviz_common/Displays');
    const tree = p && isYamlMap(p['Property Tree Widget']) ? p['Property Tree Widget'] : {};
    const num = (v: YamlValue | undefined, d: number) => (typeof v === 'number' ? v : d);
    return {
      expanded: Array.isArray(tree.Expanded) ? tree.Expanded.filter((e): e is string => typeof e === 'string') : [],
      splitterRatio: num(tree['Splitter Ratio'], DEFAULT_DISPLAYS_PANEL_STATE.splitterRatio),
      treeHeight: num(p?.['Tree Height'], DEFAULT_DISPLAYS_PANEL_STATE.treeHeight),
      helpHeight: num(p?.['Help Height'], DEFAULT_DISPLAYS_PANEL_STATE.helpHeight),
    };
  }

  setDisplaysPanelState(s: DisplaysPanelState) {
    const panels = this.panels();
    let p = panels.find((x) => x.Class === 'rviz_common/Displays');
    if (!p) {
      p = { Class: 'rviz_common/Displays', Name: 'Displays' };
      panels.push(p);
    }
    p['Help Height'] = s.helpHeight;
    p['Tree Height'] = s.treeHeight;
    p['Property Tree Widget'] = { Expanded: s.expanded, 'Splitter Ratio': s.splitterRatio };
    this.doc.Panels = panels;
  }

  treePanelState(classId: string, defaultExpanded: string[]): TreePanelState {
    const p = this.panel(classId);
    return {
      expanded: Array.isArray(p?.Expanded) ? p!.Expanded.filter((e): e is string => typeof e === 'string') : defaultExpanded,
      splitterRatio: typeof p?.['Splitter Ratio'] === 'number' ? (p!['Splitter Ratio'] as number) : 0.5,
    };
  }

  setTreePanelState(classId: string, name: string, s: TreePanelState) {
    const panels = this.panels();
    let p = panels.find((x) => x.Class === classId);
    if (!p) {
      p = { Class: classId, Name: name };
      panels.push(p);
    }
    p.Expanded = s.expanded;
    p['Splitter Ratio'] = s.splitterRatio;
    this.doc.Panels = panels;
  }

  timePanelState(): TimePanelState {
    const p = this.panel('rviz_common/Time');
    return {
      experimental: typeof p?.Experimental === 'boolean' ? p.Experimental : false,
      syncMode: typeof p?.SyncMode === 'number' ? p.SyncMode : 0,
      syncSource: typeof p?.SyncSource === 'string' ? p.SyncSource : '',
    };
  }

  setTimePanelState(s: TimePanelState) {
    const p = this.ensurePanel('rviz_common/Time', 'Time');
    p.Experimental = s.experimental;
    p.SyncMode = s.syncMode;
    p.SyncSource = s.syncSource;
  }

  /** Adds a `Panels` entry with just Class and Name (Selection has no state of its own). */
  setPanelPresent(classId: string, name: string) {
    this.ensurePanel(classId, name);
  }

  /** Drops entries of the given classes that are not in `openClassIds`; other classes are kept verbatim. */
  prunePanels(knownClassIds: readonly string[], openClassIds: readonly string[]) {
    this.doc.Panels = this.panels().filter((p) => typeof p.Class !== 'string' || !knownClassIds.includes(p.Class) || openClassIds.includes(p.Class));
  }

  private ensurePanel(classId: string, name: string): YamlMap {
    const panels = this.panels();
    let p = panels.find((x) => x.Class === classId);
    if (!p) {
      p = { Class: classId, Name: name };
      panels.push(p);
    }
    this.doc.Panels = panels;
    return p;
  }

  /**
   * rviz stores each panel's `collapsed` flag under Window Geometry keyed by
   * title; numeric fields and `QMainWindow State` are kept untouched.
   */
  setWindowGeometry(openTitles: readonly string[]) {
    const wg = { ...this.windowGeometry };
    for (const t of openTitles) {
      const prev = wg[t];
      wg[t] = { ...(isYamlMap(prev) ? prev : {}), collapsed: false };
    }
    this.doc['Window Geometry'] = wg;
  }

  raw(): YamlMap {
    return this.doc;
  }
}

export interface TimePanelState {
  experimental: boolean;
  syncMode: number;
  syncSource: string;
}
