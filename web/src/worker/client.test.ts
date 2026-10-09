import { describe, expect, it, vi } from 'vitest';
import { BridgeClient, type WorkerLike } from './client';
import type { DataMessage, MainToWorker, WorkerToMain } from './messages';

function fakeWorker() {
  const sent: MainToWorker[] = [];
  const w: WorkerLike & { emit(msg: WorkerToMain): void } = {
    postMessage: (m) => sent.push(m),
    onmessage: null,
    onerror: null,
    terminate() {},
    emit(msg) {
      w.onmessage?.({ data: msg } as MessageEvent<WorkerToMain>);
    },
  };
  return { w, sent };
}

const data = (id: number, seq: number, payload = 'x'): DataMessage => ({ type: 'data', id, seq, decoder: 'none', stampNs: 0, frameId: '', inFixedFrame: true, tfError: null, data: payload });

describe('BridgeClient latest-only delivery', () => {
  it('queues data until flushPending, keeps only the newest latest-only message, and acks it', () => {
    const { w, sent } = fakeWorker();
    const client = new BridgeClient(w);
    const got: unknown[] = [];
    const cloud = client.subscribe('/points', 'sensor_msgs/msg/PointCloud2', { depth: 5, history: 'keep_last', reliability: 'reliable', durability: 'volatile' }, 'point_cloud2', (m) => got.push(m.data), { latestOnly: true });
    const markers = client.subscribe('/markers', 'visualization_msgs/msg/MarkerArray', { depth: 5, history: 'keep_last', reliability: 'reliable', durability: 'volatile' }, 'marker_array', (m) => got.push(m.data));
    w.emit(data(cloud, 1, 'c1'));
    w.emit(data(markers, 1, 'm1'));
    w.emit(data(cloud, 2, 'c2'));
    expect(got).toEqual([]);
    client.flushPending();
    expect(got).toEqual(['m1', 'c2']);
    expect(client.droppedPending()).toBe(1);
    const acks = sent.filter((m) => m.type === 'ack');
    expect(acks).toEqual([{ type: 'ack', id: cloud, seq: 2 }]);
    client.flushPending();
    expect(got).toEqual(['m1', 'c2']);
  });

  it('acks even when the handler throws, and drops queued messages on unsubscribe', () => {
    const { w, sent } = fakeWorker();
    const client = new BridgeClient(w);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const id = client.subscribe('/img', 'sensor_msgs/msg/Image', { depth: 5, history: 'keep_last', reliability: 'best_effort', durability: 'volatile' }, 'image', () => { throw new Error('boom'); }, { latestOnly: true });
    w.emit(data(id, 1));
    client.flushPending();
    expect(sent.some((m) => m.type === 'ack' && m.id === id && m.seq === 1)).toBe(true);
    expect(client.lastError()).toContain('boom');
    spy.mockRestore();
    w.emit(data(id, 2));
    client.unsubscribe(id);
    client.flushPending();
    expect(sent.filter((m) => m.type === 'ack')).toHaveLength(1);
  });

  it('applies the queued message before switching a subscription to ordered delivery', () => {
    const { w, sent } = fakeWorker();
    const client = new BridgeClient(w);
    const got: number[] = [];
    const id = client.subscribe('/points', 'sensor_msgs/msg/PointCloud2', { depth: 5, history: 'keep_last', reliability: 'reliable', durability: 'volatile' }, 'point_cloud2', (m) => got.push(m.seq), { latestOnly: true });
    w.emit(data(id, 1));
    client.setOptions(id, { latestOnly: false });
    expect(got).toEqual([1]);
    const idx = sent.findIndex((m) => m.type === 'options');
    expect(sent.slice(0, idx).some((m) => m.type === 'ack' && m.seq === 1)).toBe(true);
    w.emit(data(id, 2));
    w.emit(data(id, 3));
    client.flushPending();
    expect(got).toEqual([1, 2, 3]);
    expect(sent.filter((m) => m.type === 'ack')).toHaveLength(1);
  });
});
