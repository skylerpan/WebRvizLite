/**
 * Property model implementation (see ./types.ts for the contract and the
 * rviz_common rules it follows).
 */

import { createSignal, type Accessor, type Setter } from 'solid-js';
import type {
  BoolProperty, ChangeSource, ColorProperty, EnumProperty, FloatProperty, IntProperty, Property,
  PropertyKind, QuaternionProperty, Rgb, RosTopicProperty, StatusLevel, StatusListProperty,
  StatusProperty, StringProperty, TfFrameProperty, VectorProperty, Xyz, Xyzw, YamlMap, YamlValue,
} from './types';
import { parseColor, printColor } from './color';
import type { QosProfile } from '../worker/messages';

export const isYamlMap = (v: YamlValue | undefined): v is YamlMap =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export interface PropertyOptions {
  description?: string;
  readOnly?: boolean;
  hidden?: boolean;
  /** Set false for rows that must never be written to the config. */
  saveable?: boolean;
}

/** Marker type for properties without a value (groups). */
export type NoValue = undefined;

export abstract class PropertyBase<T> implements Property<T> {
  abstract readonly kind: PropertyKind;

  readonly name: Accessor<string>;
  private readonly setNameSignal: (v: string) => void;
  description: string;
  readonly value: Accessor<T>;
  private readonly setValueSignal: Setter<T>;
  readonly defaultValue: T;
  readonly hidden: Accessor<boolean>;
  private readonly setHiddenSignal: (v: boolean) => void;
  readonly readOnly: Accessor<boolean>;
  private readonly setReadOnlySignal: (v: boolean) => void;
  readonly saveable: boolean;
  readonly children: Accessor<readonly Property[]>;
  private readonly setChildren: (v: readonly Property[]) => void;
  parent: Property | null = null;

  private readonly listeners = new Set<(value: T, source: ChangeSource) => void>();
  /** Keys seen in load() that matched no child; written back verbatim by save(). */
  protected unknownKeys: YamlMap = {};
  /** Map keys handled by subclasses' load/save, never treated as unknown. */
  protected reservedKeys: ReadonlySet<string> = new Set();

  protected constructor(name: string, defaultValue: T, parent: Property | null, opts: PropertyOptions = {}) {
    [this.name, this.setNameSignal] = createSignal(name);
    [this.value, this.setValueSignal] = createSignal<T>(defaultValue);
    [this.hidden, this.setHiddenSignal] = createSignal(opts.hidden ?? false);
    [this.readOnly, this.setReadOnlySignal] = createSignal(opts.readOnly ?? false);
    [this.children, this.setChildren] = createSignal<readonly Property[]>([]);
    this.defaultValue = defaultValue;
    this.description = opts.description ?? '';
    this.saveable = opts.saveable ?? true;
    if (parent) parent.addChild(this);
  }

  setName(name: string) {
    this.setNameSignal(name);
  }

  /** Whether this node carries a value at all (groups do not). */
  hasValue(): boolean {
    return this.defaultValue !== undefined;
  }

  /** Subclasses validate/clamp here; return undefined to reject. */
  protected normalize(value: T): T | undefined {
    return value;
  }

  setValue(value: T, source: ChangeSource = 'program'): boolean {
    const v = this.normalize(value);
    if (v === undefined) return false;
    if (this.equals(this.value(), v)) return true;
    this.setValueSignal(() => v as T);
    for (const cb of this.listeners) cb(v, source);
    return true;
  }

  protected equals(a: T, b: T): boolean {
    return a === b;
  }

