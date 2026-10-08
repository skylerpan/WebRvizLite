/**
 * Virtualized two-column property tree (name | value), the equivalent of
 * rviz_common's PropertyTreeWidget. Only rows in view are rendered, so TF
 * frame lists or RobotModel links with hundreds of rows stay cheap.
 */

import { For, Show, createMemo, createSignal, onCleanup, onMount, type Accessor, type JSX } from 'solid-js';
import type { Property, StatusLevel } from './types';
import { STATUS_COLOR, ValueCell } from './editors';
import type { Display } from '../displays/types';

export interface Row {
  prop: Property;
  depth: number;
  /** rviz expanded-entry path, e.g. "/Grid1/Line Style1". */
  path: string;
  hasChildren: boolean;
}

const ROW_HEIGHT = 22;
const OVERSCAN = 6;

const isDisplay = (p: Property): p is Display => 'classId' in p && 'status' in p;

/**
 * Expansion state: the set of expanded Property objects, plus config paths not
 * yet resolved to a property (their node has not appeared yet, e.g. TF frames).
 */
export class ExpandedState {
  readonly props = new Set<Property>();
  readonly pending = new Set<string>();
  readonly version: Accessor<number>;
  private readonly bump: () => void;
  constructor(paths: string[] = []) {
    const [v, setV] = createSignal(0);
    this.version = v;
    this.bump = () => setV(v() + 1);
    this.load(paths);
  }
  load(paths: string[]) {
    this.props.clear();
    this.pending.clear();
    for (const p of paths) this.pending.add(p);
    this.bump();
  }
  has(prop: Property, path: string): boolean {
    if (this.pending.has(path)) {
      this.pending.delete(path);
      this.props.add(prop);
    }
    return this.props.has(prop);
  }
  toggle(prop: Property) {
    if (this.props.has(prop)) this.props.delete(prop);
    else this.props.add(prop);
    this.bump();
  }
  /** rviz PropertyTreeWidget::saveExpandedEntries: paths of expanded nodes over the whole tree. */
  paths(root: Property): string[] {
    const out: string[] = [...this.pending];
    const walk = (parent: Property, prefix: string) => {
      const counts = new Map<string, number>();
      for (const child of parent.children()) {
        const name = child.pathName();
        const n = (counts.get(name) ?? 0) + 1;
        counts.set(name, n);
        const path = `${prefix}/${name}${n}`;
        if (this.props.has(child)) out.push(path);
        walk(child, path);
      }
    };
    walk(root, '');
    return out;
  }
}

/** Flattens visible rows depth-first, numbering duplicate names like rviz. */
export function flattenRows(parent: Property, expanded: ExpandedState, prefix = '', depth = 0, out: Row[] = []): Row[] {
  const counts = new Map<string, number>();
  for (const child of parent.children()) {
    const name = child.pathName();
    const n = (counts.get(name) ?? 0) + 1;
    counts.set(name, n);
    const path = `${prefix}/${name}${n}`;
    if (child.hidden()) continue;
    const hasChildren = child.children().some((c) => !c.hidden());
    out.push({ prop: child, depth, path, hasChildren });
    if (hasChildren && expanded.has(child, path)) flattenRows(child, expanded, path, depth + 1, out);
  }
  return out;
}

export interface PropertyTreeProps {
  root: Property;
  expanded: ExpandedState;
  splitterRatio: Accessor<number>;
  setSplitterRatio: (r: number) => void;
  selected: Accessor<Property | null>;
  onSelect: (p: Property | null) => void;
}

export function PropertyTree(props: PropertyTreeProps): JSX.Element {
  let scroller!: HTMLDivElement;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportHeight, setViewportHeight] = createSignal(400);
  const [width, setWidth] = createSignal(300);

  const rows = createMemo(() => {
    props.expanded.version();
    return flattenRows(props.root, props.expanded);
  });
  const first = createMemo(() => Math.max(0, Math.floor(scrollTop() / ROW_HEIGHT) - OVERSCAN));
  const last = createMemo(() => Math.min(rows().length, Math.ceil((scrollTop() + viewportHeight()) / ROW_HEIGHT) + OVERSCAN));
  const visible = createMemo(() => rows().slice(first(), last()));

  onMount(() => {
    const ro = new ResizeObserver(() => {
      setViewportHeight(scroller.clientHeight);
      setWidth(scroller.clientWidth);
    });
    ro.observe(scroller);
    onCleanup(() => ro.disconnect());
  });

  const toggle = (row: Row) => props.expanded.toggle(row.prop);

  const startSplitterDrag = (e: PointerEvent) => {
    e.preventDefault();
    const move = (ev: PointerEvent) => {
      const rect = scroller.getBoundingClientRect();
      props.setSplitterRatio(Math.min(0.9, Math.max(0.1, (ev.clientX - rect.left) / rect.width)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const nameWidth = () => Math.round(width() * props.splitterRatio());

  return (
    <div class="wrl-tree" ref={scroller} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} tabIndex={0}>
      <div class="wrl-tree-inner" style={{ height: `${rows().length * ROW_HEIGHT}px` }}>
        <For each={visible()}>
          {(row, i) => (
            <TreeRow
              row={row}
              top={(first() + i()) * ROW_HEIGHT}
              nameWidth={nameWidth()}
              expanded={props.expanded.props.has(row.prop)}
              selected={props.selected() === row.prop}
              onToggle={() => toggle(row)}
              onSelect={() => props.onSelect(row.prop)}
            />
          )}
        </For>
      </div>
      <div class="wrl-splitter" style={{ left: `${nameWidth()}px` }} onPointerDown={startSplitterDrag} />
    </div>
  );
}

function TreeRow(props: { row: Row; top: number; nameWidth: number; expanded: boolean; selected: boolean; onToggle: () => void; onSelect: () => void }) {
  const p = () => props.row.prop;
  const display = () => (isDisplay(p()) ? (p() as Display) : null);
  const level = (): StatusLevel | null => display()?.status.level() ?? null;
  return (
    <div
      class="wrl-row"
      classList={{ 'wrl-row-selected': props.selected, 'wrl-row-display': display() !== null }}
      style={{ top: `${props.top}px`, height: `${ROW_HEIGHT}px` }}
      onMouseDown={props.onSelect}
    >
      <div class="wrl-cell wrl-cell-name" style={{ width: `${props.nameWidth}px`, 'padding-left': `${4 + props.row.depth * 14}px` }}>
        <span class="wrl-expander" classList={{ 'wrl-expander-hidden': !props.row.hasChildren }} onClick={(e) => { e.stopPropagation(); props.onToggle(); }}>
          {props.row.hasChildren ? (props.expanded ? '▾' : '▸') : ''}
        </span>
        <Show when={display()}>
          {(d) => (
            <>
              <input type="checkbox" checked={d().enabled()} onChange={(e) => d().setEnabled(e.currentTarget.checked)} onMouseDown={(e) => e.stopPropagation()} />
              <span class="wrl-status-dot" style={{ background: STATUS_COLOR[level()!] }} title={d().status.name()} />
            </>
          )}
        </Show>
        <Show when={p().kind === 'status'}>
          <span class="wrl-status-dot" style={{ background: STATUS_COLOR[(p() as unknown as { level: () => StatusLevel }).level()] }} />
        </Show>
        <span class="wrl-name" title={p().description}>{p().name()}</span>
      </div>
      <div class="wrl-cell wrl-cell-value" style={{ left: `${props.nameWidth}px` }} onMouseDown={(e) => e.stopPropagation()}>
        <ValueCell prop={p()} />
      </div>
    </div>
  );
}
