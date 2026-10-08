// Bridge worker: owns the WebSocket, the WASM module, the tf2 buffer and the
// subscription table. Reconnects automatically and replays subscriptions.
// Decoding happens here; the main thread receives transferable buffers.
//
// Compiled against the DOM lib for simplicity; everything used here
// (WebSocket, postMessage, location) exists in both DOM and worker scopes.

import init, { TfBuffer, version } from '../wasm/pkg/webrvizlite';
import type { Decoder, Hello, MainToWorker, QosProfile, SubscriptionStats, WorkerToMain } from './messages';
import { decodeMessage } from './decoders';

const post = (msg: WorkerToMain, transfer?: Transferable[]) => (transfer ? postMessage(msg, { transfer }) : postMessage(msg));

const FRAME_HEADER_SIZE = 13;
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 5000;
const STATS_PERIOD_MS = 250;
const RATE_WINDOW_MS = 1000;
const TF_CACHE_SECONDS = 10;
const SNAPSHOT_STRIDE = 9;

/** Reserved ids for the worker's own subscriptions (spec §4.3: /tf and /tf_static are automatic). */
export const TF_SUB_ID = 1;
export const TF_STATIC_SUB_ID = 2;

export interface Subscription {
  id: number;
  topic: string;
  msgType: string;
  qos: QosProfile;
  decoder: Decoder;
  options: Record<string, unknown>;
  messages: number;
  bytes: number;
  lastBytes: number;
  lastReceiveMs: number;
  error: string | null;
  recent: Array<[number, number]>;
}

const subscriptions = new Map<number, Subscription>();
let ws: WebSocket | null = null;
let connected = false;
let reconnectDelay = RECONNECT_MIN_MS;
let statsTimer: ReturnType<typeof setInterval> | null = null;
let tfTimer: ReturnType<typeof setInterval> | null = null;
let tfRateHz = 30;
let fixedFrame = 'map';
/** tf snapshot time (ns); 0n = latest (Time panel Pause sets a fixed time). */
let tfTimeNs = 0n;
let tfBuffer: TfBuffer | null = null;
let lastFrameCount = -1;
let lastNamesJson = '';

export const wallNowNs = () => BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6));

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

function sendControl(msg: unknown) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function sendSubscribe(s: Subscription) {
  sendControl({ op: 'subscribe', id: s.id, topic: s.topic, type: s.msgType, qos: s.qos });
}

function connect() {
  post({ type: 'ws', state: 'connecting' });
  const socket = new WebSocket(wsUrl());
  socket.binaryType = 'arraybuffer';
  ws = socket;
  socket.onmessage = (ev: MessageEvent) => {
    if (typeof ev.data === 'string') onControl(ev.data);
    else onFrame(ev.data as ArrayBuffer);
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    connected = false;
    post({ type: 'ws', state: 'disconnected' });
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  };
  socket.onerror = () => { /* onclose follows */ };
}

function onControl(text: string) {
  let msg: { op: string } & Record<string, unknown>;
  try {
    msg = JSON.parse(text);
  } catch (e) {
    post({ type: 'error', id: null, message: `bad control message: ${String(e)}` });
    return;
  }
  switch (msg.op) {
    case 'hello': {
      const { op: _op, ...hello } = msg;
      connected = true;
      reconnectDelay = RECONNECT_MIN_MS;
      ensureTfSubscriptions();
      for (const s of subscriptions.values()) {
        s.error = null;
        sendSubscribe(s);
      }
      post({ type: 'ws', state: 'connected', hello: hello as unknown as Hello });
      break;
    }
    case 'topics':
      post({ type: 'topics', topics: msg.topics as never });
      break;
    case 'clock':
      post({ type: 'clock', rosTimeNs: BigInt(msg.ros_time_ns as number), wallTimeNs: BigInt(msg.wall_time_ns as number) });
      break;
    case 'error': {
      const id = (msg.id as number | null) ?? null;
      const message = String(msg.message);
      if (id !== null) {
        const s = subscriptions.get(id);
        if (s) s.error = message;
      }
      post({ type: 'error', id, message });
      break;
    }
    default:
      post({ type: 'error', id: null, message: `unknown server op: ${msg.op}` });
  }
}

function onFrame(buf: ArrayBuffer) {
  if (buf.byteLength < FRAME_HEADER_SIZE) return;
  const dv = new DataView(buf);
  const kind = dv.getUint8(0);
  const id = dv.getUint32(1, true);
  const receiveNs = dv.getBigUint64(5, true);
  if (kind !== 0) return;
  const s = subscriptions.get(id);
  if (!s) return;
  const now = performance.now();
  const payload = new Uint8Array(buf, FRAME_HEADER_SIZE);
  s.messages += 1;
  s.bytes += payload.byteLength;
  s.lastBytes = payload.byteLength;
  s.lastReceiveMs = Number(receiveNs / 1_000_000n);
  s.recent.push([now, payload.byteLength]);

  if (s.decoder === 'tf') {
    try {
      tfBuffer?.pushTfMessage(payload, id === TF_STATIC_SUB_ID, wallNowNs());
      s.error = null;
    } catch (e) {
      s.error = `TF decode failed: ${String(e)}`;
    }
    return;
  }
  if (s.decoder === 'none' || !tfBuffer) return;
  try {
    const result = decodeMessage(s, payload, tfBuffer, fixedFrame);
    if (result) {
      post({ type: 'data', id, decoder: s.decoder, ...result.meta, data: result.data }, result.transfer);
      s.error = null;
    }
  } catch (e) {
    s.error = `decode failed: ${String(e)}`;
    post({ type: 'error', id, message: s.error });
  }
}

