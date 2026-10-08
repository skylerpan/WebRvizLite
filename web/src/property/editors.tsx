import { For, Show, createMemo, createUniqueId } from 'solid-js';
import type { JSX } from 'solid-js';
import type { Property, Rgb, StatusLevel, Xyz, Xyzw } from './types';
import type { EnumPropertyImpl, RosTopicPropertyImpl, StatusPropertyImpl, TfFramePropertyImpl } from './Property';
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
    case 'editable_enum':
      return <TextEditor value={() => p.value() as string} commit={(v) => p.setValue(v, 'user')} options={() => (p as TfFramePropertyImpl).options()} />;
    case 'ros_topic': {
      const topic = p as RosTopicPropertyImpl;
      const bridge = getBridge();
      const options = createMemo(() =>
        bridge.topics().filter((t) => topic.messageTypes.length === 0 || t.types.some((ty) => topic.messageTypes.includes(ty))).map((t) => t.name),
      );
      return <TextEditor value={() => topic.value()} commit={(v) => topic.setValue(v, 'user')} options={options} />;
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

function TextEditor(props: { value: () => string; commit: (v: string) => boolean; options?: () => readonly string[] }) {
  const listId = createUniqueId();
  return (
    <>
      <input
        class="wrl-edit"
        type="text"
        list={props.options ? listId : undefined}
        value={props.value()}
        onChange={(e) => { if (!props.commit(e.currentTarget.value)) e.currentTarget.value = props.value(); }}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.currentTarget.value = props.value(); e.currentTarget.blur(); } }}
      />
      <Show when={props.options}>
        <datalist id={listId}><For each={props.options!()}>{(o) => <option value={o} />}</For></datalist>
      </Show>
    </>
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
