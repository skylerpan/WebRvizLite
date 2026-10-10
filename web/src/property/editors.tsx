import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import type { JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { Property, Rgb, StatusLevel, Xyz, Xyzw } from './types';
import { TfFramePropertyImpl, type EnumPropertyImpl, type RosTopicPropertyImpl, type StatusPropertyImpl } from './Property';
import { colorToHex, parseColor, printColor } from './color';
import { getBridge } from '../app/bridge';

/** Renders the value column for one property row; picks the editor by kind. */
export function ValueCell(props: { prop: Property }): JSX.Element {
  const p = props.prop;
  // Display rows carry their checkbox in the name column (rviz), nothing in the value column.
  if ('classId' in p && 'status' in p) return <span />;
  if (p.readOnly() && p.kind !== 'status' && p.kind !== 'status_list') return <span class="wrl-cell-text">{display(p)}</span>;
  switch (p.kind) {
    case 'group':
    case 'status_list':
      return <span />;
    case 'status':
      return <span class={`wrl-status-${(p as StatusPropertyImpl).level()}`}>{String(p.value())}</span>;
    case 'bool':
      return <input type="checkbox" checked={p.value() as boolean} onChange={(e) => p.setValue(e.currentTarget.checked, 'user')} />;
    case 'int':
    case 'float':
      return <NumberEditor prop={p as Property<number>} integer={p.kind === 'int'} />;
    case 'string':
      return <TextEditor value={() => p.value() as string} commit={(v) => p.setValue(v, 'user')} />;
    case 'enum':
      return <EnumEditor prop={p as EnumPropertyImpl} />;
    case 'editable_enum': {
      // TF frame properties list every frame of the tf buffer; other editable enums (QoS) keep their fixed options.
      const options = p instanceof TfFramePropertyImpl ? () => p.frameOptions() : () => (p as EnumPropertyImpl).options();
      return <ComboEditor value={() => p.value() as string} commit={(v) => p.setValue(v, 'user')} options={options} />;
    }
    case 'ros_topic': {
      const topic = p as RosTopicPropertyImpl;
      const bridge = getBridge();
      const options = createMemo(() =>
        bridge.topics().filter((t) => topic.messageTypes.length === 0 || t.types.some((ty) => topic.messageTypes.includes(ty))).map((t) => t.name),
      );
      return <ComboEditor value={() => topic.value()} commit={(v) => topic.setValue(v, 'user')} options={options} />;
    }
    case 'color':
      return <ColorEditor prop={p as Property<Rgb>} />;
    case 'vector':
      return <TextEditor value={() => fmtXyz(p.value() as Xyz)} commit={(v) => { const n = parseNums(v, 3); return n ? p.setValue({ x: n[0], y: n[1], z: n[2] }, 'user') : false; }} />;
    case 'quaternion':
      return <TextEditor value={() => fmtXyzw(p.value() as Xyzw)} commit={(v) => { const n = parseNums(v, 4); return n ? p.setValue({ x: n[0], y: n[1], z: n[2], w: n[3] }, 'user') : false; }} />;
    default:
      return <span class="wrl-cell-text">{display(p)}</span>;
  }
}

const fmtNum = (n: number) => (Number.isInteger(n) ? String(n) : String(+n.toPrecision(6)));
const fmtXyz = (v: Xyz) => `${fmtNum(v.x)}; ${fmtNum(v.y)}; ${fmtNum(v.z)}`;
const fmtXyzw = (v: Xyzw) => `${fmtNum(v.x)}; ${fmtNum(v.y)}; ${fmtNum(v.z)}; ${fmtNum(v.w)}`;

function parseNums(text: string, n: number): number[] | null {
  const parts = text.split(/[;,\s]+/).filter(Boolean).map(Number);
  return parts.length === n && parts.every(Number.isFinite) ? parts : null;
}

/** Read-only textual form of any value. */
export function display(p: Property): string {
  const v = p.value();
  switch (p.kind) {
    case 'color': return printColor(v as Rgb);
    case 'vector': return fmtXyz(v as Xyz);
    case 'quaternion': return fmtXyzw(v as Xyzw);
    case 'float': case 'int': return fmtNum(v as number);
    case 'group': case 'status_list': return '';
    default: return v === undefined ? '' : String(v);
  }
}

export const STATUS_COLOR: Record<StatusLevel, string> = { ok: '#6cc070', warn: '#e0b050', error: '#e06060' };

function NumberEditor(props: { prop: Property<number>; integer: boolean }) {
  return (
    <input
      class="wrl-edit"
      type="number"
      step={props.integer ? 1 : 'any'}
      value={fmtNum(props.prop.value())}
      onChange={(e) => {
        const n = Number(e.currentTarget.value);
        if (!props.prop.setValue(n, 'user')) e.currentTarget.value = fmtNum(props.prop.value());
        else e.currentTarget.value = fmtNum(props.prop.value()); // show clamped value
      }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
    />
  );
}

function TextEditor(props: { value: () => string; commit: (v: string) => boolean }) {
  return (
    <input
      class="wrl-edit"
      type="text"
      value={props.value()}
      onChange={(e) => { if (!props.commit(e.currentTarget.value)) e.currentTarget.value = props.value(); }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.currentTarget.value = props.value(); e.currentTarget.blur(); } }}
    />
  );
}

