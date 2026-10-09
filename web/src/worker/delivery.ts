/**
 * Latest-only delivery between the bridge worker and the main thread.
 *
 * Main thread: decoded messages are queued (`PendingQueue`) and applied once
 * per frame at the start of `VisualizationManager.update()`. For subscriptions
 * marked `latestOnly` a newer message replaces the queued one, so a display
 * never applies two clouds for one rendered frame. One FIFO for all
 * subscriptions keeps the arrival order across topics (a map and its updates,
 * an image and its CameraInfo).
 *
 * Worker: `DeliveryGate` stops decoding a latest-only subscription while a
 * message is still unacknowledged by the main thread; the newest raw payload
 * is kept and decoded when the ack arrives. Depth 1: the main thread applies
 * at most one message per frame, so a second in-flight message would only be
 * transferred and overwritten.
 */

export interface Queued<T> {
  id: number;
  msg: T;
  latestOnly: boolean;
}

export class PendingQueue<T> {
  private items: Queued<T>[] = [];
  /** Messages replaced by a newer one before they were applied. */
  dropped = 0;

  push(id: number, msg: T, latestOnly: boolean) {
    if (latestOnly) {
      const i = this.items.findIndex((q) => q.id === id);
      if (i >= 0) {
        this.items.splice(i, 1);
        this.dropped++;
      }
    }
    this.items.push({ id, msg, latestOnly });
  }

  /** Drops everything queued for a subscription (unsubscribe). */
  remove(id: number) {
    if (this.items.some((q) => q.id === id)) this.items = this.items.filter((q) => q.id !== id);
  }

  /** Removes and returns the queued message of one subscription, if any. */
  take(id: number): Queued<T> | undefined {
    const i = this.items.findIndex((q) => q.id === id);
    if (i < 0) return undefined;
    return this.items.splice(i, 1)[0];
  }

  /** Dispatches everything queued so far, in arrival order; messages queued by `dispatch` wait for the next flush. */
  flush(dispatch: (q: Queued<T>) => void) {
    if (this.items.length === 0) return;
    const batch = this.items;
    this.items = [];
    for (const q of batch) dispatch(q);
  }

  get size() {
    return this.items.length;
  }
}

interface GateEntry {
  sentSeq: number;
  ackedSeq: number;
  deferred: Uint8Array | undefined;
  dropped: number;
}

export class DeliveryGate {
  private readonly entries = new Map<number, GateEntry>();

  private entry(id: number): GateEntry {
    let e = this.entries.get(id);
    if (!e) {
      e = { sentSeq: 0, ackedSeq: 0, deferred: undefined, dropped: 0 };
      this.entries.set(id, e);
    }
    return e;
  }

  /** Whether a frame may be decoded now; a latest-only subscription with an unacked message keeps the payload instead. */
  offer(id: number, payload: Uint8Array, latestOnly: boolean): 'decode' | 'defer' {
    const e = this.entry(id);
    if (!latestOnly || e.sentSeq <= e.ackedSeq) return 'decode';
    if (e.deferred) e.dropped++;
    e.deferred = payload;
    return 'defer';
  }

  /** Sequence number for a message about to be posted. */
  sent(id: number): number {
    return ++this.entry(id).sentSeq;
  }

  /** Records the main thread's ack; returns a deferred payload that can be decoded now. */
  ack(id: number, seq: number): Uint8Array | undefined {
    const e = this.entries.get(id);
    if (!e) return undefined;
    e.ackedSeq = Math.max(e.ackedSeq, seq);
    if (e.sentSeq > e.ackedSeq) return undefined;
    const d = e.deferred;
    e.deferred = undefined;
    return d;
  }

  /** Leaves latest-only mode: nothing is gated any more; returns the deferred payload to decode. */
  drain(id: number): Uint8Array | undefined {
    const e = this.entries.get(id);
    if (!e) return undefined;
    e.ackedSeq = e.sentSeq;
    const d = e.deferred;
    e.deferred = undefined;
    return d;
  }

  release(id: number) {
    this.entries.delete(id);
  }

  dropped(id: number): number {
    return this.entries.get(id)?.dropped ?? 0;
  }
}
