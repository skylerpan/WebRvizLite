/**
 * Property model — interface proposal for M2 (spec §4.1).
 *
 * Mirrors rviz_common::properties: a Property is a named node in a tree with
 * an optional value, child properties, and metadata for the editor. The same
 * objects drive the Displays panel UI, the .rviz YAML codec, and every Display.
 *
 * Reactivity: `value`, `hidden`, `readOnly`, and `children` are SolidJS signal
 * accessors, so a change re-renders only the affected tree cell and runs only
 * the callbacks registered on that property.
 */

import type { Accessor } from 'solid-js';

/** Plain YAML data as produced by `yaml.parse()`. */
export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };
export type YamlMap = { [key: string]: YamlValue };

/**
 * Discriminator for editor selection and YAML coding. One entry per RViz
 * property class that Tier 0 needs; the rest are listed so Tier 1/2 slot in
 * without changing this file.
 */
export type PropertyKind =
  | 'group'          // no value, only children (e.g. "Frames", "Global Options")
  | 'bool'
  | 'int'
  | 'float'
  | 'string'
  | 'color'          // {r,g,b} 0–255, YAML "r; g; b"
  | 'enum'           // fixed option list; children allowed (Line Style → Line Width)
  | 'editable_enum'  // option list plus free text (QoS policies, Channel Name)
  | 'vector'         // {x,y,z}; UI shows "x; y; z" with X/Y/Z child editors; YAML {X,Y,Z}
  | 'quaternion'     // {x,y,z,w}; YAML {X,Y,Z,W}
  | 'tf_frame'       // editable enum fed by the TF buffer, with "<Fixed Frame>"
  | 'ros_topic'      // string topic name; QoS props are its children (Depth, History Policy, …)
  | 'status'         // one status line (level + text); read-only, never saved
  | 'status_list'    // aggregate of statuses; shown as the "Status" row of a Display
  | 'file'           // Tier 1
  | 'regex'          // Tier 1 (TF filter)
  | 'display_group_visibility'; // Tier 1 (Camera display)

export type ChangeSource = 'user' | 'config' | 'program';

/** Base node. `T` is the value type (`undefined` for groups). */
export interface Property<T = unknown> {
  readonly kind: PropertyKind;
  /** UI label and YAML key. Display names can be renamed by the user. */
  readonly name: Accessor<string>;
  setName(name: string): void;
  /** Shown in the Displays panel help area when the row is selected. */
  readonly description: string;

  readonly value: Accessor<T>;
  readonly defaultValue: T;
  /**
   * Sets the value (clamped/validated per kind). Returns false and leaves the
   * value unchanged if invalid. `source` lets callbacks tell user edits from
   * config loads.
   */
  setValue(value: T, source?: ChangeSource): boolean;
  /** Runs after every accepted change. Returns a disposer. */
  onChange(cb: (value: T, source: ChangeSource) => void): () => void;

  readonly hidden: Accessor<boolean>;
  setHidden(hidden: boolean): void;        // hidden properties are still saved
  readonly readOnly: Accessor<boolean>;
  setReadOnly(readOnly: boolean): void;    // read-only properties are not saved (RViz rule)
  /** Set false on Status rows and the virtual X/Y/Z children of vectors. */
  readonly saveable: boolean;

  readonly parent: Property | null;
  readonly children: Accessor<readonly Property[]>;
  child(name: string): Property | undefined;
  addChild(child: Property, index?: number): void;
  removeChild(child: Property): void;
  /** RViz expanded-path element: `/<Name><occurrence>`; StatusList normalizes to "Status". */
  pathName(): string;

  /**
   * YAML codec (rviz_common Property::save/load):
   * - children present → map `{ Value?: <value>, <child name>: <child yaml>, … }`
   * - no children      → scalar value (or `null` for groups)
   * Unknown keys seen in `load()` are kept and written back by `save()`.
   */
  save(): YamlValue;
  load(yaml: YamlValue, source?: ChangeSource): void;
}

// --- kind-specific additions --------------------------------------------------

export interface BoolProperty extends Property<boolean> { readonly kind: 'bool' | 'status_list' }
export interface IntProperty extends Property<number> { readonly kind: 'int'; min: number; max: number }
export interface FloatProperty extends Property<number> { readonly kind: 'float'; min: number; max: number }
export interface StringProperty extends Property<string> { readonly kind: 'string' }

export interface Rgb { r: number; g: number; b: number }
/** YAML `"160; 160; 164"`; also accepts Qt colour names and `#rrggbb` on load. */
export interface ColorProperty extends Property<Rgb> { readonly kind: 'color' }

export interface EnumProperty extends Property<string> {
  readonly kind: 'enum' | 'editable_enum';
  readonly options: Accessor<readonly string[]>;
  setOptions(options: readonly string[]): void;
}

export interface Xyz { x: number; y: number; z: number }
export interface Xyzw extends Xyz { w: number }
export interface VectorProperty extends Property<Xyz> { readonly kind: 'vector' }
export interface QuaternionProperty extends Property<Xyzw> { readonly kind: 'quaternion' }

/** Value is the raw string from the config (may start with `/`); use `frameId()` for lookups. */
export interface TfFrameProperty extends EnumProperty {
  readonly kind: 'editable_enum';
  /** `<Fixed Frame>` resolved and leading `/` stripped, as rviz FrameManager does. */
  frameId(): string;
}

export interface RosTopicProperty extends Property<string> {
  readonly kind: 'ros_topic';
  /** Fully qualified message type(s) this topic must have, e.g. `sensor_msgs/msg/LaserScan`. */
  readonly messageTypes: readonly string[];
  /** Children "Depth", "History Policy", "Reliability Policy", "Durability Policy" (+ "Filter size"). */
  qos(): import('../worker/messages').QosProfile;
}

export type StatusLevel = 'ok' | 'warn' | 'error';
export interface StatusProperty extends Property<string> {
  readonly kind: 'status';
  readonly level: Accessor<StatusLevel>;
}
/** Display "Status" row: name shows the worst level ("Status: Error"), children are the entries. */
export interface StatusListProperty extends Property<boolean> {
  readonly kind: 'status_list';
  readonly level: Accessor<StatusLevel>;
  setStatus(level: StatusLevel, name: string, text: string): void;
  deleteStatus(name: string): void;
  clear(): void;
}
