// @vitest-environment jsdom
/** AppStore: loading a .rviz document into the manager / panels / layout and serializing it back. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppStore } from './store';
import type { Layout } from './layout';
import { RvizConfig } from '../config/rvizConfig';
import { TfSnapshot } from '../render/tf';
import type { YamlMap } from '../property/types';

const FIXTURES = join(__dirname, '../../../fixtures');
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');

function fakeBridge() {
  return {
    subscribe: () => 1, unsubscribe() {}, topics: () => [], setFixedFrame() {}, setTfRate() {}, setOptions() {},
    tf: new TfSnapshot(), clock: () => null, hello: () => null,
  } as never;
}

/** Records layout calls; `restoreResult` is what `restore` reports back. */
function fakeLayout(restoreResult = true) {
  const calls: { restore: unknown[]; buildDefault: (YamlMap[] | null)[] } = { restore: [], buildDefault: [] };
  let open = ['view3d', 'displays', 'views', 'time'];
  const layout: Layout = {
    api: {} as never,
    showPanel: (id) => { if (!open.includes(id)) open.push(id); },
    buildDefault: (panels) => { calls.buildDefault.push(panels); },
    serialize: () => ({ grid: { root: { type: 'branch', data: [] }, width: 1, height: 1, orientation: 'HORIZONTAL' }, panels: {} }) as never,
    restore: (json) => { calls.restore.push(json); return restoreResult; },
    openPanels: () => open.slice(),
    openDisplayPanel: (id) => { if (!open.includes(id)) open.push(id); },
    closePanel: (id) => { open = open.filter((p) => p !== id); },
    setPanelTitle() {},
    dispose() {},
  };
  return { layout, calls, setOpen: (ids: string[]) => { open = ids; } };
}

const displayNames = (app: AppStore) => app.manager.root.displays().map((d) => d.name());

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AppStore.loadConfigText', () => {
  it('replaces displays, panel state and the window title; works before the layout exists', () => {
    const app = new AppStore(fakeBridge());
    expect(app.layout()).toBeNull();
    app.loadConfigText(fixture('mock_scene.rviz'), 'mock_scene.rviz');
    expect(app.configName()).toBe('mock_scene.rviz');
    expect(document.title).toBe('mock_scene.rviz - WebRvizLite');
    expect(displayNames(app)).toContain('Livox');
    expect(app.displaysPanel().expanded).toEqual(RvizConfig.parse(fixture('mock_scene.rviz')).displaysPanelState().expanded);

    app.loadConfigText(fixture('default.rviz'), 'default.rviz');
    expect(displayNames(app)).toEqual(['Grid']);
    expect(app.configName()).toBe('default.rviz');
  });

  it('rejects a document that is not a YAML map and leaves the current state alone', () => {
    const app = new AppStore(fakeBridge());
    app.loadConfigText(fixture('mock_scene.rviz'), 'mock_scene.rviz');
    expect(() => app.loadConfigText('- just\n- a list\n', 'bad.rviz')).toThrow(/YAML map/);
    expect(app.configName()).toBe('mock_scene.rviz');
    expect(displayNames(app)).toContain('Livox');
  });

  it('a file without a saved layout rebuilds the default layout from its Panels list', () => {
    const app = new AppStore(fakeBridge());
    const { layout, calls } = fakeLayout();
    app.setLayout(layout);
    app.loadConfigText(fixture('tier1_scene.rviz'), 'tier1_scene.rviz');
    expect(calls.restore).toEqual([]);
    expect(calls.buildDefault).toHaveLength(1);
    expect(calls.buildDefault[0]!.map((p) => p.Class)).toEqual(RvizConfig.parse(fixture('tier1_scene.rviz')).panels().map((p) => p.Class));
  });

  it('a file saved by WebRvizLite restores its dockview layout instead', () => {
    const app = new AppStore(fakeBridge());
    const { layout, calls } = fakeLayout(true);
    app.setLayout(layout);
    app.loadConfigText(fixture('mock_scene.rviz'), 'mock_scene.rviz');
    const saved = app.saveConfigText();
    expect(saved).toContain('WebRvizLite Layout');
    calls.restore.length = 0;
    calls.buildDefault.length = 0;

    app.loadConfigText(saved, 'saved.rviz');
    expect(calls.restore).toHaveLength(1);
    expect(calls.buildDefault).toEqual([]);
    expect(displayNames(app)).toContain('Livox');
  });

  it('falls back to the default layout when the saved one cannot be restored', () => {
    const app = new AppStore(fakeBridge());
    const { layout, calls } = fakeLayout(false);
    app.setLayout(layout);
    app.loadConfigText(fixture('mock_scene.rviz'), 'mock_scene.rviz');
    const saved = app.saveConfigText();
    calls.buildDefault.length = 0;
    app.loadConfigText(saved, 'saved.rviz');
    expect(calls.restore).toHaveLength(1);
    expect(calls.buildDefault).toHaveLength(1);
  });
});

