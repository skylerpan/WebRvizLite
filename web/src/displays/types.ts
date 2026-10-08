/**
 * Display interfaces — proposal for M2 (spec §4.2). Mirrors rviz_common's
 * Display / RosTopicDisplay / MessageFilterDisplay / DisplayGroup.
 *
 * A Display *is* a BoolProperty (its checkbox = Enabled) whose children are its
 * properties, with a StatusList child first. The rendering side is a three.js
 * Group attached to the scene root; Displays never touch ROS directly, only the
 * worker bridge, and only receive GPU-ready data (spec §3).
 */

import type { Accessor } from 'solid-js';
import type { PickHit, PickRegistry } from '../render/picking';
import type * as THREE from 'three/webgpu';
import type { BoolProperty, ChangeSource, Property, StatusLevel, StatusListProperty, YamlMap } from '../property/types';
import type { BridgeClient } from '../worker/client';
import type { TfSnapshot } from '../render/tf';
import type { QosProfile } from '../worker/messages';

/** Services every Display gets at construction. */
export interface DisplayContext {
  readonly scene: THREE.Scene;
  readonly bridge: BridgeClient;
  /** Global Options → Fixed Frame, leading `/` stripped. */
  readonly fixedFrame: Accessor<string>;
  /** Latest tf snapshot from the worker (poses of all frames in the fixed frame). */
  readonly tf: TfSnapshot;
  /** Current ROS time in nanoseconds (Time panel / sim time). */
  readonly rosTimeNs: Accessor<bigint>;
  /** Pick-id registry for selectable objects (spec §7.3). */
  readonly picking: PickRegistry;
  /** Dock panels owned by displays (Image / Camera); null until the main window is mounted. */
  readonly panels: () => PanelHost | null;
  /** Top-level displays (Camera display Visibility list). */
  readonly rootDisplays: Accessor<readonly Display[]>;
  /** Extra render passes run after the main view each frame (Camera display panels). */
  readonly extraViews: Set<ExtraView>;
}

export interface PanelHost {
  openDisplayPanel(id: string, component: string, title: string, size?: { width: number; height: number }): void;
  closePanel(id: string): void;
  setPanelTitle(id: string, title: string): void;
}

export interface ExtraView {
  render(): void;
}

/** Registry metadata, matching plugins_description.xml. */
export interface DisplayClassInfo {
  /** Registry key and .rviz `Class`, e.g. `rviz_default_plugins/Grid`. */
  readonly classId: string;
  /** Short name shown in the Add Display dialog ("Grid"). */
  readonly name: string;
  readonly description: string;
  /** Message types for the "By topic" tab; empty for Grid/Axes/RobotModel. */
  readonly messageTypes: readonly string[];
}

export interface Display extends BoolProperty {
  readonly classId: string;
  /** The "Status" child; aggregate level drives the icon on the Display row. */
  readonly status: StatusListProperty;
  readonly sceneNode: THREE.Group;
  readonly enabled: Accessor<boolean>;      // alias of `value`
  setEnabled(enabled: boolean): void;

  /** Lifecycle, called by the VisualizationManager (rviz_common::Display). */
  initialize(context: DisplayContext): void;
  onEnable(): void;
  onDisable(): void;
  /** Once per rendered frame while enabled. `wallDt`/`rosDt` in seconds. */
  update(wallDt: number, rosDt: number): void;
  /** Drop all received data (Fixed Frame change, "Reset" button). */
  reset(): void;
  fixedFrameChanged(): void;
  dispose(): void;

  setStatus(level: StatusLevel, name: string, text: string): void;
  deleteStatus(name: string): void;
  /** Selection panel description of a picked object of this display (null = not selectable). */
  /** Registers / forgets a scene object as selectable (owned by this display). */
  makePickable(obj: THREE.Object3D): void;
  releasePickable(obj: THREE.Object3D): void;
  describeSelection(hit: PickHit): Property | null;
  selectionBounds(hit: PickHit, out: THREE.Box3): boolean;
  updateSelection(hit: PickHit, prop: Property): void;

  /** Property::save plus `Class`, `Name`, `Enabled` (rviz_common::Display::save). */
  save(): YamlMap;
  load(yaml: YamlMap, source?: ChangeSource): void;
}

/** Subscribes/unsubscribes with the Topic property (plus its QoS children). */
export interface RosTopicDisplay<Msg> extends Display {
  readonly topic: Property<string>;
  readonly qos: Accessor<QosProfile>;
  /** Called on the main thread with worker-decoded data, never a raw message. */
  processMessage(msg: Msg): void;
}

/** Waits for the message's frame to be transformable before `processMessage`. */
export interface MessageFilterDisplay<Msg> extends RosTopicDisplay<Msg> {
  /** "Filter size" child of Topic, default 10. */
  readonly filterSize: Accessor<number>;
}

/** Nestable container; the root group also owns "Global Options" and "Global Status". */
export interface DisplayGroup extends Display {
  readonly displays: Accessor<readonly Display[]>;
  addDisplay(display: Display, index?: number): void;
  removeDisplay(display: Display): void;
  moveDisplay(display: Display, toIndex: number): void;
  /** Deep copy via save()/load() with a fresh instance of the same class. */
  duplicateDisplay(display: Display): Display;
}

/** Factory + metadata registry; Tools, ViewControllers and Panels follow the same pattern. */
export interface DisplayRegistry {
  register(info: DisplayClassInfo, create: () => Display): void;
  info(classId: string): DisplayClassInfo | undefined;
  all(): readonly DisplayClassInfo[];
  /** Unknown class ids yield an `UnknownDisplay` that keeps the YAML verbatim for round-trip. */
  create(classId: string): Display;
}
