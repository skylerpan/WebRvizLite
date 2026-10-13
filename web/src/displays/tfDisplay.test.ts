/** Frame Timeout fade checked against rviz2 frame_info.cpp FrameInfo::updateColorForAge. */
import { describe, expect, it } from 'vitest';
import { frameFade } from './tfDisplay';

describe('TF Frame Timeout (rviz2 FrameInfo::updateColorForAge)', () => {
  it('shows the first third normally, greys over the second and fades out over the last', () => {
    expect(frameFade(0, 15)).toEqual({ grey: 0, alpha: 1 });
    expect(frameFade(5, 15)).toEqual({ grey: 0, alpha: 1 });
    expect(frameFade(7.5, 15)).toEqual({ grey: 0.5, alpha: 1 });
    expect(frameFade(10, 15)).toEqual({ grey: 1, alpha: 1 });
    expect(frameFade(12.5, 15)).toEqual({ grey: 1, alpha: 0.5 });
    expect(frameFade(15, 15)).toEqual({ grey: 1, alpha: 0 });
  });

  it('hides a frame only once it is older than the whole timeout', () => {
    expect(frameFade(15.01, 15)).toBeNull();
    expect(frameFade(Infinity, 15)).toBeNull();
  });

  it('scales with the timeout down to its 1 s minimum', () => {
    expect(frameFade(0.5, 1)?.grey).toBeCloseTo(0.5);
    expect(frameFade(0.5, 1)?.alpha).toBe(1);
    expect(frameFade(1, 1)?.alpha).toBe(0);
    expect(frameFade(1.5, 1)).toBeNull();
  });
});
