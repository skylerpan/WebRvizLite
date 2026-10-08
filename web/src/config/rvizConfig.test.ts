import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RvizConfig } from './rvizConfig';
import { VisualizationManager } from '../displays/manager';
import type { YamlValue } from '../property/types';
import { isYamlMap } from '../property/Property';
import { TfSnapshot } from '../render/tf';

const FIXTURES = join(__dirname, '../../../fixtures');

/** Every key path in `expected` must exist in `actual` with an equal value (extra keys in actual are fine). */
function missingPaths(expected: YamlValue, actual: YamlValue, path = ''): string[] {
  if (isYamlMap(expected)) {
    if (!isYamlMap(actual)) return [`${path}: expected map, got ${JSON.stringify(actual)}`];
    return Object.entries(expected).flatMap(([k, v]) => (k in actual ? missingPaths(v, actual[k], `${path}/${k}`) : [`${path}/${k}: missing`]));
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return [`${path}: list length ${expected.length} vs ${Array.isArray(actual) ? actual.length : 'non-list'}`];
    return expected.flatMap((v, i) => missingPaths(v, actual[i], `${path}[${i}]`));
  }
  return Object.is(expected, actual) || expected === actual ? [] : [`${path}: ${JSON.stringify(expected)} → ${JSON.stringify(actual)}`];
}

function fakeManager(): VisualizationManager {
  const scene = { add() {}, remove() {} } as never;
  const bridge = {
    subscribe: () => 1, unsubscribe() {}, topics: () => [], setFixedFrame() {}, setTfRate() {}, setOptions() {},
    tf: new TfSnapshot(), clock: () => null,
  } as never;
  return new VisualizationManager(scene, bridge);
}

describe('.rviz round trip', () => {
  for (const file of readdirSync(FIXTURES).filter((f: string) => f.endsWith('.rviz'))) {
    it(`${file}: no key is lost through load → save`, () => {
      const text = readFileSync(join(FIXTURES, file), 'utf8');
      const input = RvizConfig.parse(text);
      const manager = fakeManager();
      manager.load(input.visualizationManager!);
      const panelState = input.displaysPanelState();

      const output = new RvizConfig(structuredClone(input.raw()));
      output.setVisualizationManager(manager.save());
      output.setDisplaysPanelState(panelState);
      const reparsed = RvizConfig.parse(output.stringify());

      const missing = missingPaths(input.raw(), reparsed.raw());
      expect(missing).toEqual([]);
    });
  }

  it('default.rviz: Grid loads into the real display with RViz values', () => {
    const input = RvizConfig.parse(readFileSync(join(FIXTURES, 'default.rviz'), 'utf8'));
    const manager = fakeManager();
    manager.load(input.visualizationManager!);
    expect(manager.fixedFrameProperty.value()).toBe('/map');
    expect(manager.fixedFrame()).toBe('map');
    expect(manager.backgroundColor.value()).toEqual({ r: 48, g: 48, b: 48 });
    const grid = manager.root.displays()[0] as unknown as { classId: string; name(): string; child(n: string): { value(): unknown; save(): unknown } | undefined };
    expect(grid.classId).toBe('rviz_default_plugins/Grid');
    expect(grid.name()).toBe('Grid');
    expect(grid.child('Line Style')!.save()).toEqual({ Value: 'Lines', 'Line Width': 0.03 });
    expect(grid.child('Reference Frame')!.value()).toBe('<Fixed Frame>');
    expect(input.displaysPanelState().expanded).toEqual(['/Global Options1', '/Status1']);
    // Tools / Views are preserved verbatim until their managers exist.
    const saved = manager.save();
    // Tools: MoveCamera is real, the rest are preserved; Views: Orbit round-trips plus hidden extras.
    expect((saved.Tools as unknown[]).length).toBe((input.visualizationManager as { Tools: unknown[] }).Tools.length);
    const views = saved.Views as { Current: Record<string, unknown>; Saved: unknown };
    expect(views.Current.Class).toBe('rviz_default_plugins/Orbit');
    expect(views.Current.Distance).toBe(10);
    expect(views.Current.Yaw).toBe(0.785398);
    expect(views.Saved).toBeNull();
    expect(saved.Name).toBe('root');
    expect(saved.Class).toBe('');
  });

  it('nav2: nested rviz_common/Group and unknown classes survive', () => {
    const input = RvizConfig.parse(readFileSync(join(FIXTURES, 'nav2_default_view.rviz'), 'utf8'));
    const manager = fakeManager();
    manager.load(input.visualizationManager!);
    const classes = manager.root.displays().map((d) => d.classId);
    expect(classes).toContain('rviz_common/Group');
    expect(classes).toContain('rviz_default_plugins/Grid');
  });

  it('Tier 1 panel keys: Time / Tool Properties / Selection / Window Geometry / layout round-trip', () => {
    const text = readFileSync(join(FIXTURES, 'default.rviz'), 'utf8');
    const cfg = RvizConfig.parse(text);
    expect(cfg.timePanelState()).toEqual({ experimental: false, syncMode: 0, syncSource: '' });
    expect(cfg.treePanelState('rviz_common/Tool Properties', []).expanded).toEqual(['/2D Goal Pose1', '/Publish Point1']);

    const known = ['rviz_common/Displays', 'rviz_common/Views', 'rviz_common/Tool Properties', 'rviz_common/Selection', 'rviz_common/Time'];
    cfg.prunePanels(known, ['rviz_common/Displays', 'rviz_common/Time', 'rviz_common/Selection']);
    expect(cfg.panels().map((p) => p.Class)).toEqual(['rviz_common/Displays', 'rviz_common/Selection', 'rviz_common/Time']);
    cfg.setTimePanelState({ experimental: true, syncMode: 2, syncSource: '/scan' });
    cfg.setPanelPresent('rviz_common/Selection', 'Selection');
    cfg.setWindowGeometry(['Displays', 'Selection', 'Time']);
    cfg.setLayout({ grid: { root: { type: 'branch', data: [] }, width: 1, height: 1, orientation: 'HORIZONTAL' }, panels: {} });
    const re = RvizConfig.parse(cfg.stringify());
    expect(re.timePanelState()).toEqual({ experimental: true, syncMode: 2, syncSource: '/scan' });
    expect(re.panels().filter((p) => p.Class === 'rviz_common/Selection')).toHaveLength(1);
    const wg = re.windowGeometry;
    expect(wg.Selection).toEqual({ collapsed: false });
    expect(wg.Displays).toEqual({ collapsed: false });
    expect(typeof wg['QMainWindow State']).toBe('string');
    expect(isYamlMap(re.layout) && isYamlMap(re.layout.grid)).toBe(true);
  });

  it('stringify keeps the QMainWindow State hex blob on one line', () => {
    const text = readFileSync(join(FIXTURES, 'default.rviz'), 'utf8');
    const out = RvizConfig.parse(text).stringify();
    const line = out.split('\n').find((l) => l.includes('QMainWindow State'))!;
    expect(line.length).toBeGreaterThan(200);
    expect(out).toContain('Saved: ~');
  });
});
