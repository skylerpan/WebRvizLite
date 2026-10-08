import { BridgeClient } from '../worker/client';

let instance: BridgeClient | null = null;

/** App-wide bridge singleton, created on first use. */
export function getBridge(): BridgeClient {
  if (!instance) instance = new BridgeClient();
  return instance;
}
