/**
 * Lightweight main-thread profiling for the `?perf` overlay: worst and
 * cumulative time per named section since the last reset. Costs one
 * `performance.now()` pair per call; sections are reported in the status bar.
 */

import { createSignal } from 'solid-js';

interface Section {
  worstMs: number;
  totalMs: number;
  calls: number;
}

const sections = new Map<string, Section>();
export const [perfVersion, setPerfVersion] = createSignal(0);
let enabled = false;
let lastPublish = 0;

export function enablePerf(on: boolean) {
  enabled = on;
}

export function perfEnabled() {
  return enabled;
}

export function measure<T>(name: string, fn: () => T): T {
  if (!enabled) return fn();
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    record(name, performance.now() - t0);
  }
}

/** Like `measure` for a promise-returning function (records when it settles). */
export async function measureAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (!enabled) return fn();
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    record(name, performance.now() - t0);
  }
}

export function record(name: string, ms: number) {
  if (!enabled) return;
  let s = sections.get(name);
  if (!s) {
    s = { worstMs: 0, totalMs: 0, calls: 0 };
    sections.set(name, s);
  }
  s.calls++;
  s.totalMs += ms;
  if (ms > s.worstMs) s.worstMs = ms;
  const now = performance.now();
  if (now - lastPublish > 500) {
    lastPublish = now;
    setPerfVersion(perfVersion() + 1);
  }
}

export function resetPerf() {
  sections.clear();
  setPerfVersion(perfVersion() + 1);
}

/** Sections sorted by worst time, formatted for the overlay. */
export function perfSummary(): string {
  perfVersion();
  return [...sections.entries()]
    .sort((a, b) => b[1].worstMs - a[1].worstMs)
    .slice(0, 6)
    .map(([n, s]) => `${n} ${s.worstMs.toFixed(1)}ms×${s.calls}`)
    .join(' · ');
}