function ensureTfSubscriptions() {
  const tfQos: QosProfile = { depth: 100, history: 'keep_last', reliability: 'reliable', durability: 'volatile' };
  const tfStaticQos: QosProfile = { depth: 100, history: 'keep_last', reliability: 'reliable', durability: 'transient_local' };
  if (!subscriptions.has(TF_SUB_ID)) addSubscription(TF_SUB_ID, '/tf', 'tf2_msgs/msg/TFMessage', tfQos, 'tf', {}, false);
  if (!subscriptions.has(TF_STATIC_SUB_ID)) addSubscription(TF_STATIC_SUB_ID, '/tf_static', 'tf2_msgs/msg/TFMessage', tfStaticQos, 'tf', {}, false);
}

function addSubscription(id: number, topic: string, msgType: string, qos: QosProfile, decoder: Decoder, options: Record<string, unknown>, send: boolean) {
  const s: Subscription = { id, topic, msgType, qos, decoder, options, messages: 0, bytes: 0, lastBytes: 0, lastReceiveMs: 0, error: null, recent: [] };
  subscriptions.set(id, s);
  if (send && connected) sendSubscribe(s);
}

function snapshotStats(): SubscriptionStats[] {
  const now = performance.now();
  const out: SubscriptionStats[] = [];
  for (const s of subscriptions.values()) {
    while (s.recent.length && now - s.recent[0][0] > RATE_WINDOW_MS) s.recent.shift();
    let bytes = 0;
    for (const [, b] of s.recent) bytes += b;
    out.push({
      id: s.id, topic: s.topic, type: s.msgType, qos: s.qos,
      messages: s.messages, bytes: s.bytes,
      hz: s.recent.length * (1000 / RATE_WINDOW_MS),
      bps: bytes * (1000 / RATE_WINDOW_MS),
      lastBytes: s.lastBytes, lastReceiveMs: s.lastReceiveMs, error: s.error,
    });
  }
  return out;
}

/** Posts the poses of all frames relative to the fixed frame (M3 tf snapshot). */
function postTfSnapshot() {
  if (!tfBuffer) return;
  const count = tfBuffer.frameCount();
  const poses = new Float64Array(Math.max(1, count * SNAPSHOT_STRIDE));
  const n = tfBuffer.snapshot(fixedFrame, tfTimeNs, poses);
  const msg: WorkerToMain & { type: 'tf' } = { type: 'tf', poses, count: n, fixedFrame, nowNs: Number(wallNowNs()) };
  const namesJson = count === lastFrameCount ? lastNamesJson : tfBuffer.frameNamesJson();
  if (count !== lastFrameCount || namesJson !== lastNamesJson) {
    msg.names = JSON.parse(namesJson) as string[];
    msg.parents = tfBuffer.parentIndices();
    lastFrameCount = count;
    lastNamesJson = namesJson;
  }
  post(msg, [poses.buffer]);
}

function setTfRate(hz: number) {
  tfRateHz = Math.max(1, Math.min(120, hz));
  if (tfTimer) clearInterval(tfTimer);
  tfTimer = setInterval(postTfSnapshot, 1000 / tfRateHz);
}

onmessage = (ev: MessageEvent<MainToWorker>) => {
  const m = ev.data;
  switch (m.type) {
    case 'subscribe':
      addSubscription(m.id, m.topic, m.msgType, m.qos, m.decoder, m.options ?? {}, true);
      break;
    case 'unsubscribe':
      if (subscriptions.delete(m.id)) sendControl({ op: 'unsubscribe', id: m.id });
      break;
    case 'options': {
      const s = subscriptions.get(m.id);
      if (s) s.options = { ...s.options, ...m.options };
      break;
    }
    case 'list_topics':
      sendControl({ op: 'list_topics' });
      break;
    case 'publish':
      sendControl({ op: 'publish', topic: m.topic, type: m.msgType, qos: m.qos, msg: m.msg });
      break;
    case 'stats':
      if (statsTimer) clearInterval(statsTimer);
      statsTimer = m.enabled ? setInterval(() => post({ type: 'stats', subscriptions: snapshotStats() }), STATS_PERIOD_MS) : null;
      break;
    case 'set_fixed_frame':
      fixedFrame = m.frame;
      postTfSnapshot();
      break;
    case 'tf_rate':
      setTfRate(m.hz);
      break;
    case 'tf_time':
      tfTimeNs = m.timeNs;
      postTfSnapshot();
      break;
  }
};

async function main() {
  await init();
  tfBuffer = new TfBuffer(TF_CACHE_SECONDS);
  post({ type: 'wasm', version: version() });
  setTfRate(tfRateHz);
  connect();
}

main().catch((e) => post({ type: 'error', id: null, message: String(e) }));
