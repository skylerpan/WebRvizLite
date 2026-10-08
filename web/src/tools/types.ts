/**
 * Tool interfaces (spec §7.1), mirroring rviz_common::Tool / ToolManager.
 * Exactly one tool is active and receives the 3D view's mouse/keyboard events.
 */

import type { Accessor } from 'solid-js';
import type { Property, YamlMap } from '../property/types';
import type { ViewportPointerEvent } from '../views/types';
import type { ViewManager } from '../views/ViewManager';
import type { BridgeClient } from '../worker/client';

export interface ToolContext {
  readonly views: ViewManager;
  readonly bridge: BridgeClient;
  readonly fixedFrame: Accessor<string>;
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
