// @vitest-environment jsdom
/** Row flattening keeps Row objects stable across recomputes so the keyed <For> does not remount editors. */
import { describe, expect, it } from 'vitest';
import { ExpandedState, flattenRows, type Row } from './PropertyTree';
import { FloatPropertyImpl, GroupProperty, StatusListPropertyImpl } from './Property';

function tree() {
  const root = new GroupProperty('root', null);
  const grid = new GroupProperty('Grid', root);
  const status = new StatusListPropertyImpl('Status', grid);
  new FloatPropertyImpl('Alpha', 0.5, grid);
  const axes = new GroupProperty('Axes', root);
  new FloatPropertyImpl('Length', 1, axes);
  return { root, grid, status, axes };
}

const byPath = (rows: Row[]) => new Map(rows.map((r) => [r.path, r]));

describe('flattenRows reuse', () => {
  it('returns the same Row objects for unchanged rows', () => {
    const { root, grid } = tree();
    const expanded = new ExpandedState();
    expanded.toggle(grid);
    const first = flattenRows(root, expanded);
    const second = flattenRows(root, expanded, '', 0, [], byPath(first));
    expect(second.map((r) => r.path)).toEqual(first.map((r) => r.path));
    second.forEach((r, i) => expect(r).toBe(first[i]));
  });

  it('keeps sibling rows when a status row appears, and replaces only the row whose shape changed', () => {
    const { root, grid, status } = tree();
    const expanded = new ExpandedState();
    expanded.toggle(grid);
    const before = flattenRows(root, expanded);
    const alphaBefore = before.find((r) => r.path === '/Grid1/Alpha1')!;
    const statusBefore = before.find((r) => r.path === '/Grid1/Status1')!;
    expect(statusBefore.hasChildren).toBe(false);

    status.setStatus('error', 'Topic', 'no publisher');
    const after = flattenRows(root, expanded, '', 0, [], byPath(before));
    expect(after.find((r) => r.path === '/Grid1/Alpha1')).toBe(alphaBefore);
    expect(after.find((r) => r.path === '/Axes1')).toBe(before.find((r) => r.path === '/Axes1'));
    const statusAfter = after.find((r) => r.path === '/Grid1/Status1')!;
    expect(statusAfter).not.toBe(statusBefore);
    expect(statusAfter.hasChildren).toBe(true);
  });

  it('a row whose depth changes is rebuilt', () => {
    const { root, axes } = tree();
    const expanded = new ExpandedState();
    const before = flattenRows(root, expanded);
    const axesRow = before.find((r) => r.path === '/Axes1')!;
    const reuse = byPath(before);
    // Same prop and path but at another depth must not be reused.
    const nested = flattenRows(axes.parent!, expanded, '', 1, [], reuse);
    expect(nested.find((r) => r.prop === axesRow.prop)).not.toBe(axesRow);
  });
});
