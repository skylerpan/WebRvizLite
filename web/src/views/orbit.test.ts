/**
 * Mouse direction conventions of the Orbit view controller, checked against
 * rviz2 Humble's orbit_view_controller.cpp.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { OrbitViewController } from './orbit';
import type { ViewportPointerEvent } from './types';
import type { TfSnapshot } from '../render/tf';

function ev(partial: Partial<ViewportPointerEvent>): ViewportPointerEvent {
  return {
    type: 'move', x: 0, y: 0, dx: 0, dy: 0, buttons: 0, button: -1,
    shift: false, ctrl: false, alt: false, wheel: 0, width: 800, height: 600,
    ...partial,
  };
}

function makeOrbit(): OrbitViewController {
  const v = new OrbitViewController(() => 'map');
  const tf = { lookup: () => null } as unknown as TfSnapshot;
  v.initialize({ tf, fixedFrame: () => 'map' });
  v.setAspect(800 / 600);
  v.handleMouse(ev({ type: 'down', button: 0, buttons: 1 }));
  return v;
}

describe('OrbitViewController mouse directions (rviz2 Humble)', () => {
  it('left drag down raises the camera (pitch increases)', () => {
    const v = makeOrbit();
    const before = v.pitch.value();
    v.handleMouse(ev({ buttons: 1, dy: 10 }));
    expect(v.pitch.value()).toBeGreaterThan(before);
  });

  it('left drag right decreases yaw', () => {
    const v = makeOrbit();
    const before = v.yaw.value();
    v.handleMouse(ev({ buttons: 1, dx: 10 }));
    expect(v.yaw.value()).toBeLessThan(before);
  });

  it('middle drag right moves the focal point along camera -X (scene follows the cursor)', () => {
    const v = makeOrbit();
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(v.camera.quaternion);
    v.handleMouse(ev({ buttons: 4, dx: 10 }));
    const f = v.focalPoint.value();
    expect(new THREE.Vector3(f.x, f.y, f.z).dot(right)).toBeLessThan(0);
  });

  it('middle drag down moves the focal point along camera +Y', () => {
    const v = makeOrbit();
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(v.camera.quaternion);
    v.handleMouse(ev({ buttons: 4, dy: 10 }));
    const f = v.focalPoint.value();
    expect(new THREE.Vector3(f.x, f.y, f.z).dot(up)).toBeGreaterThan(0);
  });

  it('right drag down zooms out (distance increases)', () => {
    const v = makeOrbit();
    const before = v.distance.value();
    v.handleMouse(ev({ buttons: 2, dy: 10 }));
    expect(v.distance.value()).toBeGreaterThan(before);
  });
});