const COMBO_ROWS = 10;
const COMBO_ROW_PX = 22;

/**
 * rviz's editable QComboBox: free text plus a ▾ that lists *every* option
 * (a native datalist only shows entries matching the typed text, so with a
 * value in the field it looked empty). The list is a fixed-position popup
 * portalled to <body>, so the panel's overflow and dockview do not clip it.
 */
export function ComboEditor(props: { value: () => string; commit: (v: string) => boolean; options: () => readonly string[] }) {
  let input!: HTMLInputElement;
  let button!: HTMLButtonElement;
  let popup: HTMLDivElement | undefined;
  const [open, setOpen] = createSignal(false);
  const [highlight, setHighlight] = createSignal(-1);
  const [place, setPlace] = createSignal({ left: 0, top: 0, bottom: 0, width: 0, above: false });

  const reposition = () => {
    const r = input.getBoundingClientRect();
    const maxHeight = COMBO_ROWS * COMBO_ROW_PX + 6;
    const above = r.bottom + maxHeight > window.innerHeight && r.top > maxHeight;
    setPlace({ left: r.left, top: r.bottom, bottom: window.innerHeight - r.top, width: Math.max(r.width + button.offsetWidth, 160), above });
  };
  const show = () => {
    reposition();
    setHighlight(props.options().indexOf(props.value()));
    setOpen(true);
    input.focus(); // keyboard (arrows / Enter / Escape) works after opening with the mouse too
  };
  const hide = () => setOpen(false);
  const choose = (v: string) => {
    hide();
    props.commit(v);
    input.value = props.value();
  };

  createEffect(() => {
    if (!open()) return;
    const inside = (t: EventTarget | null) => t instanceof Node && (popup?.contains(t) || input.contains(t) || button.contains(t));
    const onPointerDown = (e: PointerEvent) => { if (!inside(e.target)) hide(); };
    const onScroll = (e: Event) => { if (!(e.target instanceof Node && popup?.contains(e.target))) hide(); };
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', hide);
    onCleanup(() => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', hide);
    });
  });

  const onKeyDown = (e: KeyboardEvent) => {
    const n = props.options().length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open()) return show();
      if (n) setHighlight((h) => (h + (e.key === 'ArrowDown' ? 1 : -1) + n) % n);
    } else if (e.key === 'Enter') {
      if (open() && highlight() >= 0 && highlight() < n) {
        e.preventDefault();
        choose(props.options()[highlight()]!);
      } else input.blur();
    } else if (e.key === 'Escape') {
      if (open()) hide();
      else { input.value = props.value(); input.blur(); }
    }
  };

  return (
    <span class="wrl-combo">
      <input
        ref={input}
        class="wrl-edit"
        type="text"
        role="combobox"
        aria-expanded={open()}
        value={props.value()}
        onChange={(e) => { if (!props.commit(e.currentTarget.value)) e.currentTarget.value = props.value(); }}
        onKeyDown={onKeyDown}
      />
      <button
        ref={button}
        type="button"
        class="wrl-combo-btn"
        tabIndex={-1}
        title="Show all options"
        aria-label="Show all options"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => (open() ? hide() : show())}
      >
        ▾
      </button>
      <Show when={open()}>
        <Portal>
          <div
            ref={popup}
            class="wrl-combo-popup"
            role="listbox"
            style={place().above
              ? { left: `${place().left}px`, bottom: `${place().bottom}px`, width: `${place().width}px` }
              : { left: `${place().left}px`, top: `${place().top}px`, width: `${place().width}px` }}
            onMouseDown={(e) => e.preventDefault()}
          >
            <Show when={props.options().length} fallback={<div class="wrl-combo-option wrl-combo-empty">(none)</div>}>
              <For each={props.options()}>
                {(o, i) => (
                  <div
                    class="wrl-combo-option"
                    role="option"
                    aria-selected={o === props.value()}
                    classList={{ 'wrl-combo-option-current': o === props.value(), 'wrl-combo-option-highlight': i() === highlight() }}
                    onMouseEnter={() => setHighlight(i())}
                    onClick={() => choose(o)}
                  >
                    {o}
                  </div>
                )}
              </For>
            </Show>
          </div>
        </Portal>
      </Show>
    </span>
  );
}

function EnumEditor(props: { prop: EnumPropertyImpl }) {
  return (
    <select class="wrl-edit" value={props.prop.value()} onChange={(e) => props.prop.setValue(e.currentTarget.value, 'user')}>
      <For each={props.prop.options()}>{(o) => <option value={o} selected={o === props.prop.value()}>{o}</option>}</For>
    </select>
  );
}

function ColorEditor(props: { prop: Property<Rgb> }) {
  return (
    <span class="wrl-color-edit">
      <label class="wrl-swatch" style={{ background: colorToHex(props.prop.value()) }} title="Pick colour">
        <input type="color" value={colorToHex(props.prop.value())} onInput={(e) => { const c = parseColor(e.currentTarget.value); if (c) props.prop.setValue(c, 'user'); }} />
      </label>
      <TextEditor value={() => printColor(props.prop.value())} commit={(v) => { const c = parseColor(v); return c ? props.prop.setValue(c, 'user') : false; }} />
    </span>
  );
}
