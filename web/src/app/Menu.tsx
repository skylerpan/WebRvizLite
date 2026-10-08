import { For, Show, createSignal, onCleanup, type JSX } from 'solid-js';

export interface MenuItem {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  checked?: boolean;
  onSelect?: () => void;
  /** Submenu items (rendered inline, indented). */
  children?: MenuItem[];
  separator?: boolean;
}

/** A menubar button with a dropdown (RViz's QMenuBar). Items are computed on open. */
export function MenuButton(props: { label: string; items: () => MenuItem[] }): JSX.Element {
  const [open, setOpen] = createSignal(false);
  let root!: HTMLDivElement;
  const onDocClick = (e: MouseEvent) => {
    if (!root.contains(e.target as Node)) setOpen(false);
  };
  document.addEventListener('mousedown', onDocClick);
  onCleanup(() => document.removeEventListener('mousedown', onDocClick));

  const renderItems = (items: MenuItem[], depth: number): JSX.Element => (
    <For each={items}>
      {(item) =>
        item.separator ? (
          <div class="wrl-menu-sep" />
        ) : (
          <>
            <button
              type="button"
              class="wrl-menu-item"
              classList={{ 'wrl-menu-sub': depth > 0 }}
              disabled={item.disabled || (!item.onSelect && !item.children)}
              onClick={() => {
                if (item.onSelect) {
                  setOpen(false);
                  item.onSelect();
                }
              }}
            >
              <span class="wrl-menu-check">{item.checked === undefined ? '' : item.checked ? '✓' : ''}</span>
              <span class="wrl-menu-label">{item.label}</span>
              <span class="wrl-menu-shortcut">{item.shortcut ?? ''}</span>
            </button>
            <Show when={item.children}>{(kids) => renderItems(kids(), depth + 1)}</Show>
          </>
        )
      }
    </For>
  );

  return (
    <div class="wrl-menu" ref={root}>
      <button type="button" classList={{ 'wrl-menu-open': open() }} onClick={() => setOpen(!open())}>
        {props.label}
      </button>
      <Show when={open()}>
        <div class="wrl-menu-dropdown">{renderItems(props.items(), 0)}</div>
      </Show>
    </div>
  );
}
