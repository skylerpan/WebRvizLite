import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import type { PanelProps } from './solidPanel';
import { DEFAULT_QOS, type Durability, type QosProfile, type Reliability } from '../worker/messages';
import { getBridge } from '../app/bridge';

/**
 * M1 debug panel: topic graph with per-topic subscribe toggles and receive rates.
 * Not an RViz panel; opened with `?debug` or from the Panels menu later.
 */
export function DebugPanel(_props: PanelProps) {
  const bridge = getBridge();
  const [reliability, setReliability] = createSignal<Reliability>('reliable');
  const [durability, setDurability] = createSignal<Durability>('volatile');
  // topic name → subscription id owned by this panel
  const [subs, setSubs] = createSignal<Map<string, number>>(new Map());

  onMount(() => {
    bridge.enableStats(true);
    bridge.listTopics();
  });
  onCleanup(() => {
    bridge.enableStats(false);
    for (const id of subs().values()) bridge.unsubscribe(id);
  });

  const statsById = createMemo(() => new Map(bridge.stats().map((s) => [s.id, s])));

  const toggle = (topic: string, type: string) => {
    const m = new Map(subs());
    const existing = m.get(topic);
    if (existing !== undefined) {
      bridge.unsubscribe(existing);
      m.delete(topic);
    } else {
      const qos: QosProfile = { ...DEFAULT_QOS, reliability: reliability(), durability: durability() };
      m.set(topic, bridge.subscribe(topic, type, qos));
    }
    setSubs(m);
  };

  const fmtRate = (hz: number) => (hz >= 10 ? hz.toFixed(0) : hz.toFixed(1));
  const fmtBytes = (b: number) => (b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(2)} MB` : b >= 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} B`);

  return (
    <div class="wrl-debug">
      <div class="wrl-debug-toolbar">
        <button type="button" onClick={() => bridge.listTopics()}>Refresh topics</button>
        <label>
          Subscribe as
          <select value={reliability()} onChange={(e) => setReliability(e.currentTarget.value as Reliability)}>
            <option value="reliable">Reliable</option>
            <option value="best_effort">Best Effort</option>
          </select>
          <select value={durability()} onChange={(e) => setDurability(e.currentTarget.value as Durability)}>
            <option value="volatile">Volatile</option>
            <option value="transient_local">Transient Local</option>
          </select>
        </label>
        <span class="wrl-debug-info">
          <Show when={bridge.hello()} fallback="not connected">
            {(h) => <>server v{h().version} · {h().mock ? 'mock' : h().ros_distro ?? 'ros'} · sim time {h().use_sim_time ? 'on' : 'off'}</>}
          </Show>
          {' · wasm memory '}{fmtBytes(bridge.wasmBytes())}
        </span>
        <Show when={bridge.lastError()}>{(e) => <span class="wrl-status-err">{e()}</span>}</Show>
      </div>
      <table class="wrl-debug-table">
        <thead>
          <tr><th></th><th>Topic</th><th>Type</th><th>Hz</th><th>Rate</th><th>Last</th><th>Msgs</th><th>Dropped</th><th>Via</th><th>Status</th></tr>
        </thead>
        <tbody>
          <For each={bridge.topics()}>
            {(t) => {
              const type = () => t.types[0] ?? '';
              const id = () => subs().get(t.name);
              const st = () => (id() === undefined ? undefined : statsById().get(id()!));
              return (
                <tr>
                  <td><input type="checkbox" checked={id() !== undefined} onChange={() => toggle(t.name, type())} /></td>
                  <td>{t.name}</td>
                  <td class="wrl-dim">{t.types.join(', ')}</td>
                  <td class="wrl-num">{st() ? fmtRate(st()!.hz) : ''}</td>
                  <td class="wrl-num">{st() ? `${fmtBytes(st()!.bps)}/s` : ''}</td>
                  <td class="wrl-num">{st() ? fmtBytes(st()!.lastBytes) : ''}</td>
                  <td class="wrl-num">{st() ? st()!.messages : ''}</td>
                  <td class="wrl-num">{st() ? st()!.dropped : ''}</td>
                  <td>{st()?.via ?? ''}</td>
                  <td>{st()?.error ? <span class="wrl-status-err">{st()!.error}</span> : st() ? <span class="wrl-status-ok">ok</span> : ''}</td>
                </tr>
              );
            }}
          </For>
        </tbody>
      </table>
      <div class="wrl-debug-toolbar wrl-dim">
        Worker-owned: <For each={bridge.stats().filter((s) => s.id < 1000)}>{(s) => <span>{s.topic} {fmtRate(s.hz)} Hz ({s.messages} msgs){s.error ? ` ERROR ${s.error}` : ''} · </span>}</For>
      </div>
    </div>
  );
}
