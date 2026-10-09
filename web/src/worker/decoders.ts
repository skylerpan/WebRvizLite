/**
 * Worker-side decoders: CDR payload → transferable, GPU-ready data. Each
 * decoder also transforms into the fixed frame when the message carries a
 * header (spec §3: the main thread never sees message objects).
 *
 * Every wasm result object is read exactly once per array (`take*` moves the
 * Vec out with a single copy), the same buffers go into the transfer list, and
 * the object is freed right away instead of waiting for the FinalizationRegistry.
 */

import { ImageConverter, decodeCameraInfo, decodeString, type TfBuffer } from '../wasm/pkg/webrvizlite';
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

/** Runs `use` on a wasm result object and frees it afterwards, whatever happens. */
function consume<T extends { free(): void }, R>(obj: T, use: (o: T) => R): R {
  try {
    return use(obj);
  } finally {
    obj.free();
  }
}

/** Decoder options serialised once per options object (the worker replaces `sub.options` on every change). */
function optionsJson(sub: Subscription, key: string): string {
  if (sub.optionsJson?.for !== sub.options) sub.optionsJson = { for: sub.options, byKey: new Map() };
  let json = sub.optionsJson.byKey.get(key);
  if (json === undefined) {
    json = JSON.stringify(sub.options[key] ?? {});
    sub.optionsJson.byKey.set(key, json);
  }
  return json;
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

registerDecoder('occupancy_grid', (_sub, payload, tf) =>
  consume(tf.decodeOccupancyGrid(payload), (g) => {
    const origin = g.takeOrigin();
    const cells = g.takeData();
    const data: OccupancyGridMsg = { resolution: g.resolution, width: g.width, height: g.height, origin, data: cells };
    const meta = { stampNs: Number(g.stamp_ns), frameId: g.frame_id, inFixedFrame: false, tfError: null };
    return { meta, data, transfer: [cells.buffer, origin.buffer] };
  }));

registerDecoder('occupancy_grid_update', (_sub, payload, tf) =>
  consume(tf.decodeOccupancyGridUpdate(payload), (u) => {
    const cells = u.takeData();
    const data: OccupancyGridUpdateMsg = { x: u.x, y: u.y, width: u.width, height: u.height, data: cells };
    const meta = { stampNs: Number(u.stamp_ns), frameId: u.frame_id, inFixedFrame: false, tfError: null };
    return { meta, data, transfer: [cells.buffer] };
  }));

interface PosesLike {
  frame_id: string;
  stamp_ns: bigint;
  tf_status: number;
  takePositions(): Float32Array;
  takeOrientations(): Float32Array;
  free(): void;
}

function posesResult(p: PosesLike, fixedFrame: string): DecodeResult {
  return consume(p, (o) => {
    const positions = o.takePositions();
    const orientations = o.takeOrientations();
    const data: PosesMsg = { count: positions.length / 3, positions, orientations };
    return {
      meta: { stampNs: Number(o.stamp_ns), frameId: o.frame_id, ...tfMeta(o.tf_status, o.frame_id, fixedFrame) },
      data,
      transfer: [positions.buffer, orientations.buffer],
    };
  });
}

/** Pose + covariance visual (PoseWithCovariance / Odometry); see wasm PoseCovData. */
export interface PoseCovMsg extends PosesMsg {
  childFrameId: string;
  covariance: Float64Array;
  /** [sx, sy, sz, qx, qy, qz, qw] in the fixed frame, or empty. */
  ellipsoid: Float32Array;
  /** 3 × [axis, a, b, angle] discs, or [halfAngle] when 2-D, or empty. */
  orientation: Float32Array;
  is2d: boolean;
}

export interface PointsMsg {
  count: number;
  positions: Float32Array;
}

export interface GridCellsMsg extends PointsMsg {
  cellWidth: number;
  cellHeight: number;
}

export interface RangeMsg extends PosesMsg {
  range: number;
  fieldOfView: number;
  minRange: number;
  maxRange: number;
}

interface PoseCovLike extends PosesLike {
  child_frame_id: string;
  is_2d: boolean;
  takeCovariance(): Float64Array;
  takeEllipsoid(): Float32Array;
  takeOrientation(): Float32Array;
}

function poseCovResult(p: PoseCovLike, fixedFrame: string): DecodeResult {
  return consume(p, (o) => {
    const positions = o.takePositions();
    const orientations = o.takeOrientations();
    const covariance = o.takeCovariance();
    const ellipsoid = o.takeEllipsoid();
    const orientation = o.takeOrientation();
    const data: PoseCovMsg = { count: 1, positions, orientations, childFrameId: o.child_frame_id, covariance, ellipsoid, orientation, is2d: o.is_2d };
    return {
      meta: { stampNs: Number(o.stamp_ns), frameId: o.frame_id, ...tfMeta(o.tf_status, o.frame_id, fixedFrame) },
      data,
      transfer: [positions.buffer, orientations.buffer, covariance.buffer, ellipsoid.buffer, orientation.buffer],
    };
  });
}

registerDecoder('pose_with_covariance', (sub, payload, tf, fixedFrame) => poseCovResult(tf.decodePoseWithCovariance(payload, fixedFrame, optionsJson(sub, 'covariance')), fixedFrame));
registerDecoder('odometry', (sub, payload, tf, fixedFrame) => poseCovResult(tf.decodeOdometry(payload, fixedFrame, optionsJson(sub, 'covariance')), fixedFrame));
registerDecoder('point_stamped', (_sub, payload, tf, fixedFrame) => posesResult(tf.decodePointStamped(payload, fixedFrame), fixedFrame));
registerDecoder('polygon', (_sub, payload, tf, fixedFrame) =>
  consume(tf.decodePolygonStamped(payload, fixedFrame), (p) => {
    const positions = p.takePositions();
    const data: PointsMsg = { count: positions.length / 3, positions };
    return { meta: { stampNs: Number(p.stamp_ns), frameId: p.frame_id, ...tfMeta(p.tf_status, p.frame_id, fixedFrame) }, data, transfer: [positions.buffer] };
  }));
registerDecoder('grid_cells', (_sub, payload, tf, fixedFrame) =>
  consume(tf.decodeGridCells(payload, fixedFrame), (g) => {
    const positions = g.takePositions();
    const data: GridCellsMsg = { count: positions.length / 3, positions, cellWidth: g.cell_width, cellHeight: g.cell_height };
    return { meta: { stampNs: Number(g.stamp_ns), frameId: g.frame_id, ...tfMeta(g.tf_status, g.frame_id, fixedFrame) }, data, transfer: [positions.buffer] };
  }));
registerDecoder('range', (_sub, payload, tf, fixedFrame) =>
  consume(tf.decodeRange(payload, fixedFrame), (r) => {
    const positions = r.takePositions();
    const orientations = r.takeOrientations();
    const data: RangeMsg = { count: 1, positions, orientations, range: r.range, fieldOfView: r.field_of_view, minRange: r.min_range, maxRange: r.max_range };
    return { meta: { stampNs: Number(r.stamp_ns), frameId: r.frame_id, ...tfMeta(r.tf_status, r.frame_id, fixedFrame) }, data, transfer: [positions.buffer, orientations.buffer] };
  }));

/** RGBA8 frame for the Image / Camera panels (the buffer is transferred). */
export interface ImageMsg {
  width: number;
  height: number;
  encoding: string;
  rgba: Uint8Array;
}

export interface CameraInfoMsg {
  width: number;
  height: number;
  /** 3×3 row-major intrinsics. */
  k: Float64Array;
  /** 3×4 projection. */
  p: Float64Array;
  binningX: number;
  binningY: number;
  /** x_offset, y_offset, height, width */
  roi: Uint32Array;
}

registerDecoder('image', (sub, payload) => {
  sub.imageConverter ??= new ImageConverter();
  return consume(sub.imageConverter.convert(payload, optionsJson(sub, 'image')), (img) => {
    const rgba = img.takeRgba();
    const data: ImageMsg = { width: img.width, height: img.height, encoding: img.encoding, rgba };
    return { meta: { stampNs: Number(img.stamp_ns), frameId: img.frame_id, inFixedFrame: false, tfError: null }, data, transfer: [rgba.buffer] };
  });
});
registerDecoder('camera_info', (_sub, payload) =>
  consume(decodeCameraInfo(payload), (c) => {
    const k = c.takeK();
    const p = c.takeP();
    const roi = c.takeRoi();
    const data: CameraInfoMsg = { width: c.width, height: c.height, k, p, binningX: c.binning_x, binningY: c.binning_y, roi };
    return { meta: { stampNs: Number(c.stamp_ns), frameId: c.frame_id, inFixedFrame: false, tfError: null }, data, transfer: [k.buffer, p.buffer, roi.buffer] };
  }));

registerDecoder('string', (_sub, payload) => ({ meta: { stampNs: 0, frameId: '', inFixedFrame: true, tfError: null }, data: { text: decodeString(payload) }, transfer: [] }));

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

interface CloudLike {
  frame_id: string;
  stamp_ns: bigint;
  tf_status: number;
  count: number;
  channels_json: string;
  transformers_json: string;
  transformer: string;
  min: number;
  max: number;
  takePositions(): Float32Array;
  takeColors(): Uint8Array;
  free(): void;
}

function cloudResult(c: CloudLike, fixedFrame: string): DecodeResult {
  return consume(c, (o) => {
    const positions = o.takePositions();
    const colors = o.takeColors();
    const data: PointCloudMsg = {
      count: o.count, positions, colors,
      channels: JSON.parse(o.channels_json) as string[], transformers: JSON.parse(o.transformers_json) as string[],
      transformer: o.transformer, min: o.min, max: o.max,
    };
    return {
      meta: { stampNs: Number(o.stamp_ns), frameId: o.frame_id, ...tfMeta(o.tf_status, o.frame_id, fixedFrame) },
      data,
      transfer: [positions.buffer, colors.buffer],
    };
  });
}

registerDecoder('point_cloud2', (sub, payload, tf, fixedFrame) => cloudResult(tf.decodePointCloud2(payload, fixedFrame, optionsJson(sub, 'color')), fixedFrame));
registerDecoder('laser_scan', (sub, payload, tf, fixedFrame) => cloudResult(tf.decodeLaserScan(payload, fixedFrame, optionsJson(sub, 'color')), fixedFrame));
registerDecoder('livox_custom_msg', (sub, payload, tf, fixedFrame) => cloudResult(tf.decodeLivoxCustomMsg(payload, fixedFrame, optionsJson(sub, 'color')), fixedFrame));

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

interface MarkersLike {
  count: number;
  strings_json: string;
  takeNumeric(): Float64Array;
  takePoints(): Float32Array;
  takeColors(): Uint8Array;
  free(): void;
}

function markersResult(d: MarkersLike): DecodeResult {
  return consume(d, (o) => {
    const numeric = o.takeNumeric();
    const points = o.takePoints();
    const colors = o.takeColors();
    const data: MarkerArrayMsg = { count: o.count, numeric, strings: JSON.parse(o.strings_json) as string[][], points, colors };
    return { meta: { stampNs: 0, frameId: '', inFixedFrame: true, tfError: null }, data, transfer: [numeric.buffer, points.buffer, colors.buffer] };
  });
}

registerDecoder('marker', (_sub, payload, tf, fixedFrame) => markersResult(tf.decodeMarker(payload, fixedFrame)));
registerDecoder('marker_array', (_sub, payload, tf, fixedFrame) => markersResult(tf.decodeMarkerArray(payload, fixedFrame)));
