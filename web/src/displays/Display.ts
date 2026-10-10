/**
 * Display base classes (see ./types.ts). Mirrors rviz_common::Display,
 * RosTopicDisplay, MessageFilterDisplay and DisplayGroup.
 */

import { createSignal, type Accessor } from 'solid-js';
import * as THREE from 'three/webgpu';
import { BoolPropertyImpl, RosTopicPropertyImpl, StatusListPropertyImpl, isYamlMap } from '../property/Property';
import type { ChangeSource, Property, StatusLevel, YamlMap, YamlValue } from '../property/types';
import type { Decoder, QosProfile } from '../worker/messages';
import type { Display, DisplayClassInfo, DisplayContext, DisplayGroup, DisplayRegistry, MessageFilterDisplay, RosTopicDisplay } from './types';
import { measure } from '../render/perf';
import type { PickHit } from '../render/picking';

export abstract class DisplayBase extends BoolPropertyImpl implements Display {
  readonly classId: string;
  readonly status: StatusListPropertyImpl;
  readonly sceneNode = new THREE.Group();
  readonly enabled: Accessor<boolean>;
  protected context: DisplayContext | null = null;
  private initialized = false;

  constructor(classId: string, name: string, description = '') {
    super(name, true, null, { description });
    this.classId = classId;
    this.enabled = this.value;
    this.reservedKeys = new Set(['Class', 'Name', 'Enabled']);
    // rviz creates the StatusList lazily on the first setStatus(); until then
    // the row does not exist (this keeps "/Status1" paths identical to RViz).
    this.status = new StatusListPropertyImpl('Status', null);
    this.sceneNode.name = name;
    this.sceneNode.visible = true;
    this.onChange((enabled) => {
      if (!this.initialized) return;
      this.sceneNode.visible = enabled;
      this.syncActive();
    });
  }

  setEnabled(enabled: boolean) {
    this.setValue(enabled, 'program');
  }

  /**
   * rviz: a display inside a disabled Group is off (no subscription, no panel)
   * although its own checkbox stays ticked. `active` is the state onEnable /
   * onDisable have been told about; groups re-sync their children.
   */
  private active = false;
  isActive(): boolean {
    return this.active;
  }
  private parentActive(): boolean {
    const p = this.parent;
    return !(p instanceof DisplayBase) || p.isActive();
  }
  /** Called by the parent group when its own active state changed. */
  syncActiveFromParent() {
    this.syncActive();
  }
  protected syncActive() {
    const want = this.initialized && this.enabled() && this.parentActive();
    if (want === this.active) return;
    this.active = want;
    if (want) this.onEnable();
    else this.onDisable();
  }

  initialize(context: DisplayContext) {
    this.context = context;
    this.initialized = true;
    context.scene.add(this.sceneNode);
    this.onInitialize();
    this.sceneNode.visible = this.enabled();
    this.syncActive();
  }

  /** Subclasses create visuals here; `this.context` is set. */
  protected onInitialize() {}
  onEnable() {}
  onDisable() {}
  update(_wallDt: number, _rosDt: number) {}
  reset() {
    this.status.clear();
  }
  fixedFrameChanged() {
    this.reset();
  }
  dispose() {
    this.initialized = false;
    this.syncActive();
    this.releaseAllPickables();
    this.sceneNode.removeFromParent();
    this.context = null;
  }

  setStatus(level: StatusLevel, name: string, text: string) {
    if (this.status.parent !== this) this.addChild(this.status, 0);
    this.status.setStatus(level, name, text);
  }

  // --- selection (spec §7.3) ----------------------------------------------
  private readonly pickables = new Set<THREE.Object3D>();

  /** Registers `obj` (and everything under it) as selectable, owned by this display. */
  makePickable(obj: THREE.Object3D) {
    if (!this.context) return;
    this.context.picking.register(this, obj);
    this.pickables.add(obj);
  }
  releasePickable(obj: THREE.Object3D) {
    this.context?.picking.unregister(obj);
    this.pickables.delete(obj);
  }
  protected releaseAllPickables() {
    for (const o of this.pickables) this.context?.picking.unregister(o);
    this.pickables.clear();
  }
  describeSelection(_hit: PickHit): Property | null {
    return null;
  }
  selectionBounds(_hit: PickHit, _out: THREE.Box3): boolean {
    return false;
  }
  updateSelection(_hit: PickHit, _prop: Property) {}
  deleteStatus(name: string) {
    this.status.deleteStatus(name);
  }

  override save(): YamlMap {
    const yaml = super.save();
    const map: YamlMap = isYamlMap(yaml) ? yaml : { Value: yaml };
    map.Class = this.classId;
    map.Name = this.name();
    map.Enabled = this.enabled();
    return map;
  }

