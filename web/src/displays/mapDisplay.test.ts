/**
 * Map display: properties loaded from a .rviz before initialize() must reach
 * the GPU objects created in onInitialize().
 */
import { describe, expect, it } from 'vitest';
import type * as THREE from 'three/webgpu';
import { MapDisplay } from './mapDisplay';
import { makePalette } from '../render/mapPalette';
import type { DisplayContext } from './types';

const fakeContext = () =>
  ({
    scene: { add() {}, remove() {} },
    bridge: { subscribe: () => 1, unsubscribe() {}, setOptions() {} },
    fixedFrame: () => 'map',
  }) as unknown as DisplayContext;

type Internals = { paletteTexture: THREE.DataTexture };

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
});
