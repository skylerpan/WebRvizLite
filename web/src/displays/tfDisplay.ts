/**
 * rviz_default_plugins/TF (tf_display.cpp): axes, parent arrows and names for
 * every frame in the tf buffer, with per-frame enable checkboxes, read-only
 * pose details, a Tree view, regex filters and a Frame Timeout fade.
 */

import * as THREE from 'three/webgpu';
import { DisplayBase } from './Display';
import {
  BoolPropertyImpl, FloatPropertyImpl, GroupProperty, QuaternionPropertyImpl, StringPropertyImpl, VectorPropertyImpl,
} from '../property/Property';
import type { Property } from '../property/types';
import { Arrow, Axes, TextSprite, pointXAxisAt } from '../render/primitives';
import { boxAround, roQuaternion, roString, roVector, selectionGroup, setQuaternion, setVector } from './selectionInfo';
import type { PickHit } from '../render/picking';

import type { DisplayClassInfo } from './types';

export const TF_INFO: DisplayClassInfo = {
  classId: 'rviz_default_plugins/TF',
  name: 'TF',
  description: 'Displays the TF transform hierarchy.',
  messageTypes: ['tf2_msgs/msg/TFMessage'],
};

const ARROW_COLOR = 0xff9900;
const DETAIL_UPDATE_S = 0.2; // read-only pose properties refresh at 5 Hz

class FrameInfo {
  readonly node = new THREE.Group();
  readonly axes: Axes;
  readonly arrow: Arrow;
  readonly label: TextSprite;
  readonly enabled: BoolPropertyImpl;
  readonly parentProp: StringPropertyImpl;
  readonly position: VectorPropertyImpl;
  readonly orientation: QuaternionPropertyImpl;
  readonly relPosition: VectorPropertyImpl;
  readonly relOrientation: QuaternionPropertyImpl;
  treeNode: GroupProperty | null = null;

  constructor(readonly name: string, framesGroup: Property, scale: number) {
    this.axes = new Axes(0.2 * scale, 0.02 * scale);
    this.arrow = new Arrow(ARROW_COLOR, 1, 0.01 * scale, 0.1 * scale, 0.03 * scale);
    this.label = new TextSprite(name, 0.1 * scale);
    this.node.add(this.axes, this.arrow, this.label);
    this.enabled = new BoolPropertyImpl(name, true, framesGroup, { description: `Enable or disable this individual frame.` });
    this.parentProp = new StringPropertyImpl('Parent', '', this.enabled, { description: 'Parent of this frame.  (Not editable)', readOnly: true });
    this.position = new VectorPropertyImpl('Position', { x: 0, y: 0, z: 0 }, this.enabled, { description: 'Position of this frame, in the current Fixed Frame.  (Not editable)', readOnly: true });
    this.orientation = new QuaternionPropertyImpl('Orientation', { x: 0, y: 0, z: 0, w: 1 }, this.enabled, { description: 'Orientation of this frame, in the current Fixed Frame.  (Not editable)', readOnly: true });
    this.relPosition = new VectorPropertyImpl('Relative Position', { x: 0, y: 0, z: 0 }, this.enabled, { description: 'Position of this frame, relative to it\'s parent frame.  (Not editable)', readOnly: true });
    this.relOrientation = new QuaternionPropertyImpl('Relative Orientation', { x: 0, y: 0, z: 0, w: 1 }, this.enabled, { description: 'Orientation of this frame, relative to it\'s parent frame.  (Not editable)', readOnly: true });
  }

  setScale(scale: number) {
    this.axes.set(0.2 * scale, 0.02 * scale);
    this.label.setText(this.name, 0.1 * scale);
  }

  setOpacity(alpha: number) {
    this.axes.setOpacity(alpha);
    this.arrow.setColor(255, 153, 0, alpha);
    this.label.setOpacity(alpha);
  }

  dispose() {
    this.axes.dispose();
    this.arrow.dispose();
    this.label.dispose();
  }
}

export class TfDisplay extends DisplayBase {
  readonly showNames: BoolPropertyImpl;
  readonly showAxes: BoolPropertyImpl;
  readonly showArrows: BoolPropertyImpl;
  readonly markerScale: FloatPropertyImpl;
  readonly updateInterval: FloatPropertyImpl;
  readonly frameTimeout: FloatPropertyImpl;
  readonly filterWhitelist: StringPropertyImpl;
  readonly filterBlacklist: StringPropertyImpl;
  readonly framesGroup: GroupProperty;
  readonly allEnabled: BoolPropertyImpl;
  readonly treeGroup: GroupProperty;
  private readonly frames = new Map<string, FrameInfo>();
  private sinceUpdate = Infinity;
  private sinceDetail = Infinity;
  private treeVersion = -1;
  private changingAll = false;

