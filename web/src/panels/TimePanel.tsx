import { For, Show, createMemo } from 'solid-js';
import type { PanelProps } from './solidPanel';
import { getApp } from '../app/store';

/** rviz TimePanel sync modes (FrameManager::SyncMode); stored in the config, not effective here. */
export const SYNC_MODES = ['Off', 'Exact', 'Approximate', 'Frame Count'];

const secs = (ns: bigint) => (Number(ns / 1_000_000n) / 1000).toFixed(2);

/**
 * rviz_common/Time: ROS / wall clocks with elapsed times, Pause, and the
 * experimental synchronization controls.
 */
export function TimePanel(_props: PanelProps) {
  const app = getApp();
  const time = app.manager.time;
  const bridge = app.bridge;
  const state = app.timePanel;
  const set = (patch: Partial<ReturnType<typeof state>>) => app.setTimePanel({ ...state(), ...patch });

  const wallNs = createMemo(() => bridge.clock()?.wallTimeNs ?? 0n);
  const rosNs = () => time.rosTimeNs();
  const rosElapsed = () => secs(rosNs() - time.rosStartNs());
  const wallElapsed = () => secs(wallNs() - time.wallStartNs());

  return (
    <div class="wrl-time">
      <button type="button" classList={{ 'wrl-tool-active': time.paused() }} onClick={() => time.setPaused(!time.paused())} title="Freeze ROS time (and tf) for all displays">
        {time.paused() ? 'Paused' : 'Pause'}
      </button>
      <label>
        <input type="checkbox" checked={state().experimental} onChange={(e) => set({ experimental: e.currentTarget.checked })} /> Experimental
      </label>
      <Show when={state().experimental}>
        <label>
          Synchronization:
          <select class="wrl-edit" value={String(state().syncMode)} onChange={(e) => set({ syncMode: Number(e.currentTarget.value) })}>
            <For each={SYNC_MODES}>{(m, i) => <option value={String(i())}>{m}</option>}</For>
          </select>
        </label>
        <label>
          Source:
          <select class="wrl-edit" value={state().syncSource} onChange={(e) => set({ syncSource: e.currentTarget.value })}>
            <option value="">(none)</option>
            <For each={bridge.topics()}>{(t) => <option value={t.name}>{t.name}</option>}</For>
          </select>
        </label>
      </Show>
      <span class="wrl-time-field"><span class="wrl-dim">ROS Time:</span> <input readOnly value={secs(rosNs())} /></span>
      <span class="wrl-time-field"><span class="wrl-dim">ROS Elapsed:</span> <input readOnly value={rosElapsed()} /></span>
      <span class="wrl-time-field"><span class="wrl-dim">Wall Time:</span> <input readOnly value={secs(wallNs())} /></span>
      <span class="wrl-time-field"><span class="wrl-dim">Wall Elapsed:</span> <input readOnly value={wallElapsed()} /></span>
      <button type="button" onClick={() => time.resetElapsed()} title="Restart the elapsed counters">Reset</button>
    </div>
  );
}