  onChange(cb: (value: T, source: ChangeSource) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  setDescription(description: string) {
    this.description = description;
  }

  setHidden(hidden: boolean) {
    this.setHiddenSignal(hidden);
  }
  setReadOnly(readOnly: boolean) {
    this.setReadOnlySignal(readOnly);
  }

  child(name: string): Property | undefined {
    return this.children().find((c) => c.name() === name);
  }

  addChild(child: Property, index?: number) {
    if (this.children().includes(child)) return;
    const list = this.children().slice();
    list.splice(index ?? list.length, 0, child);
    (child as PropertyBase<unknown>).parent = this;
    this.setChildren(list);
  }

  removeChild(child: Property) {
    this.setChildren(this.children().filter((c) => c !== child));
    (child as PropertyBase<unknown>).parent = null;
  }

  pathName(): string {
    return this.name();
  }

  // --- YAML codec -----------------------------------------------------------

  /** Value → YAML scalar/map. */
  protected abstract encodeValue(): YamlValue;
  /** YAML → value; return false if it cannot be decoded. */
  protected abstract decodeValue(yaml: YamlValue, source: ChangeSource): boolean;

  /** Children that take part in save(); DisplayGroup excludes its displays. */
  protected savedChildren(): readonly Property[] {
    return this.children().filter((c) => c.saveable && !c.readOnly());
  }

  save(): YamlValue {
    const kids = this.savedChildren();
    if (kids.length > 0 || Object.keys(this.unknownKeys).length > 0) {
      const map: YamlMap = {};
      if (this.hasValue()) map.Value = this.encodeValue();
      for (const k of kids) map[k.name()] = k.save();
      for (const [k, v] of Object.entries(this.unknownKeys)) if (!(k in map)) map[k] = v;
      return map;
    }
    return this.hasValue() ? this.encodeValue() : {};
  }

  load(yaml: YamlValue, source: ChangeSource = 'config') {
    if (isYamlMap(yaml)) {
      if (this.hasValue() && 'Value' in yaml) this.decodeValue(yaml.Value, source);
      this.unknownKeys = {};
      for (const [key, v] of Object.entries(yaml)) {
        if (key === 'Value' || this.reservedKeys.has(key)) continue;
        const child = this.child(key);
        if (child) child.load(v, source);
        else this.unknownKeys[key] = v;
      }
    } else if (yaml !== null && this.hasValue()) {
      this.decodeValue(yaml, source);
    }
  }
}

// ---------------------------------------------------------------------------
// Concrete kinds
// ---------------------------------------------------------------------------

export class GroupProperty extends PropertyBase<NoValue> {
  readonly kind = 'group' as const;
  constructor(name: string, parent: Property | null, opts?: PropertyOptions) {
    super(name, undefined, parent, opts);
  }
  protected encodeValue(): YamlValue {
    return null;
  }
  protected decodeValue(): boolean {
    return false;
  }
}

const toBool = (v: YamlValue): boolean | undefined =>
  typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : typeof v === 'number' ? v !== 0 : undefined;

export class BoolPropertyImpl extends PropertyBase<boolean> implements BoolProperty {
  readonly kind: 'bool' | 'status_list' = 'bool';
  constructor(name: string, defaultValue: boolean, parent: Property | null, opts?: PropertyOptions) {
    super(name, defaultValue, parent, opts);
  }
  protected encodeValue(): YamlValue {
    return this.value();
  }
  protected decodeValue(yaml: YamlValue, source: ChangeSource): boolean {
    const b = toBool(yaml);
    return b === undefined ? false : this.setValue(b, source);
  }
}

const toNumber = (v: YamlValue): number | undefined => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  return undefined;
};

export class IntPropertyImpl extends PropertyBase<number> implements IntProperty {
  readonly kind = 'int' as const;
  min = Number.MIN_SAFE_INTEGER;
  max = Number.MAX_SAFE_INTEGER;
  constructor(name: string, defaultValue: number, parent: Property | null, opts: PropertyOptions & { min?: number; max?: number } = {}) {
    super(name, defaultValue, parent, opts);
    if (opts.min !== undefined) this.min = opts.min;
    if (opts.max !== undefined) this.max = opts.max;
  }
  protected normalize(v: number): number | undefined {
    if (!Number.isFinite(v)) return undefined;
    return Math.min(this.max, Math.max(this.min, Math.trunc(v)));
  }
  protected encodeValue(): YamlValue {
    return this.value();
  }
  protected decodeValue(yaml: YamlValue, source: ChangeSource): boolean {
    const n = toNumber(yaml);
    return n === undefined ? false : this.setValue(n, source);
  }
}