  constructor() {
    super(TF_INFO.classId, TF_INFO.name, TF_INFO.description);
    this.showNames = new BoolPropertyImpl('Show Names', false, this, { description: 'Whether or not names should be shown next to the frames.' });
    this.showAxes = new BoolPropertyImpl('Show Axes', true, this, { description: 'Whether or not the axes of each frame should be shown.' });
    this.showArrows = new BoolPropertyImpl('Show Arrows', true, this, { description: 'Whether or not arrows from child to parent should be shown.' });
    this.markerScale = new FloatPropertyImpl('Marker Scale', 1, this, { description: 'Scaling factor for all names, axes and arrows.' });
    this.updateInterval = new FloatPropertyImpl('Update Interval', 0, this, { description: 'The interval, in seconds, at which to update the frame transforms.  0 means to do so every update cycle.', min: 0 });
    this.frameTimeout = new FloatPropertyImpl('Frame Timeout', 15, this, {
      description: 'The length of time, in seconds, before a frame that has not been updated is considered "dead".  For 1/3 of this time the frame will appear correct, for the second 1/3rd it will fade to gray, and then it will fade out completely.',
      min: 1,
    });
    this.filterWhitelist = new StringPropertyImpl('Filter (whitelist)', '', this, { description: 'Regular expression to filter frames. Only frames matching the expression are shown.' });
    this.filterBlacklist = new StringPropertyImpl('Filter (blacklist)', '', this, { description: 'Regular expression to filter frames. Frames matching the expression are hidden.' });
    this.framesGroup = new GroupProperty('Frames', this, { description: 'The list of all frames.' });
    this.allEnabled = new BoolPropertyImpl('All Enabled', true, this.framesGroup, { description: 'Whether all the frames should be enabled or not.' });
    this.treeGroup = new GroupProperty('Tree', this, { description: 'A tree-view of the frames, showing the parent/child relationships.' });
    this.markerScale.onChange((s) => {
      for (const f of this.frames.values()) f.setScale(s);
    });
    this.allEnabled.onChange((v, source) => {
      if (source === 'config' && !this.framesLoaded) return;
      this.changingAll = true;
      for (const f of this.frames.values()) f.enabled.setValue(v, 'program');
      this.changingAll = false;
    });
  }

  /** Per-frame enable states from the config, applied when the frame appears. */
  private framesLoaded = false;

  private frameAllowed(name: string): boolean {
    const white = this.filterWhitelist.value();
    const black = this.filterBlacklist.value();
    try {
      if (white && !new RegExp(white).test(name)) return false;
      if (black && new RegExp(black).test(name)) return false;
    } catch {
      return true;
    }
    return true;
  }

  private syncFrameList() {
    const tf = this.context!.tf;
    const names = tf.frames();
    const seen = new Set<string>();
    for (const name of names) {
      seen.add(name);
      if (!this.frames.has(name)) {
        const info = new FrameInfo(name, this.framesGroup, this.markerScale.value());
        // rviz: a frame listed in the config keeps its saved enable state (loaded lazily).
        const saved = this.savedFrameStates.get(name);
        if (saved !== undefined) info.enabled.setValue(saved, 'config');
        info.enabled.onChange(() => {
          if (!this.changingAll) this.syncAllEnabled();
        });
        this.sceneNode.add(info.node);
        info.node.userData.frame = name;
        this.makePickable(info.node);
        this.frames.set(name, info);
      }
    }
    for (const [name, info] of this.frames) {
      if (!seen.has(name)) {
        this.releasePickable(info.node);
        info.dispose();
        info.node.removeFromParent();
        this.framesGroup.removeChild(info.enabled);
        this.frames.delete(name);
      }
    }
    if (tf.framesVersion() !== this.treeVersion) {
      this.treeVersion = tf.framesVersion();
      this.rebuildTree();
    }
  }

  private syncAllEnabled() {
    const all = [...this.frames.values()].every((f) => f.enabled.value());
    this.changingAll = true;
    this.allEnabled.setValue(all, 'program');
    this.changingAll = false;
  }

  private rebuildTree() {
    for (const c of this.treeGroup.children().slice()) this.treeGroup.removeChild(c);
    const tf = this.context!.tf;
    const nodes = new Map<string, GroupProperty>();
    const nodeFor = (name: string): GroupProperty => {
      let n = nodes.get(name);
      if (n) return n;
      const parent = tf.parent(name);
      const parentNode = parent && tf.has(parent) ? nodeFor(parent) : this.treeGroup;
      n = new GroupProperty(name, parentNode);
      nodes.set(name, n);
      return n;
    };
    for (const name of tf.frames()) nodeFor(name);
  }