  override load(yaml: YamlValue, source: ChangeSource = 'config') {
    super.load(yaml, source);
    if (isYamlMap(yaml)) {
      if (typeof yaml.Name === 'string') this.setName(yaml.Name);
      if (typeof yaml.Enabled === 'boolean') this.setValue(yaml.Enabled, source);
    }
  }
}

/** Display with a Topic property (QoS children) that subscribes while enabled. */
export abstract class RosTopicDisplayBase<Msg> extends DisplayBase implements RosTopicDisplay<Msg> {
  readonly topic: RosTopicPropertyImpl;
  readonly qos: Accessor<QosProfile>;
  /** Worker-side decoder for this display's message type. */
  protected decoder: Decoder = 'none';
  /** Extra decoder options sent with the subscription (e.g. colour transformer). */
  protected decoderOptions(): Record<string, unknown> {
    return {};
  }
  /**
   * True when the display only needs the newest message (it replaces its state
   * on every message): intermediate messages may then be skipped under load.
   * Displays that accumulate (markers, odometry history, map updates) keep false.
   */
  protected latestOnly(): boolean {
    return false;
  }
  private subscriptionOptions(): Record<string, unknown> {
    return { ...this.decoderOptions(), latestOnly: this.latestOnly() };
  }
  protected subscriptionId: number | null = null;

  constructor(classId: string, name: string, messageTypes: readonly string[], description = '', opts: { depth?: number; messageFilter?: boolean } = {}) {
    super(classId, name, description);
    this.topic = new RosTopicPropertyImpl('Topic', '', messageTypes, this, { description: `${messageTypes[0] ?? ''} topic to subscribe to.`, ...opts });
    this.qos = () => this.topic.qos();
    const resubscribe = () => {
      if (this.enabled() && this.context) {
        this.unsubscribe();
        this.subscribe();
      }
    };
    this.topic.onChange(resubscribe);
    for (const c of this.topic.children()) c.onChange(resubscribe);
  }

  override onEnable() {
    this.subscribe();
  }
  override onDisable() {
    this.unsubscribe();
  }

  protected subscribe() {
    if (!this.context || this.subscriptionId !== null) return;
    const topic = this.topic.value();
    if (!topic) {
      this.setStatus('warn', 'Topic', 'No topic set');
      return;
    }
    const type = this.topic.messageTypes[0];
    this.subscriptionId = this.context.bridge.subscribe(
      topic, type, this.qos(), this.decoder,
      (m) => measure(`msg ${this.name()}`, () => this.processMessage(m as Msg)),
      this.subscriptionOptions(),
      (message) => this.setStatus('error', 'Topic', message),
    );
    this.setStatus('ok', 'Topic', 'OK');
  }

  /** Pushes new decoder options to the worker without resubscribing. */
  protected updateDecoderOptions() {
    if (this.subscriptionId !== null && this.context) this.context.bridge.setOptions(this.subscriptionId, this.subscriptionOptions());
  }

  protected unsubscribe() {
    if (this.subscriptionId !== null && this.context) {
      this.context.bridge.unsubscribe(this.subscriptionId);
      this.subscriptionId = null;
    }
  }

  abstract processMessage(msg: Msg): void;
}

export abstract class MessageFilterDisplayBase<Msg> extends RosTopicDisplayBase<Msg> implements MessageFilterDisplay<Msg> {
  readonly filterSize: Accessor<number>;
  constructor(classId: string, name: string, messageTypes: readonly string[], description = '', opts: { depth?: number } = {}) {
    super(classId, name, messageTypes, description, { ...opts, messageFilter: true });
    this.filterSize = () => this.topic.filterSize!.value();
  }
}

export const GROUP_CLASS_ID = 'rviz_common/Group';

/** rviz DisplayGroup: property children first, then displays (kept in a separate list for save()). */
export class DisplayGroupImpl extends DisplayBase implements DisplayGroup {
  readonly displays: Accessor<readonly Display[]>;
  private readonly setDisplays: (d: readonly Display[]) => void;
  private readonly registry: DisplayRegistry;

  constructor(registry: DisplayRegistry, name = 'Group', classId = GROUP_CLASS_ID) {
    super(classId, name, 'A container for Displays');
    this.registry = registry;
    [this.displays, this.setDisplays] = createSignal<readonly Display[]>([]);
    this.reservedKeys = new Set(['Class', 'Name', 'Enabled', 'Displays']);
  }

  /** Property children only; displays are appended by the tree view. */
  protected override savedChildren(): readonly Property[] {
    return super.savedChildren().filter((c) => !this.displays().includes(c as Display));
  }

