/**
 * Worker-side decoders: CDR payload → transferable, GPU-ready data. Each
 * decoder also transforms into the fixed frame when the message carries a
 * header (spec §3: the main thread never sees message objects).
 */

import type { TfBuffer } from '../wasm/pkg/webrvizlite';
import type { Subscription } from './worker';

export interface DecodeResult {
  meta: { stampNs: number; frameId: string; inFixedFrame: boolean; tfError: string | null };
  data: unknown;
  transfer: Transferable[];
}

export type DecoderFn = (sub: Subscription, payload: Uint8Array, tf: TfBuffer, fixedFrame: string) => DecodeResult | null;

const registry = new Map<string, DecoderFn>();

export function registerDecoder(name: string, fn: DecoderFn) {
  registry.set(name, fn);
}

export function decodeMessage(sub: Subscription, payload: Uint8Array, tf: TfBuffer, fixedFrame: string): DecodeResult | null {
  const fn = registry.get(sub.decoder);
  if (!fn) throw new Error(`no decoder registered for "${sub.decoder}"`);
  return fn(sub, payload, tf, fixedFrame);
}

// ---------------------------------------------------------------------------
// Data shapes shared with the main thread
// ---------------------------------------------------------------------------

export interface OccupancyGridMsg {
  resolution: number;
  width: number;
  height: number;
  /** Origin pose of cell (0,0) in `frameId`: x y z qx qy qz qw. */
  origin: Float64Array;
  data: Uint8Array;
}

export interface OccupancyGridUpdateMsg {
  x: number;
  y: number;
  width: number;
  height: number;
  data: Uint8Array;
}

/** Poses already in the fixed frame (or in `frameId` when `inFixedFrame` is false). */
export interface PosesMsg {
  count: number;
  positions: Float32Array; // xyz × count
  orientations: Float32Array; // xyzw × count
}

function tfMeta(status: number, frameId: string, fixedFrame: string): Pick<DecodeResult['meta'], 'inFixedFrame' | 'tfError'> {
  if (status === 2) {
    return { inFixedFrame: false, tfError: `Could not transform from [${frameId}] to Fixed Frame [${fixedFrame}]` };
  }
  return { inFixedFrame: true, tfError: status === 1 ? `Message stamp outside TF history; used latest transform` : null };
}

registerDecoder('occupancy_grid', (_sub, payload, tf) => {
  const g = tf.decodeOccupancyGrid(payload);
  const data: OccupancyGridMsg = { resolution: g.resolution, width: g.width, height: g.height, origin: g.origin, data: g.data };
  const meta = { stampNs: Number(g.stamp_ns), frameId: g.frame_id, inFixedFrame: false, tfError: null };
  return { meta, data, transfer: [g.data.buffer, g.origin.buffer] };
});

registerDecoder('occupancy_grid_update', (_sub, payload, tf) => {
  const u = tf.decodeOccupancyGridUpdate(payload);
  const data: OccupancyGridUpdateMsg = { x: u.x, y: u.y, width: u.width, height: u.height, data: u.data };
  const meta = { stampNs: Number(u.stamp_ns), frameId: u.frame_id, inFixedFrame: false, tfError: null };
  return { meta, data, transfer: [u.data.buffer] };
});

function posesResult(p: { frame_id: string; stamp_ns: bigint; tf_status: number; positions: Float32Array; orientations: Float32Array }, fixedFrame: string): DecodeResult {
  const data: PosesMsg = { count: p.positions.length / 3, positions: p.positions, orientations: p.orientations };
  return {
    meta: { stampNs: Number(p.stamp_ns), frameId: p.frame_id, ...tfMeta(p.tf_status, p.frame_id, fixedFrame) },
    data,
    transfer: [p.positions.buffer, p.orientations.buffer],
  };
}