export class FloatPropertyImpl extends PropertyBase<number> implements FloatProperty {
  readonly kind = 'float' as const;
  min = -Number.MAX_VALUE;
  max = Number.MAX_VALUE;
  constructor(name: string, defaultValue: number, parent: Property | null, opts: PropertyOptions & { min?: number; max?: number } = {}) {
    super(name, defaultValue, parent, opts);
    if (opts.min !== undefined) this.min = opts.min;
    if (opts.max !== undefined) this.max = opts.max;
  }
  protected normalize(v: number): number | undefined {
    if (!Number.isFinite(v)) return undefined;
    return Math.min(this.max, Math.max(this.min, v));
  }
  protected encodeValue(): YamlValue {
    return this.value();
  }
  protected decodeValue(yaml: YamlValue, source: ChangeSource): boolean {
    const n = toNumber(yaml);
    return n === undefined ? false : this.setValue(n, source);
  }
}

export class StringPropertyImpl extends PropertyBase<string> implements StringProperty {
  readonly kind = 'string' as const;
  constructor(name: string, defaultValue: string, parent: Property | null, opts?: PropertyOptions) {
    super(name, defaultValue, parent, opts);
  }
  protected encodeValue(): YamlValue {
    return this.value();
  }
  protected decodeValue(yaml: YamlValue, source: ChangeSource): boolean {
    if (yaml === null || typeof yaml === 'object') return false;
    return this.setValue(String(yaml), source);
  }
}

export class ColorPropertyImpl extends PropertyBase<Rgb> implements ColorProperty {
  readonly kind = 'color' as const;
  constructor(name: string, defaultValue: Rgb, parent: Property | null, opts?: PropertyOptions) {
    super(name, defaultValue, parent, opts);
  }
  protected equals(a: Rgb, b: Rgb) {
    return a.r === b.r && a.g === b.g && a.b === b.b;
  }
  protected encodeValue(): YamlValue {
    return printColor(this.value());
  }
  protected decodeValue(yaml: YamlValue, source: ChangeSource): boolean {
    if (typeof yaml !== 'string') return false;
    const c = parseColor(yaml);
    return c ? this.setValue(c, source) : false;
  }
}

export class EnumPropertyImpl extends PropertyBase<string> implements EnumProperty {
  readonly kind: 'enum' | 'editable_enum';
  readonly options: Accessor<readonly string[]>;
  private readonly setOptionsSignal: (v: readonly string[]) => void;
  constructor(name: string, defaultValue: string, options: readonly string[], parent: Property | null, opts: PropertyOptions & { editable?: boolean } = {}) {
    super(name, defaultValue, parent, opts);
    this.kind = opts.editable ? 'editable_enum' : 'enum';
    [this.options, this.setOptionsSignal] = createSignal<readonly string[]>(options);
  }
  setOptions(options: readonly string[]) {
    this.setOptionsSignal(options);
  }
  protected encodeValue(): YamlValue {
    return this.value();
  }
  protected decodeValue(yaml: YamlValue, source: ChangeSource): boolean {
    if (yaml === null || typeof yaml === 'object') return false;
    return this.setValue(String(yaml), source);
  }
}

