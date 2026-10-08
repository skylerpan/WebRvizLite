/** TopDownOrtho / FPS mouse conventions and ViewManager saved views (rviz2 lyrical). */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { TopDownOrthoViewController } from './topDownOrtho';
import { FpsViewController } from './fps';
import { OrbitViewController } from './orbit';
import { ViewManager } from './ViewManager';
import type { ViewContext, ViewportPointerEvent } from './types';
import type { TfSnapshot } from '../render/tf';

function ev(partial: Partial<ViewportPointerEvent>): ViewportPointerEvent {
  return {
    type: 'move', x: 0, y: 0, dx: 0, dy: 0, buttons: 0, button: -1,
    shift: false, ctrl: false, alt: false, wheel: 0, width: 800, height: 600,
    ...partial,
  };
}

const ctx: ViewContext = { tf: { lookup: () => false } as unknown as TfSnapshot, fixedFrame: () => 'map' };

describe('TopDownOrtho', () => {
  const make = () => {
    const v = new TopDownOrthoViewController(() => 'map');
    v.initialize(ctx);
    v.setViewportSize(800, 600);
    v.update(0);
    return v;
  };

  it('uses an orthographic camera sized by Scale and looking down -Z', () => {
    const v = make();
    const cam = v.camera as THREE.OrthographicCamera;
    expect(cam.isOrthographicCamera).toBe(true);
    expect(cam.right - cam.left).toBeCloseTo(800 / 10);
    expect(cam.top - cam.bottom).toBeCloseTo(600 / 10);
    const dir = cam.getWorldDirection(new THREE.Vector3());
    expect(dir.z).toBeCloseTo(-1);
  });

  it('right drag and wheel change Scale, middle drag pans in meters', () => {
    const v = make();
    v.handleMouse(ev({ buttons: 2, dy: -10 }));
    expect(v.scale.value()).toBeCloseTo(10 * 1.1);
    v.handleMouse(ev({ type: 'wheel', wheel: 1 }));
    expect(v.scale.value()).toBeGreaterThan(11);
    const s = v.scale.value();
    v.handleMouse(ev({ buttons: 4, dx: 10 }));
    expect(v.x.value()).toBeCloseTo(-10 / s);
  });

  it('left drag rotates and Angle rotates the pan direction', () => {
    const v = make();
    v.handleMouse(ev({ buttons: 1, dx: 10 }));
    expect(v.angle.value()).toBeCloseTo(-0.05);
    v.angle.setValue(Math.PI / 2);
    v.handleMouse(ev({ buttons: 4, dy: 10 }));
    // dy pans along the rotated +Y, which at 90° is -X.
    expect(v.x.value()).toBeCloseTo(-1);
    expect(Math.abs(v.y.value())).toBeLessThan(1e-9);
  });

  it('saves and loads X/Y/Scale/Angle', () => {
    const v = make();
    v.load({ Class: 'rviz_default_plugins/TopDownOrtho', Name: 'Current View', Scale: 160, Angle: -1.5708, X: 1, Y: 2 });
    expect(v.save()).toMatchObject({ Class: 'rviz_default_plugins/TopDownOrtho', Scale: 160, Angle: -1.5708, X: 1, Y: 2 });
    v.reset();
    expect(v.scale.value()).toBe(10);
  });
});

describe('FPS', () => {
  const make = () => {
    const v = new FpsViewController(() => 'map');
    v.initialize(ctx);
    v.setViewportSize(800, 600);
    v.update(0);
    return v;
  };

  it('reset places the camera at (5, 5, 10) looking at the origin', () => {
    const v = make();
    expect(v.position.value()).toEqual({ x: 5, y: 5, z: 10 });
    const dir = v.camera.getWorldDirection(new THREE.Vector3());
    const toOrigin = new THREE.Vector3(-5, -5, -10).normalize();
    expect(dir.distanceTo(toOrigin)).toBeLessThan(1e-6);
  });

  it('left drag turns, right drag moves backward, wheel moves forward', () => {
    const v = make();
    const yaw = v.yaw.value();
    const pitch = v.pitch.value();
    v.handleMouse(ev({ buttons: 1, dx: 10, dy: 10 }));
    expect(v.yaw.value()).toBeCloseTo(yaw - 0.05);
    expect(v.pitch.value()).toBeCloseTo(pitch - 0.05);
    const before = new THREE.Vector3().copy(v.camera.position);
    const dir = v.camera.getWorldDirection(new THREE.Vector3());
    v.handleMouse(ev({ type: 'wheel', wheel: 1 }));
    const moved = new THREE.Vector3().copy(v.camera.position).sub(before);
    expect(moved.dot(dir)).toBeGreaterThan(0);
    v.handleMouse(ev({ buttons: 2, dy: 100 }));
    expect(new THREE.Vector3().copy(v.camera.position).sub(before).dot(dir)).toBeLessThan(moved.dot(dir));
  });

  it('mimic copies the previous camera pose', () => {
    const orbit = new OrbitViewController(() => 'map');
    orbit.initialize(ctx);
    orbit.setViewportSize(800, 600);
    orbit.update(0);
    const v = make();
    v.mimic(orbit);
    v.update(0);
    expect(v.camera.position.distanceTo(orbit.camera.position)).toBeLessThan(1e-6);
    const d1 = orbit.camera.getWorldDirection(new THREE.Vector3());
    const d2 = v.camera.getWorldDirection(new THREE.Vector3());
    expect(d1.distanceTo(d2)).toBeLessThan(1e-6);
  });
});

describe('ViewManager saved views', () => {
  it('round-trips Saved: ~ and a saved list, switches to a saved view', () => {
    const vm = new ViewManager(ctx);
    expect(vm.save().Saved).toBeNull();
    vm.load({ Current: { Class: 'rviz_default_plugins/Orbit', Name: 'Current View', Distance: 12 }, Saved: null });
    expect(vm.saved()).toHaveLength(0);
    const top = vm.saveCurrent('Top');
    vm.setCurrentClass('rviz_default_plugins/TopDownOrtho');
    const saved2 = vm.saveCurrent('Ortho');
    const yaml = vm.save();
    expect(Array.isArray(yaml.Saved) && yaml.Saved.length).toBe(2);
    expect((yaml.Saved as { Name: string }[])[0].Name).toBe('Top');
    expect(vm.treeRoot.children()).toHaveLength(3);
    vm.setCurrentFrom(top);
    expect(vm.current().classId).toBe('rviz_default_plugins/Orbit');
    expect(vm.current().name()).toBe('Current View');
    expect((vm.current() as OrbitViewController).distance.value()).toBe(12);
    vm.removeSaved(saved2);
    expect(vm.saved()).toHaveLength(1);

    const vm2 = new ViewManager(ctx);
    vm2.load(yaml);
    expect(vm2.saved().map((v) => v.name())).toEqual(['Top', 'Ortho']);
    expect(vm2.saved()[1].classId).toBe('rviz_default_plugins/TopDownOrtho');
    // Unknown saved view classes keep their YAML.
    vm2.load({ Current: yaml.Current, Saved: [{ Class: 'rviz_default_plugins/ThirdPersonFollower', Name: 'Follow', Distance: 3, Foo: 'bar' }] });
    expect(vm2.save().Saved).toEqual([expect.objectContaining({ Class: 'rviz_default_plugins/ThirdPersonFollower', Name: 'Follow', Foo: 'bar' })]);
  });
});