registerDecoder('path', (_sub, payload, tf, fixedFrame) => posesResult(tf.decodePath(payload, fixedFrame), fixedFrame));
registerDecoder('pose_stamped', (_sub, payload, tf, fixedFrame) => posesResult(tf.decodePoseStamped(payload, fixedFrame), fixedFrame));
registerDecoder('pose_array', (_sub, payload, tf, fixedFrame) => posesResult(tf.decodePoseArray(payload, fixedFrame), fixedFrame));

// ---------------------------------------------------------------------------
// Point clouds (M5)
// ---------------------------------------------------------------------------

export interface PointCloudMsg {
  count: number;
  positions: Float32Array; // xyz × count, fixed frame
  colors: Uint8Array; // rgb × count
  channels: string[];
  transformers: string[];
  /** Transformer actually applied by the worker. */
  transformer: string;
  min: number;
  max: number;
}

function cloudResult(c: {
  frame_id: string; stamp_ns: bigint; tf_status: number; count: number; positions: Float32Array; colors: Uint8Array;
  channels_json: string; transformers_json: string; transformer: string; min: number; max: number;
}, fixedFrame: string): DecodeResult {
  const data: PointCloudMsg = {
    count: c.count, positions: c.positions, colors: c.colors,
    channels: JSON.parse(c.channels_json) as string[], transformers: JSON.parse(c.transformers_json) as string[],
    transformer: c.transformer, min: c.min, max: c.max,
  };
  return {
    meta: { stampNs: Number(c.stamp_ns), frameId: c.frame_id, ...tfMeta(c.tf_status, c.frame_id, fixedFrame) },
    data,
    transfer: [c.positions.buffer, c.colors.buffer],
  };
}

const optionsJson = (sub: Subscription) => JSON.stringify(sub.options.color ?? {});

registerDecoder('point_cloud2', (sub, payload, tf, fixedFrame) => cloudResult(tf.decodePointCloud2(payload, fixedFrame, optionsJson(sub)), fixedFrame));
registerDecoder('laser_scan', (sub, payload, tf, fixedFrame) => cloudResult(tf.decodeLaserScan(payload, fixedFrame, optionsJson(sub)), fixedFrame));

// ---------------------------------------------------------------------------
// Markers (M6)
// ---------------------------------------------------------------------------

/** Values per marker in `MarkerArrayMsg.numeric` (see crates/wasm MARKER_STRIDE). */
export const MARKER_STRIDE = 24;
export const enum MarkerField {
  Id = 0, Type = 1, Action = 2, Px = 3, Qx = 6, Sx = 10, R = 13, LifetimeS = 17, FrameLocked = 18, TfStatus = 19,
  PointsOffset = 20, PointsLen = 21, ColorsOffset = 22, ColorsLen = 23,
}

/**
 * Flat MarkerArray: no per-marker objects cross the thread boundary, so a
 * 5,000-marker message is three typed arrays and one string table.
 */
export interface MarkerArrayMsg {
  count: number;
  numeric: Float64Array;
  /** Per marker: [ns, frame_id, text, mesh_resource, error]. */
  strings: string[][];
  points: Float32Array;
  colors: Uint8Array;
}

function markersResult(d: { count: number; numeric: Float64Array; strings_json: string; points: Float32Array; colors: Uint8Array }): DecodeResult {
  const data: MarkerArrayMsg = { count: d.count, numeric: d.numeric, strings: JSON.parse(d.strings_json) as string[][], points: d.points, colors: d.colors };
  return { meta: { stampNs: 0, frameId: '', inFixedFrame: true, tfError: null }, data, transfer: [d.numeric.buffer, d.points.buffer, d.colors.buffer] };
}

registerDecoder('marker', (_sub, payload, tf, fixedFrame) => markersResult(tf.decodeMarker(payload, fixedFrame)));
registerDecoder('marker_array', (_sub, payload, tf, fixedFrame) => markersResult(tf.decodeMarkerArray(payload, fixedFrame)));
