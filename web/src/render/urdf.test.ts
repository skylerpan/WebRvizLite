// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseUrdf } from './urdf';

const FIXTURE = join(__dirname, '../../../fixtures/robot_description/tier1_robot.urdf');

describe('parseUrdf', () => {
  it('parses the fixture robot: links, joints, geometry, materials', () => {
    const m = parseUrdf(readFileSync(FIXTURE, 'utf8'));
    expect(m.name).toBe('tier1_robot');
    expect(m.links.size).toBe(9);
    expect(m.joints.size).toBe(8);
    expect(m.roots).toEqual(['base_footprint']);
    const base = m.links.get('base_link')!;
    expect(base.visuals[0].geometry).toEqual({ type: 'mesh', filename: 'package://webrvizlite_fixtures/robot_description/meshes/body.stl', scale: [1, 1, 1] });
    expect(base.visuals[0].color).toEqual([0.2, 0.4, 0.9, 1.0]);
    expect(base.visuals[0].origin.xyz).toEqual([0, 0, 0.19]);
    expect(base.collisions[0].geometry).toEqual({ type: 'box', size: [0.6, 0.5, 0.28] });
    expect(base.inertial?.mass).toBe(12);
    const wheel = m.joints.get('wheel_left_joint')!;
    expect(wheel.type).toBe('continuous');
    expect(wheel.parent).toBe('base_link');
    expect(wheel.origin.xyz).toEqual([0, 0.28, 0.127]);
    expect(wheel.axis).toEqual([0, 1, 0]);
    expect(m.links.get('laser')!.visuals[0].geometry).toEqual({ type: 'cylinder', radius: 0.05, length: 0.04 });
  });

  it('reports malformed documents with a path', () => {
    expect(() => parseUrdf('<robot name="x"><link name="a"><visual><geometry><box size="1 2"/></geometry></visual></link></robot>')).toThrow(/link\[a\]\/visual\[0\]/);
    expect(() => parseUrdf('<robot name="x"><link name="a"/><joint name="j" type="fixed"><parent link="a"/><child link="b"/></joint></robot>')).toThrow(/unknown parent\/child/);
    expect(() => parseUrdf('<nope/>')).toThrow(/robot/);
  });
});
