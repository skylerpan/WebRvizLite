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

  it('stringify keeps the QMainWindow State hex blob on one line', () => {
    const text = readFileSync(join(FIXTURES, 'default.rviz'), 'utf8');
    const out = RvizConfig.parse(text).stringify();
    const line = out.split('\n').find((l) => l.includes('QMainWindow State'))!;
    expect(line.length).toBeGreaterThan(200);
    expect(out).toContain('Saved: ~');
  });
});
