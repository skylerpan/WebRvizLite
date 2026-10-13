/**
 * Map display: properties loaded from a .rviz before initialize() must reach
 * the GPU objects created in onInitialize(), and a map must be ordered before
 * other transparent objects so a Path on the same plane stays on top.
 */
import { describe, expect, it } from 'vitest';
import type * as THREE from 'three/webgpu';
import { MAP_RENDER_ORDER, MapDisplay } from './mapDisplay';
import { makePalette } from '../render/mapPalette';
import type { DisplayContext } from './types';
import type { DataMessage } from '../worker/messages';

const fakeContext = () =>
  ({
    scene: { add() {}, remove() {} },
    bridge: { subscribe: () => 1, unsubscribe() {}, setOptions() {} },
    fixedFrame: () => 'map',
  }) as unknown as DisplayContext;

type Internals = { paletteTexture: THREE.DataTexture; mesh: THREE.Mesh | null };

const gridMessage = (): DataMessage =>
  ({
    type: 'data',
    id: 1,
    seq: 1,
    decoder: 'occupancy_grid',
    stampNs: 0,
    frameId: 'map',
    inFixedFrame: true,
    data: { resolution: 0.05, width: 2, height: 2, origin: new Float64Array([0, 0, 0, 0, 0, 0, 1]), data: new Uint8Array(4) },
  }) as unknown as DataMessage;

describe('Map display', () => {
  it('builds the palette from the Color Scheme loaded before initialize()', () => {
    const d = new MapDisplay();
    d.load({ Class: 'rviz_default_plugins/Map', 'Color Scheme': 'costmap' });
    d.initialize(fakeContext());
    const palette = (d as unknown as Internals).paletteTexture.image.data as Uint8Array;
    expect(Array.from(palette)).toEqual(Array.from(makePalette('costmap')));
    d.dispose();
  });

  it('switching the scheme after initialize() still rewrites the palette', () => {
    const d = new MapDisplay();
    d.initialize(fakeContext());
    d.colorScheme.setValue('raw');
    const palette = (d as unknown as Internals).paletteTexture.image.data as Uint8Array;
    expect(Array.from(palette)).toEqual(Array.from(makePalette('raw')));
    d.dispose();
  });

  it('orders the map before other transparent objects unless Draw Behind', () => {
    const d = new MapDisplay();
    d.initialize(fakeContext());
    d.processMessage(gridMessage());
    const mesh = (d as unknown as Internals).mesh!;
    expect(MAP_RENDER_ORDER).toBeLessThan(0);
    expect(mesh.renderOrder).toBe(MAP_RENDER_ORDER);
    expect((mesh.material as THREE.Material).depthTest).toBe(true);
    d.drawBehind.setValue(true);
    expect(mesh.renderOrder).toBe(-1000);
    expect((mesh.material as THREE.Material).depthTest).toBe(false);
    d.drawBehind.setValue(false);
    expect(mesh.renderOrder).toBe(MAP_RENDER_ORDER);
    d.dispose();
  });
});