/** rviz VectorProperty: summary "x; y; z" plus X/Y/Z child editors; saved as {X, Y, Z}. */
export class VectorPropertyImpl extends PropertyBase<Xyz> implements VectorProperty {
  readonly kind = 'vector' as const;
  private readonly axes: FloatPropertyImpl[];
  private syncing = false;
  constructor(name: string, defaultValue: Xyz, parent: Property | null, opts?: PropertyOptions) {
    super(name, defaultValue, parent, opts);
    this.reservedKeys = new Set(['X', 'Y', 'Z']);
    this.axes = (['x', 'y', 'z'] as const).map((k) => {
      const p = new FloatPropertyImpl(k.toUpperCase(), defaultValue[k], this, { description: `${k.toUpperCase()} coordinate`, saveable: false });
      p.onChange((v, source) => {
        if (this.syncing) return;
        this.setValue({ ...this.value(), [k]: v }, source);
      });
      return p;
    });
    this.onChange((v) => {
      this.syncing = true;
      this.axes[0].setValue(v.x);
      this.axes[1].setValue(v.y);
      this.axes[2].setValue(v.z);
      this.syncing = false;
    });
  }
  protected equals(a: Xyz, b: Xyz) {
    return a.x === b.x && a.y === b.y && a.z === b.z;
  }
  protected normalize(v: Xyz): Xyz | undefined {
    return [v.x, v.y, v.z].every(Number.isFinite) ? { x: v.x, y: v.y, z: v.z } : undefined;
  }
  protected encodeValue(): YamlValue {
    const v = this.value();
    return { X: v.x, Y: v.y, Z: v.z };
  }
  protected decodeValue(yaml: YamlValue, source: ChangeSource): boolean {
    if (!isYamlMap(yaml)) return false;
    const [x, y, z] = [toNumber(yaml.X), toNumber(yaml.Y), toNumber(yaml.Z)];
    if (x === undefined || y === undefined || z === undefined) return false;
    return this.setValue({ x, y, z }, source);
  }
  save(): YamlValue {
    // The X/Y/Z children are not saveable, so this is always the {X,Y,Z} map
    // (rviz VectorProperty::save), merged with any unknown keys.
    return { ...this.unknownKeys, ...(this.encodeValue() as YamlMap) };
  }
  load(yaml: YamlValue, source: ChangeSource = 'config') {
    if (isYamlMap(yaml)) {
      this.decodeValue(yaml, source);
      this.unknownKeys = {};
      for (const [k, v] of Object.entries(yaml)) if (!this.reservedKeys.has(k)) this.unknownKeys[k] = v;
    }
  }
}

export class QuaternionPropertyImpl extends PropertyBase<Xyzw> implements QuaternionProperty {
  readonly kind = 'quaternion' as const;
  private readonly axes: FloatPropertyImpl[];
  private syncing = false;
  constructor(name: string, defaultValue: Xyzw, parent: Property | null, opts?: PropertyOptions) {
    super(name, defaultValue, parent, opts);
    this.reservedKeys = new Set(['X', 'Y', 'Z', 'W']);
    this.axes = (['x', 'y', 'z', 'w'] as const).map((k) => {
      const p = new FloatPropertyImpl(k.toUpperCase(), defaultValue[k], this, { saveable: false });
      p.onChange((v, source) => {
        if (this.syncing) return;
        this.setValue({ ...this.value(), [k]: v }, source);
      });
      return p;
    });
    this.onChange((v) => {
      this.syncing = true;
      this.axes[0].setValue(v.x);
      this.axes[1].setValue(v.y);
      this.axes[2].setValue(v.z);
      this.axes[3].setValue(v.w);
      this.syncing = false;
    });
  }
  protected equals(a: Xyzw, b: Xyzw) {
    return a.x === b.x && a.y === b.y && a.z === b.z && a.w === b.w;
  }
  protected normalize(v: Xyzw): Xyzw | undefined {
    return [v.x, v.y, v.z, v.w].every(Number.isFinite) ? { x: v.x, y: v.y, z: v.z, w: v.w } : undefined;
  }
  protected encodeValue(): YamlValue {
    const v = this.value();
    return { X: v.x, Y: v.y, Z: v.z, W: v.w };
  }
  protected decodeValue(yaml: YamlValue, source: ChangeSource): boolean {
    if (!isYamlMap(yaml)) return false;
    const [x, y, z, w] = [toNumber(yaml.X), toNumber(yaml.Y), toNumber(yaml.Z), toNumber(yaml.W)];
    if (x === undefined || y === undefined || z === undefined || w === undefined) return false;
    return this.setValue({ x, y, z, w }, source);
  }
  save(): YamlValue {
    return { ...this.unknownKeys, ...(this.encodeValue() as YamlMap) };
  }
  load(yaml: YamlValue, source: ChangeSource = 'config') {
    if (isYamlMap(yaml)) {
      this.decodeValue(yaml, source);
      this.unknownKeys = {};
      for (const [k, v] of Object.entries(yaml)) if (!this.reservedKeys.has(k)) this.unknownKeys[k] = v;
    }
  }
}

