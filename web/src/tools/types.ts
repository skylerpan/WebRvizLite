/**
 * Tool interfaces (spec §7.1), mirroring rviz_common::Tool / ToolManager.
 * Exactly one tool is active and receives the 3D view's mouse/keyboard events.
 */

import type { Accessor } from 'solid-js';
import type * as THREE from 'three/webgpu';
import type { Property, YamlMap } from '../property/types';
import type { ViewportPointerEvent } from '../views/types';
import type { ViewManager } from '../views/ViewManager';
import type { BridgeClient } from '../worker/client';
import type { PickHit } from '../render/picking';
import type { SelectionManager } from '../app/selection';

/**
 * Hover previews (Publish Point, Focus Camera, Measure) pick at most this often;
 * each pick re-renders the scene, so 10 Hz keeps the main thread free.
 */
export const HOVER_INTERVAL_MS = 100;

/** Services of the 3D view that tools use (rviz RenderPanel / ViewPicker / ViewportProjectionFinder). */
export interface ViewportServices {
  camera(): THREE.Camera;
  size(): { width: number; height: number };
  /** World-space ray through viewport pixel (x, y); works for perspective and orthographic cameras. */
  ray(x: number, y: number, out: THREE.Ray): THREE.Ray;
  /** Intersection of that ray with the fixed frame's z = 0 plane (rviz ViewportProjectionFinder). */
  groundPoint(x: number, y: number, out: THREE.Vector3): boolean;
  /** Colour-ID pick of the objects under a viewport box (M10). */
  pick(x: number, y: number, w: number, h: number): Promise<PickHit[]>;
  /** The nearest surface point under a pixel, with its owner if the object is selectable. */
  pickPoint(x: number, y: number): Promise<PickHit | null>;
  /** True while a pick is queued or running; hover previews skip their pick then. */
  pickBusy(): boolean;
  setCursor(cursor: 'default' | 'crosshair' | 'move' | 'grab' | 'pointer'): void;
  /** Status bar text while the tool is active (rviz Tool::setStatus). */
  setStatus(text: string): void;
  /** Scene node for tool-drawn geometry (pose arrow preview, measure line); never pickable. */
  readonly helpers: THREE.Group;
  /** Last known cursor position over the view, for keyboard actions such as F. */
  lastMouse(): { x: number; y: number };
  /** Rubber-band rectangle overlay (Select tool); null hides it. */
  setSelectBox(box: { x: number; y: number; w: number; h: number } | null): void;
}

export interface ToolContext {
  readonly views: ViewManager;
  readonly bridge: BridgeClient;
  readonly fixedFrame: Accessor<string>;
  /** Null until the 3D view is mounted. */
  readonly viewport: () => ViewportServices | null;
  /** ROS time for message stamps (frozen while the Time panel is paused). */
  readonly rosTimeNs: Accessor<bigint>;
  readonly selection: SelectionManager;
  /** Switch back to the default tool (after one-shot tools like SetGoal). */
  readonly revertToDefault: () => void;
}

export interface Tool {
  readonly classId: string;
  /** Toolbar label, e.g. "Move Camera", "2D Goal Pose". */
  readonly name: Accessor<string>;
  /** Single-letter shortcut, or '' */
  readonly shortcut: string;
  /** Root of the tool's properties (Tool Properties panel); may have no children. */
  readonly properties: Property;
  /** False for config entries whose class is not implemented (greyed in the toolbar). */
  readonly available: boolean;
  initialize(ctx: ToolContext): void;
  activate(): void;
  deactivate(): void;
  handleMouse(e: ViewportPointerEvent): void;
  /** Return true if the key was consumed. */
  handleKey(key: string, e: KeyboardEvent): boolean;
  save(): YamlMap;
  load(yaml: YamlMap): void;
}

export interface ToolClassInfo {
  readonly classId: string;
  readonly name: string;
  readonly description: string;
  readonly shortcut: string;
}

/** ROS `builtin_interfaces/Time` fields from a ns timestamp (wall clock when the server has no clock yet). */
export function stampFromNs(ns: bigint): { sec: number; nanosec: number } {
  const t = ns > 0n ? ns : BigInt(Date.now()) * 1_000_000n;
  return { sec: Number(t / 1_000_000_000n), nanosec: Number(t % 1_000_000_000n) };
}
