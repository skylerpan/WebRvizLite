/**
 * rviz_common AddDisplayDialog: "By display type" lists every registered
 * Display grouped by package; "By topic" lists graph topics that have a
 * matching Display (a topic can offer several). A display name can be typed.
 */

import { For, Show, createMemo, createSignal, type JSX } from 'solid-js';
import { getApp } from '../app/store';
import type { DisplayClassInfo } from '../displays/types';

export interface AddDisplayResult {
  classId: string;
  name: string;
  topic?: string;
}

export function AddDisplayDialog(props: { onClose: (result: AddDisplayResult | null) => void }): JSX.Element {
  const app = getApp();
  const registry = app.manager.registry;
  const [tab, setTab] = createSignal<'type' | 'topic'>('type');
  const [selected, setSelected] = createSignal<{ info: DisplayClassInfo; topic?: string } | null>(null);
  const [name, setName] = createSignal('');
  const [nameEdited, setNameEdited] = createSignal(false);

  const byPackage = createMemo(() => {
    const groups = new Map<string, DisplayClassInfo[]>();
    for (const info of registry.all()) {
      const pkg = info.classId.split('/')[0];
      const list = groups.get(pkg) ?? [];
      list.push(info);
      groups.set(pkg, list);
    }
    return [...groups.entries()].map(([pkg, list]) => ({ pkg, list: list.sort((a, b) => a.name.localeCompare(b.name)) }));
  });

  const byTopic = createMemo(() => {
    const out: { topic: string; type: string; displays: DisplayClassInfo[] }[] = [];
    for (const t of app.bridge.topics()) {
      for (const type of t.types) {
        const displays = registry.all().filter((d) => d.messageTypes.includes(type));
        if (displays.length) out.push({ topic: t.name, type, displays });
      }
    }
    return out.sort((a, b) => a.topic.localeCompare(b.topic));
  });

  const choose = (info: DisplayClassInfo, topic?: string) => {
    setSelected({ info, topic });
    if (!nameEdited()) setName(info.name);
  };

  const ok = () => {
    const s = selected();
    if (!s) return;
    props.onClose({ classId: s.info.classId, name: name() || s.info.name, topic: s.topic });
  };

  return (
    <div class="wrl-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(null); }}>
      <div class="wrl-modal" role="dialog" aria-label="Add Display">
        <div class="wrl-modal-title">Add Display</div>
        <div class="wrl-tabs">
          <button type="button" classList={{ 'wrl-tab-active': tab() === 'type' }} onClick={() => setTab('type')}>By display type</button>
          <button type="button" classList={{ 'wrl-tab-active': tab() === 'topic' }} onClick={() => setTab('topic')}>By topic</button>
        </div>
        <div class="wrl-modal-body">
          <Show when={tab() === 'type'}>
            <div class="wrl-add-list">
              <For each={byPackage()}>
                {(g) => (
                  <>
                    <div class="wrl-add-pkg">{g.pkg}</div>
                    <For each={g.list}>
                      {(info) => (
                        <button type="button" class="wrl-add-item" classList={{ 'wrl-add-selected': selected()?.info === info && !selected()?.topic }} onClick={() => choose(info)} onDblClick={() => { choose(info); ok(); }}>
                          {info.name}
                        </button>
                      )}
                    </For>
                  </>
                )}
              </For>
            </div>
          </Show>
          <Show when={tab() === 'topic'}>
            <div class="wrl-add-list">
              <Show when={byTopic().length === 0}><div class="wrl-dim" style={{ padding: '8px' }}>No topics with a matching display.</div></Show>
              <For each={byTopic()}>
                {(t) => (
                  <>
                    <div class="wrl-add-pkg">{t.topic} <span class="wrl-dim">({t.type})</span></div>
                    <For each={t.displays}>
                      {(info) => (
                        <button type="button" class="wrl-add-item" classList={{ 'wrl-add-selected': selected()?.info === info && selected()?.topic === t.topic }} onClick={() => choose(info, t.topic)} onDblClick={() => { choose(info, t.topic); ok(); }}>
                          {info.name}
                        </button>
                      )}
                    </For>
                  </>
                )}
              </For>
            </div>
          </Show>
          <div class="wrl-add-desc">{selected()?.info.description ?? 'Select a display type.'}</div>
        </div>
        <div class="wrl-modal-row">
          <label>Display Name <input type="text" class="wrl-edit wrl-modal-input" value={name()} onInput={(e) => { setName(e.currentTarget.value); setNameEdited(true); }} /></label>
        </div>
        <div class="wrl-modal-buttons">
          <button type="button" onClick={() => props.onClose(null)}>Cancel</button>
          <button type="button" disabled={!selected()} onClick={ok}>OK</button>
        </div>
      </div>
    </div>
  );
}