export const FIXED_FRAME_STRING = '<Fixed Frame>';

/** Where TF frame properties get their frame list (the tf snapshot; `TfSnapshot` has this shape). */
export interface TfFrameSource {
  /** Bumps when the frame list changes. */
  framesVersion: Accessor<number>;
  frames(): readonly string[];
}

const [tfFrameSource, setTfFrameSourceSignal] = createSignal<TfFrameSource | null>(null);

/** Registers the app-wide frame list for every TfFrameProperty (set once by the VisualizationManager). */
export function setTfFrameSource(src: TfFrameSource | null) {
  setTfFrameSourceSignal(src);
}

/** rviz TfFrameProperty: editable enum of TF frames, optionally with "<Fixed Frame>". */
export class TfFramePropertyImpl extends EnumPropertyImpl implements TfFrameProperty {
  declare readonly kind: 'editable_enum';
  constructor(
    name: string,
    defaultValue: string,
    parent: Property | null,
    private readonly fixedFrame: Accessor<string> | null,
    opts: PropertyOptions & { includeFixedFrame?: boolean } = {},
  ) {
    super(name, defaultValue, opts.includeFixedFrame ?? true ? [FIXED_FRAME_STRING] : [], parent, { ...opts, editable: true });
  }
  /** Dropdown entries: the static options ("<Fixed Frame>") followed by every known TF frame, sorted. Reactive. */
  frameOptions(): readonly string[] {
    const src = tfFrameSource();
    const base = this.options();
    if (!src) return base;
    src.framesVersion();
    return [...base, ...[...src.frames()].sort()];
  }
  frameId(): string {
    let v = this.value();
    if (v === FIXED_FRAME_STRING) v = this.fixedFrame ? this.fixedFrame() : '';
    return stripLeadingSlash(v);
  }
}

/** rviz FrameManager strips a leading '/' before tf lookups. */
export function stripLeadingSlash(frame: string): string {
  return frame.startsWith('/') ? frame.slice(1) : frame;
}

const HISTORY = ['System Default', 'Keep Last', 'Keep All'] as const;
const RELIABILITY = ['System Default', 'Reliable', 'Best Effort'] as const;
const DURABILITY = ['System Default', 'Transient Local', 'Volatile'] as const;

/** rviz RosTopicProperty with QosProfileProperty children (+ "Filter size" for message filter displays). */
export class RosTopicPropertyImpl extends PropertyBase<string> implements RosTopicProperty {
  readonly kind = 'ros_topic' as const;
  readonly depth: IntPropertyImpl;
  readonly history: EnumPropertyImpl;
  readonly reliability: EnumPropertyImpl;
  readonly durability: EnumPropertyImpl;
  readonly filterSize: IntPropertyImpl | null;

