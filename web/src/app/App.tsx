import { For, Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import { PANEL_TITLES, createLayout } from './layout';
import { getApp } from './store';
import { MenuButton, type MenuItem } from './Menu';
import { AddDisplayDialog } from '../panels/AddDisplayDialog';
import { openConfig, openRecent, recentConfigs, saveConfig, saveConfigAs } from './configIO';
import { SHORTCUTS, installShortcuts, type ShortcutScope } from './shortcuts';
import { longFrames, measuredFps, renderBackend, resetPerfCounters, toolStatus, worstFrameMs } from '../render/Renderer';
import { perfSummary, resetPerf } from '../render/perf';

export function App() {
  let dockEl!: HTMLDivElement;
  const app = getApp();
  const bridge = app.bridge;
  const layout = app.layout;
  const [layoutVersion, setLayoutVersion] = createSignal(0);

  onMount(() => {
    const l = createLayout(dockEl, { debug: new URLSearchParams(location.search).has('debug') });
    app.setLayout(l);
    app.applyLayoutFromConfig();
    const sub = l.api.onDidLayoutChange(() => setLayoutVersion(layoutVersion() + 1));
    if (import.meta.env.DEV) {
      // Debug handle for the dev console / automated checks; stripped from production builds.
      (window as unknown as { __wrl?: unknown }).__wrl = { layout: l, bridge, app };
    }
    onCleanup(() => {
      sub.dispose();
      app.setLayout(null);
      l.dispose();
    });
  });

  // Load the startup config once the server told us whether `-d` was given.
  let configLoaded = false;
  createEffect(() => {
    const hello = bridge.hello();
    if (hello && !configLoaded) {
      configLoaded = true;
      void app.loadStartupConfig(hello.display_config);
    }
  });

  const report = (what: string, p: Promise<unknown>) => p.catch((e) => { console.error(`[${what}]`, e); alert(`${what} failed: ${String(e)}`); });

  const actions: Record<string, () => void> = {
    open: () => report('Open Config', openConfig(app)),
    save: () => report('Save Config', saveConfig(app)),
    saveAs: () => report('Save Config As', saveConfigAs(app)),
    fullscreen: () => { if (document.fullscreenElement) void document.exitFullscreen(); else void document.documentElement.requestFullscreen(); },
    addDisplay: () => app.setDialog('addDisplay'),
    duplicateDisplay: () => void app.duplicateSelected(),
    removeDisplay: () => void app.removeSelected(),
    removeDisplayAlt: () => void app.removeSelected(),
    renameDisplay: () => {
      const d = app.selectedDisplay();
      if (!d) return;
      const name = window.prompt('Display name', d.name());
      if (name !== null) app.renameSelected(name);
    },
  };

  onMount(() => {
    const dispose = installShortcuts(
      (id) => {
        const fn = actions[id];
        if (!fn) return false;
        fn();
        return true;
      },
      () => {
        const scopes: ShortcutScope[] = ['global'];
        const active = document.activeElement;
        if (active?.closest('[data-displays-panel]')) scopes.push('displays');
        return scopes;
      },
    );
    onCleanup(dispose);
  });

  const fileMenu = (): MenuItem[] => [
    { label: 'Open Config…', shortcut: 'Ctrl+O', onSelect: actions.open },
    { label: 'Save Config', shortcut: 'Ctrl+S', onSelect: actions.save },
    { label: 'Save Config As…', shortcut: 'Ctrl+Shift+S', onSelect: actions.saveAs },
    {
      label: 'Recent Configs',
      children: recentConfigs().length
        ? recentConfigs().map((r) => ({ label: r.name, onSelect: () => report('Open recent', openRecent(app, r)) }))
        : [{ label: '(none)', disabled: true }],
    },
    { separator: true, label: '' },
    { label: 'Fullscreen', shortcut: 'F11', checked: !!document.fullscreenElement, onSelect: actions.fullscreen },
  ];

  const panelsMenu = (): MenuItem[] => {
    layoutVersion();
    const l = layout();
    const items: MenuItem[] = [{ label: 'Add New Panel', children: Object.entries(PANEL_TITLES).map(([id, title]) => ({ label: title, onSelect: () => l?.showPanel(id, title) })) }];
    items.push({ separator: true, label: '' });
    for (const [id, title] of Object.entries(PANEL_TITLES)) {
      const open = !!l?.api.getPanel(id);
      items.push({ label: title, checked: open, onSelect: () => (open ? l?.api.getPanel(id)?.api.close() : l?.showPanel(id, title)) });
    }
    items.push({ separator: true, label: '' });
    items.push({ label: 'Reset Layout', onSelect: () => l?.buildDefault(app.config.panels().length ? app.config.panels() : null) });
    return items;
  };

  const helpMenu = (): MenuItem[] => [{ label: 'About', onSelect: () => app.setDialog('about') }];

  const serverLabel = () => {
    const h = bridge.hello();
    if (!h) return '';
    return ` (v${h.version}, ${h.mock ? 'mock' : h.ros_distro ?? 'ros'})`;
  };


  return (
    <div class="wrl-app">
      <div class="wrl-menubar" role="menubar">
        <MenuButton label="File" items={fileMenu} />
        <MenuButton label="Panels" items={panelsMenu} />
        <MenuButton label="Help" items={helpMenu} />
        <span class="wrl-dim wrl-config-name">{app.configName()}</span>
      </div>
      <div class="wrl-toolbar" role="toolbar">
        <span class="wrl-toolbar-label">Tools</span>
        <For each={app.manager.tools.tools()}>
          {(tool) => (
            <button
              type="button"
              classList={{ 'wrl-tool-active': app.manager.tools.current() === tool }}
              disabled={!tool.available}
              title={tool.available ? `${tool.name()} (${tool.shortcut}) — right-click to remove` : `${tool.name()}: not available in WebRvizLite yet — right-click to remove`}
              onClick={() => app.manager.tools.setCurrent(tool)}
              onContextMenu={(e) => { e.preventDefault(); if (confirm(`Remove tool "${tool.name()}" from the toolbar?`)) app.manager.tools.removeTool(tool); }}
            >
              {tool.name()}
            </button>
          )}
        </For>
        <button type="button" title="Add a new tool" onClick={() => app.setDialog('addTool')}>+</button>
      </div>
      <div class="wrl-dock" ref={dockEl} />
      <div class="wrl-statusbar">
        <Show when={toolStatus()}><span class="wrl-tool-status" innerHTML={toolStatus()} /></Show>
        <span>Renderer: {renderBackend()} · {measuredFps()} FPS</span>
        <Show when={new URLSearchParams(location.search).has('perf')}>
          <span title="frames whose update+render took >16 ms / worst frame" onClick={() => { resetPerfCounters(); resetPerf(); }} style={{ cursor: 'pointer' }}>
            long frames: {longFrames()} · worst {worstFrameMs()} ms (click to reset)
          </span>
          <span class="wrl-dim" title="worst time per section × calls since reset">{perfSummary()}</span>
        </Show>
        <span>WASM: {bridge.wasmVersion() ?? '…'}</span>
        <span classList={{
          'wrl-status-ok': bridge.wsState() === 'connected',
          'wrl-status-warn': bridge.wsState() === 'connecting',
          'wrl-status-err': bridge.wsState() === 'disconnected',
        }}>
          Server: {bridge.wsState()}{serverLabel()}
        </span>
        <span title={bridge.transport().detail ?? 'Transport of best-effort topics'} classList={{ 'wrl-status-ok': bridge.transport().wt === 'on', 'wrl-status-warn': bridge.transport().wt === 'connecting' }}>
          {bridge.transport().wt === 'on' ? 'WS+WT' : bridge.transport().wt === 'connecting' ? 'WS (WT…)' : 'WS'}
        </span>
        <Show when={bridge.clock()}>{(c) => <span>ROS time: {(Number(c().rosTimeNs / 1_000_000n) / 1000).toFixed(1)}</span>}</Show>
      </div>
      <Show when={app.dialog() === 'addDisplay'}>
        <AddDisplayDialog onClose={(r) => { app.setDialog(null); if (r) app.addDisplay(r.classId, r.name, r.topic); }} />
      </Show>
      <Show when={app.dialog() === 'addTool'}>
        <div class="wrl-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) app.setDialog(null); }}>
          <div class="wrl-modal" role="dialog" aria-label="Add Tool">
            <div class="wrl-modal-title">Add Tool</div>
            <div class="wrl-add-tool-list">
              <For each={app.manager.tools.classInfos()}>
                {(c) => (
                  <button type="button" onClick={() => { app.manager.tools.addTool(c.classId); app.setDialog(null); }} title={c.description}>
                    <b>{c.name}</b> <span class="wrl-dim">{c.classId}{c.shortcut ? ` (${c.shortcut})` : ''}</span>
                  </button>
                )}
              </For>
            </div>
            <div class="wrl-modal-buttons"><button type="button" onClick={() => app.setDialog(null)}>Cancel</button></div>
          </div>
        </div>
      </Show>
      <Show when={app.dialog() === 'about'}>
        <div class="wrl-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) app.setDialog(null); }}>
          <div class="wrl-modal" role="dialog" aria-label="About">
            <div class="wrl-modal-title">About WebRvizLite</div>
            <div class="wrl-about">
              <div>WebRvizLite — RViz 2 (lyrical) in the browser. Server v{bridge.hello()?.version ?? '?'}, WASM v{bridge.wasmVersion() ?? '?'}, renderer {renderBackend()}.</div>
              <table>
                <tbody>
                  <For each={SHORTCUTS}>{(s) => <tr><td><b>{s.keys}</b></td><td>{s.label}</td><td class="wrl-dim">RViz: {s.rviz}</td></tr>}</For>
                </tbody>
              </table>
            </div>
            <div class="wrl-modal-buttons"><button type="button" onClick={() => app.setDialog(null)}>Close</button></div>
          </div>
        </div>
      </Show>
    </div>
  );
}
