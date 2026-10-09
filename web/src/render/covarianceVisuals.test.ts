// @vitest-environment jsdom
/** Batched covariance visuals (instanced pools) and their use by the Odometry display. */
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import { CovarianceVisuals, linearBytes, type CovarianceStyle } from './covarianceVisual';
import { OdometryDisplay } from '../displays/odometryDisplay';
import type { DisplayContext } from '../displays/types';
import type { PoseCovMsg } from '../worker/decoders';
import { TfSnapshot } from './tf';
import { PickRegistry } from './picking';
import type { DataMessage } from '../worker/messages';

const style = (over: Partial<{ position: boolean; orientation: boolean; colorStyle: 'Unique' | 'RGB' }> = {}): CovarianceStyle => ({
  position: { enabled: over.position ?? true, color: { r: 204, g: 51, b: 204 }, alpha: 0.3 },
  orientation: { enabled: over.orientation ?? true, frame: 'Local', colorStyle: over.colorStyle ?? 'Unique', color: { r: 255, g: 255, b: 127 }, alpha: 0.5, offset: 1 },
});

const msg = (x: number, is2d: boolean): PoseCovMsg => ({
  count: 1,
  positions: new Float32Array([x, 0, 0]),
  orientations: new Float32Array([0, 0, 0, 1]),
  childFrameId: 'base_link',
  covariance: new Float64Array(36),
  ellipsoid: new Float32Array([0.1, 0.2, 0.3, 0, 0, 0, 1]),
  orientation: is2d ? new Float32Array([0.5]) : new Float32Array([0, 0.1, 0.2, 0, 1, 0.1, 0.2, 0, 2, 0.1, 0.2, 0]),
  is2d,
});

describe('CovarianceVisuals', () => {
  it('fills the ellipsoid and sector pools for a 2-D pose and the disc pool for a 3-D pose', () => {
    const v = new CovarianceVisuals();
    expect(v.visible).toBe(false);
    v.begin();
    v.push(msg(0, true), style());
    v.end();
    expect(v.counts()).toEqual({ ellipsoids: 1, discs: 0, sectors: 1 });
    expect(v.visible).toBe(true);
    v.begin();
    v.push(msg(0, false), style());
    v.push(msg(1, false), style());
    v.end();
    expect(v.counts()).toEqual({ ellipsoids: 2, discs: 6, sectors: 0 });
    v.hide();
    expect(v.counts()).toEqual({ ellipsoids: 0, discs: 0, sectors: 0 });
    expect(v.visible).toBe(false);
  });

  it('respects the enabled flags', () => {
    const v = new CovarianceVisuals();
    v.begin();
    v.push(msg(0, false), style({ position: false }));
    v.end();
    expect(v.counts()).toEqual({ ellipsoids: 0, discs: 3, sectors: 0 });
    v.begin();
    v.push(msg(0, false), style({ orientation: false }));
    v.end();
    expect(v.counts()).toEqual({ ellipsoids: 1, discs: 0, sectors: 0 });
  });

  it('converts sRGB property colours to linear bytes', () => {
    const out = new Uint8Array(3);
    expect(Array.from(linearBytes({ r: 255, g: 0, b: 0 }, out))).toEqual([255, 0, 0]);
    // Mid grey: sRGB 128 ≈ linear 0.216 → 55.
    expect(linearBytes({ r: 128, g: 128, b: 128 }, out)[0]).toBe(55);
  });
});

function fakeContext(): DisplayContext {
  const bridge = {
    subscribe: (_t: string, _ty: string, _q: unknown, _d: string, onData: (m: DataMessage) => void) => {
      deliver = onData;
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
let deliver: ((m: DataMessage) => void) | null = null;

describe('Odometry display covariance pools', () => {
  it('keeps one set of visuals per kept pose and redraws once per message', () => {
    const d = new OdometryDisplay();
    d.load({ Class: 'rviz_default_plugins/Odometry', Name: 'Odometry', Topic: '/odom', Keep: 2 });
    d.initialize(fakeContext());
    const redraw = vi.spyOn(d as unknown as { redraw: () => void }, 'redraw');
    const covs = (d as unknown as { covs: CovarianceVisuals }).covs;
    for (const x of [0, 1, 2]) deliver!({ type: 'data', id: 1, seq: 0, decoder: 'odometry', stampNs: 0, frameId: 'odom', inFixedFrame: true, tfError: null, data: msg(x, true) });
    expect(redraw).toHaveBeenCalledTimes(3);
    // Keep = 2: the oldest pose was trimmed, two remain.
    expect(covs.counts()).toEqual({ ellipsoids: 2, discs: 0, sectors: 2 });
    // A pose within the tolerances is skipped without a redraw.
    deliver!({ type: 'data', id: 1, seq: 0, decoder: 'odometry', stampNs: 0, frameId: 'odom', inFixedFrame: true, tfError: null, data: msg(2.01, true) });
    expect(redraw).toHaveBeenCalledTimes(3);
    d.covariance.setValue(false, 'user');
    expect(covs.counts()).toEqual({ ellipsoids: 0, discs: 0, sectors: 0 });
    d.dispose();
  });
});