describe('AppStore.saveConfigText', () => {
  it('round-trips the displays and records the open panels and the dockview layout', () => {
    const app = new AppStore(fakeBridge());
    const { layout, setOpen } = fakeLayout();
    app.setLayout(layout);
    app.loadConfigText(fixture('tier1_scene.rviz'), 'tier1_scene.rviz');
    const before = displayNames(app);
    setOpen(['view3d', 'displays', 'time']);

    const out = RvizConfig.parse(app.saveConfigText());
    const vm = out.visualizationManager as YamlMap;
    expect((vm.Displays as YamlMap[]).map((d) => d.Name)).toEqual(before);
    expect(out.panels().map((p) => p.Class)).toEqual(['rviz_common/Displays', 'rviz_common/Time']);
    expect(out.windowGeometry.Displays).toEqual(expect.objectContaining({ collapsed: false }));
    expect(out.layout).toEqual(expect.objectContaining({ grid: expect.anything() }));

    // Reopening Views / Tool Properties writes their entries again.
    setOpen(['view3d', 'displays', 'views', 'toolProps', 'time']);
    const again = RvizConfig.parse(app.saveConfigText());
    expect(again.panels().map((p) => p.Class)).toEqual(['rviz_common/Displays', 'rviz_common/Time', 'rviz_common/Views', 'rviz_common/Tool Properties']);
  });

  it('the saved text loads back into an identical display list', () => {
    const app = new AppStore(fakeBridge());
    app.loadConfigText(fixture('nav2_default_view.rviz'), 'nav2.rviz');
    const names = displayNames(app);
    const other = new AppStore(fakeBridge());
    other.loadConfigText(app.saveConfigText(), 'copy.rviz');
    expect(displayNames(other)).toEqual(names);
  });
});

describe('AppStore.loadStartupConfig', () => {
  it('loads the -d file from the server and remembers the server as source', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(fixture('mock_scene.rviz'), { status: 200 })));
    const app = new AppStore(fakeBridge());
    await app.loadStartupConfig('/robot/cfg/mock_scene.rviz');
    expect(app.configName()).toBe('mock_scene.rviz');
    expect(app.source()).toEqual({ kind: 'server', path: '/robot/cfg/mock_scene.rviz' });
    expect(displayNames(app)).toContain('Livox');
  });

  it('falls back to the embedded default when the server has no config or fails', async () => {
    const app = new AppStore(fakeBridge());
    await app.loadStartupConfig(null);
    expect(app.configName()).toBe('default.rviz');
    expect(app.source()).toEqual({ kind: 'embedded' });

    vi.stubGlobal('fetch', vi.fn(async () => new Response('cannot read', { status: 404 })));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await app.loadStartupConfig('/missing.rviz');
    expect(app.source()).toEqual({ kind: 'embedded' });
    expect(displayNames(app)).toEqual(['Grid']);
  });

  it('does not overwrite a config the user opened before the server said hello, unless forced', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(fixture('default.rviz'), { status: 200 })));
    const app = new AppStore(fakeBridge());
    app.loadConfigText(fixture('mock_scene.rviz'), 'mine.rviz');
    app.setSource({ kind: 'download', name: 'mine.rviz' });

    await app.loadStartupConfig('/cfg/default.rviz');
    expect(app.configName()).toBe('mine.rviz');
    expect(displayNames(app)).toContain('Livox');

    await app.loadStartupConfig('/cfg/default.rviz', { force: true });
    expect(app.configName()).toBe('default.rviz');
    expect(app.source()).toEqual({ kind: 'server', path: '/cfg/default.rviz' });
  });
});
