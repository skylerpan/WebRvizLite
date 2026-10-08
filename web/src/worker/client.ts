import { createSignal } from 'solid-js';
import type { DataMessage, Decoder, Hello, MainToWorker, QosProfile, SubscriptionStats, TopicInfo, WorkerToMain, WsState } from './messages';
import { TfSnapshot } from '../render/tf';
import { measure } from '../render/perf';

export type DataHandler = (msg: DataMessage) => void;
export type ErrorHandler = (message: string) => void;

/**
 * Main-thread handle to the bridge worker. One instance per app; displays get
 * it through the DisplayContext (never the raw worker).
 */
export class BridgeClient {
  private readonly worker: Worker;
  private nextId = 1000; // ids below are reserved for the worker's own subscriptions
  private readonly handlers = new Map<number, DataHandler>();
  private readonly errorHandlers = new Map<number, ErrorHandler>();
  private nextRequest = 1;
  private readonly pointRequests = new Map<number, (info: { names: string[]; values: number[] } | null) => void>();
  readonly tf = new TfSnapshot();

  readonly wsState;
  readonly hello;
  readonly wasmVersion;
  readonly topics;
  readonly stats;
  readonly lastError;
  /** Latest server clock: ROS time and server wall time, both ns since epoch. */
  readonly clock;
  /** WebTransport session state (best-effort topics) for the status bar. */
  readonly transport;

  private readonly setWsState;
  private readonly setHello;
  private readonly setWasmVersion;
  private readonly setTopics;
  private readonly setStats;
  private readonly setLastError;
  private readonly setClock;
  private readonly setTransport;

  constructor() {
    [this.wsState, this.setWsState] = createSignal<WsState>('connecting');
    [this.hello, this.setHello] = createSignal<Hello | null>(null);
    [this.wasmVersion, this.setWasmVersion] = createSignal<string | null>(null);
    [this.topics, this.setTopics] = createSignal<TopicInfo[]>([]);
    [this.stats, this.setStats] = createSignal<SubscriptionStats[]>([]);
    [this.lastError, this.setLastError] = createSignal<string | null>(null);
    [this.clock, this.setClock] = createSignal<{ rosTimeNs: bigint; wallTimeNs: bigint } | null>(null);
    [this.transport, this.setTransport] = createSignal<{ wt: 'off' | 'connecting' | 'on' | 'failed'; detail?: string }>({ wt: 'off' });

    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<WorkerToMain>) => this.onMessage(ev.data);
    this.worker.onerror = (e) => console.error('[bridge worker] uncaught', e.message);
  }

  private onMessage(msg: WorkerToMain) {
    switch (msg.type) {
      case 'wasm':
        this.setWasmVersion(msg.version);
        break;
      case 'ws':
        this.setWsState(msg.state);
        if (msg.hello) this.setHello(msg.hello);
        break;
      case 'topics':
        this.setTopics(msg.topics);
        break;
      case 'clock':
        this.setClock({ rosTimeNs: msg.rosTimeNs, wallTimeNs: msg.wallTimeNs });
        break;
      case 'error':
        this.setLastError(msg.message);
        console.warn('[bridge]', msg.id === null ? '' : `sub ${msg.id}:`, msg.message);
        if (msg.id !== null) this.errorHandlers.get(msg.id)?.(msg.message);
        break;
      case 'stats':
        this.setStats(msg.subscriptions);
        break;
      case 'data':
        this.handlers.get(msg.id)?.(msg);
        break;
      case 'tf':
        measure('tf snapshot', () => this.tf.apply(msg));
        break;
      case 'transport':
        this.setTransport({ wt: msg.wt, detail: msg.detail });
        if (msg.detail) console.info('[bridge] transport:', msg.detail);
        break;
      case 'point_info': {
        const resolve = this.pointRequests.get(msg.requestId);
        this.pointRequests.delete(msg.requestId);
        resolve?.(msg.info);
        break;
      }
    }
  }

  private send(msg: MainToWorker) {
    this.worker.postMessage(msg);
  }

  /**
   * Subscribes and returns the subscription id. `onData` receives decoded
   * messages; `onError` the server's reason when the subscription could not be
   * created (e.g. a message type the bridge was built without).
   */
  subscribe(topic: string, msgType: string, qos: QosProfile, decoder: Decoder = 'none', onData?: DataHandler, options?: Record<string, unknown>, onError?: ErrorHandler): number {
    const id = this.nextId++;
    if (onData) this.handlers.set(id, onData);
    if (onError) this.errorHandlers.set(id, onError);
    this.send({ type: 'subscribe', id, topic, msgType, qos, decoder, options });
    return id;
  }

  unsubscribe(id: number) {
    this.handlers.delete(id);
    this.errorHandlers.delete(id);
    this.send({ type: 'unsubscribe', id });
  }

  /** Updates decoder options (e.g. colour transformer settings) without resubscribing. */
  setOptions(id: number, options: Record<string, unknown>) {
    this.send({ type: 'options', id, options });
  }

  listTopics() {
    this.send({ type: 'list_topics' });
  }

  publish(topic: string, msgType: string, qos: QosProfile, msg: unknown) {
    this.send({ type: 'publish', topic, msgType, qos, msg });
  }

  enableStats(enabled: boolean) {
    this.send({ type: 'stats', enabled });
  }

  setFixedFrame(frame: string) {
    this.send({ type: 'set_fixed_frame', frame });
  }

  setTfRate(hz: number) {
    this.send({ type: 'tf_rate', hz });
  }

  /** Channel values of point `index` of subscription `id`'s latest message (needs `selectable` in its options). */
  describePoint(id: number, index: number): Promise<{ names: string[]; values: number[] } | null> {
    const requestId = this.nextRequest++;
    return new Promise((resolve) => {
      this.pointRequests.set(requestId, resolve);
      this.send({ type: 'describe_point', id, index, requestId });
    });
  }

  /** Freezes tf snapshots at `timeNs` (0n = follow the latest transforms). */
  setTfTime(timeNs: bigint) {
    this.send({ type: 'tf_time', timeNs });
  }

  terminate() {
    this.worker.terminate();
  }
}
