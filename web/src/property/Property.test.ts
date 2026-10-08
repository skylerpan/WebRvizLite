import { describe, expect, it } from 'vitest';
import {
  BoolPropertyImpl, ColorPropertyImpl, EnumPropertyImpl, FloatPropertyImpl, GroupProperty, IntPropertyImpl,
  RosTopicPropertyImpl, StatusListPropertyImpl, TfFramePropertyImpl, VectorPropertyImpl,
} from './Property';
import { parseColor, printColor } from './color';

describe('Property YAML codec (rviz_common rules)', () => {
  it('scalar when there are no children', () => {
    const p = new FloatPropertyImpl('Alpha', 0.5, null);
    expect(p.save()).toBe(0.5);
    p.load(0.25);
    expect(p.value()).toBe(0.25);
  });

  it('enum with a child saves {Value, child}', () => {
    const style = new EnumPropertyImpl('Line Style', 'Lines', ['Lines', 'Billboards'], null);
    const width = new FloatPropertyImpl('Line Width', 0.03, style);
    expect(style.save()).toEqual({ Value: 'Lines', 'Line Width': 0.03 });
    style.load({ Value: 'Billboards', 'Line Width': 0.1 });
    expect(style.value()).toBe('Billboards');
    expect(width.value()).toBe(0.1);
  });

  it('flat scalar still loads a property that has children', () => {
    const topic = new RosTopicPropertyImpl('Topic', '', ['geometry_msgs/msg/PoseStamped'], null);
    topic.load('/goal_pose');
    expect(topic.value()).toBe('/goal_pose');
    expect(topic.save()).toEqual({
      Value: '/goal_pose', Depth: 5, 'History Policy': 'Keep Last', 'Reliability Policy': 'Reliable', 'Durability Policy': 'Volatile',
    });
    topic.load({ Value: '/scan', 'Reliability Policy': 'Best Effort', Depth: 10 });
    expect(topic.qos()).toEqual({ depth: 10, history: 'keep_last', reliability: 'best_effort', durability: 'volatile' });
  });

  it('vector saves {X,Y,Z} and keeps child editors in sync', () => {
    const v = new VectorPropertyImpl('Offset', { x: 0, y: 0, z: 0 }, null);
    expect(v.save()).toEqual({ X: 0, Y: 0, Z: 0 });
    v.load({ X: 1, Y: 2, Z: 3 });
    expect(v.child('Y')!.value()).toBe(2);
    (v.child('Z') as FloatPropertyImpl).setValue(9, 'user');
    expect(v.value()).toEqual({ x: 1, y: 2, z: 9 });
    expect(v.save()).toEqual({ X: 1, Y: 2, Z: 9 });
  });

  it('read-only and status children are not saved, hidden ones are', () => {
    const g = new GroupProperty('G', null);
    new IntPropertyImpl('Visible', 1, g);
    new IntPropertyImpl('Hidden', 2, g, { hidden: true });
    new IntPropertyImpl('ReadOnly', 3, g, { readOnly: true });
    const status = new StatusListPropertyImpl('Status', g);
    status.setStatus('error', 'Topic', 'no publisher');
    expect(g.save()).toEqual({ Visible: 1, Hidden: 2 });
    expect(status.level()).toBe('error');
    expect(status.name()).toBe('Status: Error');
    expect(status.pathName()).toBe('Status');
  });

  it('unknown keys survive a load/save round trip', () => {
    const g = new GroupProperty('Grid', null);
    new FloatPropertyImpl('Alpha', 0.5, g);
    g.load({ Alpha: 0.7, 'Future Option': { Nested: true }, Other: 'x' });
    expect(g.save()).toEqual({ Alpha: 0.7, 'Future Option': { Nested: true }, Other: 'x' });
  });

  it('bool accepts yaml booleans and strings', () => {
    const b = new BoolPropertyImpl('Enabled', false, null);
    b.load('true');
    expect(b.value()).toBe(true);
    b.load(false);
    expect(b.value()).toBe(false);
    expect(b.save()).toBe(false);
  });

  it('int and float clamp to range and reject NaN', () => {
    const i = new IntPropertyImpl('Depth', 5, null, { min: 1 });
    expect(i.setValue(0)).toBe(true);
    expect(i.value()).toBe(1);
    expect(i.setValue(2.7)).toBe(true);
    expect(i.value()).toBe(2);
    const f = new FloatPropertyImpl('Alpha', 0.5, null, { min: 0, max: 1 });
    expect(f.setValue(5)).toBe(true);
    expect(f.value()).toBe(1);
    expect(f.setValue(Number.NaN)).toBe(false);
    expect(f.value()).toBe(1);
  });

  it('color round trips "r; g; b" and parses names/hex', () => {
    const c = new ColorPropertyImpl('Color', { r: 160, g: 160, b: 164 }, null);
    expect(c.save()).toBe('160; 160; 164');
    c.load('25; 255; 0');
    expect(c.value()).toEqual({ r: 25, g: 255, b: 0 });
    expect(parseColor('darkYellow')).toEqual({ r: 128, g: 128, b: 0 });
    expect(parseColor('#ff8000')).toEqual({ r: 255, g: 128, b: 0 });
    expect(parseColor('nope')).toBeNull();
    expect(printColor({ r: 1, g: 2, b: 3 })).toBe('1; 2; 3');
  });

  it('tf frame keeps the raw value but resolves <Fixed Frame> and strips "/"', () => {
    const fixed = new TfFramePropertyImpl('Fixed Frame', 'base_link', null, null, { includeFixedFrame: false });
    fixed.load('/map');
    expect(fixed.save()).toBe('/map');
    expect(fixed.frameId()).toBe('map');
    const ref = new TfFramePropertyImpl('Reference Frame', '<Fixed Frame>', null, () => fixed.frameId());
    expect(ref.frameId()).toBe('map');
    expect(ref.options()).toContain('<Fixed Frame>');
  });

  it('onChange fires once per accepted change with the source', () => {
    const p = new IntPropertyImpl('N', 1, null);
    const seen: Array<[number, string]> = [];
    p.onChange((v, s) => seen.push([v, s]));
    p.setValue(1);
    p.setValue(2, 'user');
    p.load(3);
    expect(seen).toEqual([[2, 'user'], [3, 'config']]);
  });
});