  addDisplay(display: Display, index?: number) {
    const list = this.displays().slice();
    list.splice(index ?? list.length, 0, display);
    this.setDisplays(list);
    this.addChild(display);
    if (this.context) display.initialize(this.context);
  }

  removeDisplay(display: Display) {
    this.setDisplays(this.displays().filter((d) => d !== display));
    this.removeChild(display);
    display.dispose();
  }

  moveDisplay(display: Display, toIndex: number) {
    const list = this.displays().filter((d) => d !== display);
    list.splice(toIndex, 0, display);
    this.setDisplays(list);
    const props = this.children().filter((c) => !list.includes(c as Display));
    // Rebuild child order: properties, then displays.
    for (const c of this.children().slice()) this.removeChild(c);
    for (const c of [...props, ...list]) this.addChild(c);
  }

  duplicateDisplay(display: Display): Display {
    const copy = this.registry.create(display.classId);
    copy.load(display.save());
    this.addDisplay(copy, this.displays().indexOf(display) + 1);
    return copy;
  }

  removeAllDisplays() {
    for (const d of this.displays().slice()) this.removeDisplay(d);
  }

  override initialize(context: DisplayContext) {
    super.initialize(context);
    for (const d of this.displays()) d.initialize(context);
  }
  /** rviz DisplayGroup: enabling / disabling the group switches its enabled children on / off. */
  override onEnable() {
    for (const d of this.displays()) if (d instanceof DisplayBase) d.syncActiveFromParent();
  }
  override onDisable() {
    for (const d of this.displays()) if (d instanceof DisplayBase) d.syncActiveFromParent();
  }
  override update(wallDt: number, rosDt: number) {
    for (const d of this.displays()) if (d.enabled()) d.update(wallDt, rosDt);
  }
  override reset() {
    super.reset();
    for (const d of this.displays()) d.reset();
  }
  override fixedFrameChanged() {
    for (const d of this.displays()) d.fixedFrameChanged();
  }
  override dispose() {
    for (const d of this.displays()) d.dispose();
    super.dispose();
  }

  override save(): YamlMap {
    const map = super.save();
    map.Displays = this.displays().map((d) => d.save());
    return map;
  }

  override load(yaml: YamlValue, source: ChangeSource = 'config') {
    this.removeAllDisplays();
    super.load(yaml, source);
    if (!isYamlMap(yaml) || !Array.isArray(yaml.Displays)) return;
    for (const entry of yaml.Displays) {
      if (!isYamlMap(entry)) continue;
      const classId = typeof entry.Class === 'string' ? entry.Class : '';
      // One broken display must not take the whole config down (spec §9.8):
      // fall back to a placeholder that keeps the YAML and reports the error.
      try {
        const d = this.registry.create(classId);
        d.load(entry, source);
        this.addDisplay(d);
      } catch (e) {
        console.error(`[display] failed to load ${classId}:`, e);
        const d = new UnknownDisplay(classId);
        d.load(entry, source);
        d.setStatus('error', 'Load', `Failed to load: ${String(e)}`);
        this.addDisplay(d);
      }
    }
  }
}

/** Placeholder for a Class we do not implement; keeps its YAML verbatim (rviz FailedDisplay). */
export class UnknownDisplay extends DisplayBase {
  private yaml: YamlMap = {};
  constructor(classId: string) {
    super(classId, classId.split('/').pop() ?? classId, `Unknown display class "${classId}" (kept for round-trip)`);
    this.setStatus('error', 'Class', `Display class "${classId}" is not available in WebRvizLite`);
  }
  override save(): YamlMap {
    return { ...this.yaml, Class: this.classId, Name: this.name(), Enabled: this.enabled() };
  }
  override load(yaml: YamlValue, source: ChangeSource = 'config') {
    if (isYamlMap(yaml)) {
      this.yaml = { ...yaml };
      if (typeof yaml.Name === 'string') this.setName(yaml.Name);
      if (typeof yaml.Enabled === 'boolean') this.setValue(yaml.Enabled, source);
    }
  }
}

export class DisplayRegistryImpl implements DisplayRegistry {
  private readonly entries = new Map<string, { info: DisplayClassInfo; create: () => Display }>();

  register(info: DisplayClassInfo, create: () => Display) {
    this.entries.set(info.classId, { info, create });
  }
  info(classId: string) {
    return this.entries.get(classId)?.info;
  }
  all() {
    return [...this.entries.values()].map((e) => e.info);
  }
  create(classId: string): Display {
    const e = this.entries.get(classId);
    if (e) return e.create();
    if (classId === GROUP_CLASS_ID) return new DisplayGroupImpl(this);
    return new UnknownDisplay(classId);
  }
}
