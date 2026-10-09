// @vitest-environment jsdom
/** RobotModel / Image property behaviour checked against rviz lyrical robot_model_display.cpp, robot.cpp, robot_joint.cpp, image_display.cpp. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { RobotModelDisplay } from './robotModelDisplay';
import { ImageDisplay } from './imageDisplay';
import type { DisplayContext } from './types';
import { TfSnapshot } from '../render/tf';
import { PickRegistry } from '../render/picking';
import type { DataMessage, QosProfile } from '../worker/messages';
import type { YamlMap } from '../property/types';

const URDF = readFileSync(join(__dirname, '../../../fixtures/robot_description/tier1_robot.urdf'), 'utf8');

function fakeContext(onSubscribe: (topic: string, qos: QosProfile, handler: (m: DataMessage) => void) => void): DisplayContext {
  const bridge = {
    subscribe: (topic: string, _type: string, qos: QosProfile, _decoder: string, onData: (m: DataMessage) => void) => {
      onSubscribe(topic, qos, onData);
      return 1;
    },
    unsubscribe() {},
    setOptions() {},
    topics: () => [],
    tf: new TfSnapshot(),
  } as never;
  return {
    scene: new THREE.Scene(), bridge, fixedFrame: () => 'map', tf: new TfSnapshot(), rosTimeNs: () => 0n,
    picking: new PickRegistry(), panels: () => null, rootDisplays: () => [], extraViews: new Set(),
  };
}

describe('RobotModel (rviz lyrical)', () => {
  const make = (yaml?: YamlMap) => {
    const d = new RobotModelDisplay();
    if (yaml) d.load(yaml);
    let qos: QosProfile | null = null;
    let topic = '';
    let deliver: ((m: DataMessage) => void) | null = null;
    d.initialize(fakeContext((t, q, h) => { topic = t; qos = q; deliver = h; }));
    return { d, topic: () => topic, qos: () => qos, deliver: (text: string) => deliver?.({ type: 'data', id: 1, decoder: 'string', stampNs: 0, frameId: '', inFixedFrame: true, tfError: null, data: { text } }) };
  };

  it('has an empty Description Topic by default, generic QoS rows, but subscribes transient local depth 1', () => {
    const { d, qos, topic } = make({ Class: 'rviz_default_plugins/RobotModel', Name: 'RobotModel', 'Description Topic': { Value: '/robot_description', Depth: 5, 'Durability Policy': 'Volatile', 'History Policy': 'Keep Last', 'Reliability Policy': 'Reliable' } });
    expect(new RobotModelDisplay().descriptionTopic.value()).toBe('');
    expect(d.descriptionTopic.depth.value()).toBe(5);
    expect(d.descriptionTopic.durability.value()).toBe('Volatile');
    expect(topic()).toBe('/robot_description');
    expect(qos()).toEqual({ depth: 1, history: 'keep_last', reliability: 'reliable', durability: 'transient_local' });
    // Editing a QoS row switches to the rows' values (rviz updateQosProfile).
    d.descriptionTopic.depth.setValue(10, 'user');
    expect(qos()).toMatchObject({ depth: 10, durability: 'volatile' });
  });

  it('builds the Links group per style with the rviz names, rows and joint details', () => {
    const { d, deliver } = make({ Class: 'rviz_default_plugins/RobotModel', Name: 'RobotModel', 'Description Topic': '/robot_description' });
    deliver(URDF);
    expect(d.status.children().find((c) => c.name() === 'URDF')?.value()).toBe('URDF parsed OK');
    const names = () => d.links.children().map((c) => c.name());
    // Default list style: group "Links", link rows flat (no Details), Expand Tree hidden.
    expect(d.links.name()).toBe('Links');
    expect(d.expandTree.hidden()).toBe(true);
    expect(d.expandJointDetails.hidden()).toBe(true);
    expect(names()).toContain('base_link');
    const baseLink = d.links.children().find((c) => c.name() === 'base_link')!;
    expect(baseLink.children().map((c) => c.name())).toEqual(['Alpha', 'Show Trail', 'Show Axes', 'Position', 'Orientation']);

    d.linkTreeStyle.setValue('Joints in Alphabetic Order', 'user');
    expect(d.links.name()).toBe('Joints');
    expect(d.expandLinkDetails.hidden()).toBe(true);
    expect(d.expandJointDetails.hidden()).toBe(false);
    const wheel = d.links.children().find((c) => c.name() === 'wheel_left_joint')!;
    expect(wheel.children().map((c) => c.name())).toEqual(['Show Axes', 'Position', 'Orientation', 'Type', 'Show Joint Axis', 'Joint Axis']);
    expect(wheel.children().find((c) => c.name() === 'Type')?.value()).toBe('continuous');
    const fixed = d.links.children().find((c) => c.name() === 'laser_joint')!;
    expect(fixed.children().map((c) => c.name())).toEqual(['Show Axes', 'Position', 'Orientation', 'Type']);

    d.linkTreeStyle.setValue('Tree of links and joints', 'user');
    expect(d.links.name()).toBe('Link/Joint Tree');
    expect(d.expandTree.hidden()).toBe(false);
    const root = d.links.children().find((c) => c.name() === 'base_footprint')!;
    // Tree styles nest rows under "Details" and alternate link → joint → link.
    expect(root.children()[0].name()).toBe('Details');
    expect(root.children().map((c) => c.name())).toContain('base_joint');
    const baseJoint = root.children().find((c) => c.name() === 'base_joint')!;
    expect(baseJoint.children().map((c) => c.name())).toContain('base_link');
    // Expand toggles reset to false on a style change.
    d.expandTree.setValue(true, 'user');
    d.linkTreeStyle.setValue('Tree of links', 'user');
    expect(d.expandTree.value()).toBe(false);
    expect(d.links.name()).toBe('Link Tree');
    // Saving uses the group's current name; loading accepts it back.
    const saved = d.save();
    expect(saved['Link Tree']).toBeDefined();
    const again = new RobotModelDisplay();
    again.load(saved);
    expect(again.links.name()).toBe('Link Tree');
    expect(again.linkTreeStyle.value()).toBe('Tree of links');
  });

  it('reports parse failures and empty descriptions with the rviz strings', () => {
    const { d, deliver } = make({ Class: 'rviz_default_plugins/RobotModel', Name: 'RobotModel', 'Description Topic': '/robot_description' });
    deliver('<robot name="x"><link name="a"/><joint name="j" type="fixed"><parent link="a"/><child link="b"/></joint></robot>');
    expect(d.status.children().find((c) => c.name() === 'URDF')?.value()).toBe('URDF failed Model parse');
    deliver('   ');
    expect(d.status.children().find((c) => c.name() === 'URDF')?.value()).toBe('URDF is empty');
  });
});

describe('Image display normalisation rows (rviz image_display.cpp)', () => {
  it('shows the rows only for float / 16-bit images and hides Min/Max or Median window by Normalize Range', () => {
    const d = new ImageDisplay();
    d.initialize(fakeContext(() => {}));
    const frame = (encoding: string): DataMessage => ({ type: 'data', id: 1, decoder: 'image', stampNs: 0, frameId: 'cam', inFixedFrame: false, tfError: null, data: { width: 1, height: 1, encoding, rgba: new Uint8Array(4) } });
    expect(d.normalizeRange.hidden()).toBe(true);
    d.processMessage(frame('rgb8'));
    expect(d.normalizeRange.hidden()).toBe(true);
    d.processMessage(frame('16UC1'));
    expect(d.normalizeRange.hidden()).toBe(false);
    expect(d.minValue.hidden()).toBe(true);
    expect(d.medianWindow.hidden()).toBe(false);
    d.normalizeRange.setValue(false, 'user');
    expect(d.minValue.hidden()).toBe(false);
    expect(d.maxValue.hidden()).toBe(false);
    expect(d.medianWindow.hidden()).toBe(true);
    expect(d.topic.children().map((c) => c.name())).toContain('Transport Override');
  });
});