  constructor(
    name: string,
    defaultValue: string,
    readonly messageTypes: readonly string[],
    parent: Property | null,
    opts: PropertyOptions & { depth?: number; messageFilter?: boolean; reliability?: (typeof RELIABILITY)[number]; durability?: (typeof DURABILITY)[number] } = {},
  ) {
    super(name, defaultValue, parent, opts);
    this.depth = new IntPropertyImpl('Depth', opts.depth ?? 5, this, { description: 'Set the depth of the incoming message queue', min: 1 });
    this.history = new EnumPropertyImpl('History Policy', 'Keep Last', HISTORY, this, { description: 'Set the history policy', editable: true });
    this.reliability = new EnumPropertyImpl('Reliability Policy', opts.reliability ?? 'Reliable', RELIABILITY, this, { description: 'Set the reliability policy', editable: true });
    this.durability = new EnumPropertyImpl('Durability Policy', opts.durability ?? 'Volatile', DURABILITY, this, { description: 'Set the durability policy', editable: true });
    this.filterSize = opts.messageFilter
      ? new IntPropertyImpl('Filter size', 10, this, { description: 'Set the filter size of the Message Filter Display', min: 1 })
      : null;
  }

  qos(): QosProfile {
    const snake = (s: string) => s.toLowerCase().replace(/ /g, '_') as never;
    return {
      depth: this.depth.value(),
      history: snake(this.history.value()),
      reliability: snake(this.reliability.value()),
      durability: snake(this.durability.value()),
    };
  }

  protected encodeValue(): YamlValue {
    return this.value();
  }
  protected decodeValue(yaml: YamlValue, source: ChangeSource): boolean {
    if (yaml === null || typeof yaml === 'object') return false;
    return this.setValue(String(yaml), source);
  }
}

const LEVEL_RANK: Record<StatusLevel, number> = { ok: 0, warn: 1, error: 2 };

export class StatusPropertyImpl extends PropertyBase<string> implements StatusProperty {
  readonly kind = 'status' as const;
  readonly level: Accessor<StatusLevel>;
  readonly setLevel: (l: StatusLevel) => void;
  constructor(name: string, text: string, level: StatusLevel, parent: Property | null) {
    super(name, text, parent, { readOnly: true, saveable: false });
    [this.level, this.setLevel] = createSignal(level);
  }
  protected encodeValue(): YamlValue {
    return this.value();
  }
  protected decodeValue(): boolean {
    return false;
  }
}

/** rviz StatusList: name shows "<prefix>: <Level>", aggregate level is the worst child. */
export class StatusListPropertyImpl extends BoolPropertyImpl implements StatusListProperty {
  override readonly kind = 'status_list' as const;
  readonly level: Accessor<StatusLevel>;
  private readonly setLevel: (l: StatusLevel) => void;
  private readonly prefix: string;
  constructor(prefix: string, parent: Property | null) {
    super(`${prefix}: Ok`, true, parent, { readOnly: true, saveable: false });
    this.prefix = prefix;
    [this.level, this.setLevel] = createSignal<StatusLevel>('ok');
  }
  override pathName(): string {
    return 'Status';
  }
  setStatus(level: StatusLevel, name: string, text: string) {
    const existing = this.child(name) as StatusPropertyImpl | undefined;
    if (existing) {
      existing.setValue(text);
      existing.setLevel(level);
    } else {
      new StatusPropertyImpl(name, text, level, this);
    }
    this.updateLevel();
  }
  deleteStatus(name: string) {
    const c = this.child(name);
    if (c) {
      this.removeChild(c);
      this.updateLevel();
    }
  }
  clear() {
    for (const c of this.children().slice()) this.removeChild(c);
    this.updateLevel();
  }
  private updateLevel() {
    let worst: StatusLevel = 'ok';
    for (const c of this.children() as StatusPropertyImpl[]) if (LEVEL_RANK[c.level()] > LEVEL_RANK[worst]) worst = c.level();
    this.setLevel(worst);
    this.setName(`${this.prefix}: ${worst === 'ok' ? 'Ok' : worst === 'warn' ? 'Warning' : 'Error'}`);
  }
}