  override update(wallDt: number) {
    if (!this.context) return;
    this.sinceUpdate += wallDt;
    this.sinceDetail += wallDt;
    if (this.sinceUpdate < this.updateInterval.value()) return;
    this.sinceUpdate = 0;
    this.syncFrameList();
    const tf = this.context.tf;
    const timeout = this.frameTimeout.value();
    const showNames = this.showNames.value();
    const showAxes = this.showAxes.value();
    const showArrows = this.showArrows.value();
    const detail = this.sinceDetail >= DETAIL_UPDATE_S;
    if (detail) this.sinceDetail = 0;
    let errors = 0;
    for (const info of this.frames.values()) {
      const visible = info.enabled.value() && this.frameAllowed(info.name) && tf.lookup(info.name, tmpM, tmpPos, tmpQuat);
      info.node.visible = visible;
      if (!visible) {
        if (!tf.isValid(info.name)) errors++;
        continue;
      }
      info.axes.position.copy(tmpPos);
      info.axes.quaternion.copy(tmpQuat);
      info.label.position.copy(tmpPos);
      info.axes.visible = showAxes;
      info.label.visible = showNames;
      const parent = tf.parent(info.name);
      if (showArrows && parent && tf.lookup(parent, tmpM2, tmpParentPos)) {
        const len = pointXAxisAt(info.arrow, tmpPos, tmpParentPos);
        info.arrow.set(Math.max(0, len - 0.1 * this.markerScale.value()), 0.01 * this.markerScale.value(), 0.1 * this.markerScale.value(), 0.03 * this.markerScale.value());
        info.arrow.visible = len > 1e-6;
      } else {
        info.arrow.visible = false;
      }
      // Frame Timeout: first third normal, second third fades, last third hidden.
      const age = tf.age(info.name);
      let alpha = 1;
      if (age > timeout * (2 / 3)) info.node.visible = false;
      else if (age > timeout / 3) alpha = 1 - (age - timeout / 3) / (timeout / 3);
      info.setOpacity(alpha);
      if (detail) {
        info.parentProp.setValue(parent ?? '');
        info.position.setValue({ x: tmpPos.x, y: tmpPos.y, z: tmpPos.z });
        info.orientation.setValue({ x: tmpQuat.x, y: tmpQuat.y, z: tmpQuat.z, w: tmpQuat.w });
        if (tf.lookupRelative(info.name, tmpRelPos, tmpRelQuat)) {
          info.relPosition.setValue({ x: tmpRelPos.x, y: tmpRelPos.y, z: tmpRelPos.z });
          info.relOrientation.setValue({ x: tmpRelQuat.x, y: tmpRelQuat.y, z: tmpRelQuat.z, w: tmpRelQuat.w });
        }
      }
    }
    if (this.frames.size === 0) this.setStatus('warn', 'Frames', 'No tf data');
    else if (errors > 0) this.setStatus('warn', 'Frames', `${errors} frame(s) cannot be transformed to Fixed Frame [${this.context.fixedFrame()}]`);
    else this.setStatus('ok', 'Frames', `${this.frames.size} frames`);
  }

  override reset() {
    super.reset();
    for (const f of this.frames.values()) {
      f.dispose();
      f.node.removeFromParent();
      this.framesGroup.removeChild(f.enabled);
    }
    this.frames.clear();
    this.treeVersion = -1;
  }

  override fixedFrameChanged() {
    // Poses are re-read from the next snapshot; nothing to drop.
  }

  private readonly savedFrameStates = new Map<string, boolean>();

  /** Frame checkboxes from the config refer to frames that may not exist yet; remember them. */
  override load(yaml: import('../property/types').YamlValue, source: import('../property/types').ChangeSource = 'config') {
    super.load(yaml, source);
    const frames = (yaml as { Frames?: Record<string, unknown> } | null)?.Frames;
    if (frames && typeof frames === 'object') {
      for (const [k, v] of Object.entries(frames)) {
        if (k === 'All Enabled') continue;
        const enabled = typeof v === 'boolean' ? v : typeof v === 'object' && v && 'Value' in v ? Boolean((v as { Value: unknown }).Value) : undefined;
        if (enabled !== undefined) this.savedFrameStates.set(k, enabled);
      }
    }
    this.framesLoaded = true;
  }

  override describeSelection(hit: PickHit): Property | null {
    const info = this.frames.get(hit.object?.userData.frame as string);
    if (!info) return null;
    const g = selectionGroup(`Frame ${info.name}`);
    roString(g, 'Parent', info.parentProp.value());
    roVector(g, 'Position', info.position.value());
    roQuaternion(g, 'Orientation', info.orientation.value());
    roVector(g, 'Relative Position', info.relPosition.value());
    roQuaternion(g, 'Relative Orientation', info.relOrientation.value());
    return g;
  }
  override updateSelection(hit: PickHit, prop: Property) {
    const info = this.frames.get(hit.object?.userData.frame as string);
    if (!info) return;
    (prop.child('Parent') as StringPropertyImpl | undefined)?.setValue(info.parentProp.value());
    setVector(prop.child('Position'), info.position.value());
    setQuaternion(prop.child('Orientation'), info.orientation.value());
    setVector(prop.child('Relative Position'), info.relPosition.value());
    setQuaternion(prop.child('Relative Orientation'), info.relOrientation.value());
  }
  override selectionBounds(hit: PickHit, out: THREE.Box3): boolean {
    const info = this.frames.get(hit.object?.userData.frame as string);
    if (!info) return false;
    return boxAround(out, info.axes.position, 0.4 * this.markerScale.value());
  }

  override dispose() {
    for (const f of this.frames.values()) f.dispose();
    super.dispose();
  }
}

const tmpM = new THREE.Matrix4();
const tmpM2 = new THREE.Matrix4();
const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpParentPos = new THREE.Vector3();
const tmpRelPos = new THREE.Vector3();
const tmpRelQuat = new THREE.Quaternion();
