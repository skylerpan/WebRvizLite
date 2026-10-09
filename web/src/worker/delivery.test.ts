import { describe, expect, it } from 'vitest';
import { DeliveryGate, PendingQueue } from './delivery';

describe('PendingQueue', () => {
  it('replaces a queued latest-only message, keeps ordered ones, preserves arrival order across subscriptions', () => {
    const q = new PendingQueue<string>();
    q.push(1, 'cloud-1', true);
    q.push(2, 'marker-1', false);
    q.push(1, 'cloud-2', true);
    q.push(2, 'marker-2', false);
    expect(q.size).toBe(3);
    expect(q.dropped).toBe(1);
    const out: string[] = [];
    q.flush((m) => out.push(m.msg));
    // cloud-2 took cloud-1's place but keeps the later arrival position relative to marker-1.
    expect(out).toEqual(['marker-1', 'cloud-2', 'marker-2']);
    expect(q.size).toBe(0);
  });

  it('removes a subscription and takes a single entry', () => {
    const q = new PendingQueue<number>();
    q.push(1, 10, true);
    q.push(2, 20, false);
    q.push(2, 21, false);
    expect(q.take(1)?.msg).toBe(10);
    expect(q.take(1)).toBeUndefined();
    q.remove(2);
    expect(q.size).toBe(0);
  });

  it('messages queued during a flush wait for the next flush', () => {
    const q = new PendingQueue<number>();
    q.push(1, 1, false);
    const seen: number[] = [];
    q.flush((m) => {
      seen.push(m.msg);
      if (m.msg === 1) q.push(1, 2, false);
    });
    expect(seen).toEqual([1]);
    expect(q.size).toBe(1);
  });
});

describe('DeliveryGate', () => {
  const payload = (n: number) => new Uint8Array([n]);

  it('lets ordered subscriptions through and gates latest-only ones until the ack', () => {
    const g = new DeliveryGate();
    expect(g.offer(5, payload(1), false)).toBe('decode');
    g.sent(5);
    expect(g.offer(5, payload(2), false)).toBe('decode');

    expect(g.offer(7, payload(1), true)).toBe('decode');
    const seq1 = g.sent(7);
    expect(g.offer(7, payload(2), true)).toBe('defer');
    expect(g.offer(7, payload(3), true)).toBe('defer');
    expect(g.dropped(7)).toBe(1);
    // Ack of an older seq does not release; the matching one hands back the newest deferred payload.
    expect(g.ack(7, seq1 - 1)).toBeUndefined();
    expect(g.ack(7, seq1)?.[0]).toBe(3);
    expect(g.offer(7, payload(4), true)).toBe('decode');
  });

  it('drain leaves latest-only mode and release forgets the subscription', () => {
    const g = new DeliveryGate();
    g.offer(1, payload(1), true);
    g.sent(1);
    g.offer(1, payload(2), true);
    expect(g.drain(1)?.[0]).toBe(2);
    expect(g.offer(1, payload(3), true)).toBe('decode');
    g.release(1);
    expect(g.dropped(1)).toBe(0);
    expect(g.ack(1, 1)).toBeUndefined();
  });
});
