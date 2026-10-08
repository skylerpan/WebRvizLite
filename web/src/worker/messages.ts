/**
 * Main thread ↔ bridge worker messages. The worker owns the WebSocket, the
 * WASM module, the tf2 buffer and the subscription table; the main thread
 * only sees status, topic lists, tf snapshots and GPU-ready decoded data.
 */

export type Reliability = 'system_default' | 'reliable' | 'best_effort';
export type Durability = 'system_default' | 'transient_local' | 'volatile';
export type History = 'system_default' | 'keep_last' | 'keep_all';

/** Mirrors `core::protocol::QosProfile`. */
export interface QosProfile {
  depth: number;
  history: History;
  reliability: Reliability;
  durability: Durability;
}

export const DEFAULT_QOS: QosProfile = { depth: 5, history: 'keep_last', reliability: 'reliable', durability: 'volatile' };

export interface TopicInfo {
  name: string;
  types: string[];
}

export interface Hello {
  version: string;
  ros_distro: string | null;
  mock: boolean;
  use_sim_time: boolean;
  display_config: string | null;
  fixed_frame: string | null;
  /** WebTransport endpoint offered by the server (absent when disabled). */
  wt?: { port: number; cert_sha256_hex: string; token: string };
}

export type WsState = 'connecting' | 'connected' | 'disconnected';

/** Which worker-side decoder turns the CDR payload into main-thread data. */
export type Decoder =
  | 'none'          // statistics only (debug panel)
  | 'tf'            // feeds the tf buffer, nothing posted
  | 'laser_scan'
  | 'livox_custom_msg'
  | 'point_cloud2'
  | 'occupancy_grid'
  | 'occupancy_grid_update'
  | 'path'
  | 'pose_stamped'
  | 'pose_array'
  | 'marker'
  | 'marker_array'
  | 'pose_with_covariance'
  | 'odometry'
  | 'point_stamped'
  | 'polygon'
  | 'grid_cells'
  | 'range'
  | 'string'
  | 'image'
  | 'camera_info';

/** Per-subscription receive statistics, reported by the worker on request. */
export interface SubscriptionStats {
  id: number;
  topic: string;
  type: string;
  qos: QosProfile;
  messages: number;
  bytes: number;
  hz: number;
  bps: number;
  lastBytes: number;
  lastReceiveMs: number;
  error: string | null;
  /** Transport the last frame arrived on. */
  via: 'ws' | 'wt' | null;
}

/**
 * tf snapshot: all frames' poses in the fixed frame. `poses` holds 9 values per
 * frame: valid, x, y, z, qx, qy, qz, qw, lastUpdateNs. `names`/`parents` are
 * only present when the frame list changed.
 */
export interface TfSnapshotMessage {
  type: 'tf';
  poses: Float64Array<ArrayBufferLike>;
  count: number;
  names?: string[];
  parents?: Int32Array<ArrayBufferLike>;
  fixedFrame: string;
  /** Worker wall time (ns) when taken; compare with lastUpdateNs for Frame Timeout. */
  nowNs: number;
}

/** Decoded message for a subscription; `data` shape depends on the decoder. */
export interface DataMessage {
  type: 'data';
  id: number;
  decoder: Decoder;
  /** Message stamp in ns. */
  stampNs: number;
  frameId: string;
  /** Whether `data` is already expressed in the fixed frame. */
  inFixedFrame: boolean;
  /** Error from the transform step, if any (data then uses the latest transform or is untransformed). */
  tfError: string | null;
  data: unknown;
}

export type MainToWorker =
  | { type: 'subscribe'; id: number; topic: string; msgType: string; qos: QosProfile; decoder: Decoder; options?: Record<string, unknown> }
  | { type: 'unsubscribe'; id: number }
  | { type: 'options'; id: number; options: Record<string, unknown> }
  | { type: 'list_topics' }
  | { type: 'publish'; topic: string; msgType: string; qos: QosProfile; msg: unknown }
  | { type: 'stats'; enabled: boolean }
  | { type: 'set_fixed_frame'; frame: string }
  | { type: 'tf_rate'; hz: number }
  /** Time the tf snapshot is taken at (ns); 0n = latest. Set while the Time panel is paused. */
  | { type: 'tf_time'; timeNs: bigint }
  /** Channel values of one point of the subscription's latest cloud (Selection panel). */
  | { type: 'describe_point'; id: number; index: number; requestId: number };

export type WorkerToMain =
  | { type: 'wasm'; version: string }
  | { type: 'ws'; state: WsState; hello?: Hello }
  | { type: 'topics'; topics: TopicInfo[] }
  | { type: 'clock'; rosTimeNs: bigint; wallTimeNs: bigint }
  | { type: 'error'; id: number | null; message: string }
  | { type: 'stats'; subscriptions: SubscriptionStats[] }
  | { type: 'point_info'; requestId: number; info: { names: string[]; values: number[] } | null }
  /** WebTransport session state for the status bar. */
  | { type: 'transport'; wt: 'off' | 'connecting' | 'on' | 'failed'; detail?: string }
  | TfSnapshotMessage
  | DataMessage;
