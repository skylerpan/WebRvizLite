/** Group enable/disable propagation (rviz DisplayGroup): children in a disabled group are off. */
import { describe, expect, it } from 'vitest';
import { DisplayBase, DisplayGroupImpl } from './Display';
import type { DisplayContext } from './types';

class Probe extends DisplayBase {
  log: string[] = [];
  constructor(name: string) {
    super('test/Probe', name);
  }
  override onEnable() { this.log.push('on'); }
  override onDisable() { this.log.push('off'); }
}

const fakeContext = () => ({ scene: { add() {}, remove() {} } }) as unknown as DisplayContext;
const fakeRegistry = () => ({ create: () => { throw new Error('unused'); } }) as never;

describe('display activation through groups', () => {
  it('a child of a disabled group is not enabled on initialize, and comes on when the group is enabled', () => {
    const root = new DisplayGroupImpl(fakeRegistry(), 'root', '');
    const group = new DisplayGroupImpl(fakeRegistry(), 'Realsense', '');
    const child = new Probe('Camera');
    root.addDisplay(group);
    group.addDisplay(child);
    group.setEnabled(false);
    root.initialize(fakeContext());
    expect(child.enabled()).toBe(true);
    expect(child.isActive()).toBe(false);
    expect(child.log).toEqual([]);

    group.setEnabled(true);
    expect(child.isActive()).toBe(true);
    expect(child.log).toEqual(['on']);
    group.setEnabled(false);
    expect(child.isActive()).toBe(false);
    expect(child.log).toEqual(['on', 'off']);
  });

  it('toggling a child inside a disabled group does nothing until the group is enabled', () => {
    const root = new DisplayGroupImpl(fakeRegistry(), 'root', '');
    const group = new DisplayGroupImpl(fakeRegistry(), 'G', '');
    const child = new Probe('P');
    root.addDisplay(group);
    group.addDisplay(child);
    root.initialize(fakeContext());
    expect(child.log).toEqual(['on']);
    group.setEnabled(false);
    expect(child.log).toEqual(['on', 'off']);
    child.setEnabled(false);
    child.setEnabled(true);
    expect(child.log).toEqual(['on', 'off']);
    group.setEnabled(true);
    expect(child.log).toEqual(['on', 'off', 'on']);
  });

  it('disposing an active display switches it off once; an inactive one not at all', () => {
    const root = new DisplayGroupImpl(fakeRegistry(), 'root', '');
    const a = new Probe('A');
    const b = new Probe('B');
    root.addDisplay(a);
    root.addDisplay(b);
    root.initialize(fakeContext());
    b.setEnabled(false);
    root.removeDisplay(a);
    root.removeDisplay(b);
    expect(a.log).toEqual(['on', 'off']);
    expect(b.log).toEqual(['on', 'off']);
  });
});
