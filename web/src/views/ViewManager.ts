/**
 * rviz_common::ViewManager: owns the current ViewController, the saved views,
 * the registry of view classes, and the "Views" config section (Current / Saved).
 */

import { createSignal, type Accessor } from 'solid-js';
import * as THREE from 'three/webgpu';
import { GroupProperty, isYamlMap } from '../property/Property';
import type { YamlMap, YamlValue } from '../property/types';
import { ORBIT_INFO, OrbitViewController } from './orbit';
import { TOP_DOWN_ORTHO_INFO, TopDownOrthoViewController } from './topDownOrtho';
import { FPS_INFO, FpsViewController } from './fps';
import type { ViewClassInfo, ViewContext, ViewController } from './types';

export class ViewManager {
  private readonly classes = new Map<string, { info: ViewClassInfo; create: () => ViewController }>();
  /** Parent of the view rows: "Current View" first, then the saved views (rviz ViewsPanel layout). */
  readonly treeRoot = new GroupProperty('Views', null);
  readonly current: Accessor<ViewController>;
  private readonly setCurrent: (v: ViewController) => void;
  readonly saved: Accessor<readonly ViewController[]>;
  private readonly setSaved: (v: readonly ViewController[]) => void;
  private readonly ctx: ViewContext;
  /** Scene node for view helper geometry (orbit focal shape). */
  readonly helpers = new THREE.Group();
  private width = 1;
  private height = 1;

  constructor(ctx: ViewContext) {
    this.ctx = ctx;
    this.register(ORBIT_INFO, () => new OrbitViewController(ctx.fixedFrame));
    this.register(TOP_DOWN_ORTHO_INFO, () => new TopDownOrthoViewController(ctx.fixedFrame));
    this.register(FPS_INFO, () => new FpsViewController(ctx.fixedFrame));
    const first = this.create(ORBIT_INFO.classId);
    [this.current, this.setCurrent] = createSignal<ViewController>(first);
    [this.saved, this.setSaved] = createSignal<readonly ViewController[]>([]);
    this.attach(first);
  }

  register(info: ViewClassInfo, create: () => ViewController) {
    this.classes.set(info.classId, { info, create });
  }

  classInfos(): ViewClassInfo[] {
    return [...this.classes.values()].map((c) => c.info);
  }

  /**
   * Unknown classes (Tier 2 views such as ThirdPersonFollower) are driven as
   * Orbit but keep their Class and extra keys, so the config round-trips unchanged.
   */
  create(classId: string): ViewController {
    const entry = this.classes.get(classId);
    const v = entry ? entry.create() : new OrbitViewController(this.ctx.fixedFrame, classId);
    v.initialize(this.ctx);
    return v;
  }

  private attach(v: ViewController) {
    this.rebuildTree(v);
    this.helpers.clear();
    if (v instanceof OrbitViewController) this.helpers.add(v.focalShape);
    v.setViewportSize(this.width, this.height);
  }

  private rebuildTree(current = this.current()) {
    for (const c of this.treeRoot.children().slice()) this.treeRoot.removeChild(c);
    this.treeRoot.addChild(current);
    for (const s of this.saved()) this.treeRoot.addChild(s);
  }

  setViewportSize(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.current().setViewportSize(width, height);
  }

  /** Switches controller type, carrying the camera pose over (rviz "mimic"). */
  setCurrentClass(classId: string) {
    const prev = this.current();
    if (prev.classId === classId) return;
    const next = this.create(classId);
    next.mimic(prev);
    this.setCurrent(next);
    this.attach(next);
  }

  /** Makes a copy of a saved view the current view (rviz ViewManager::setCurrentFrom). */
  setCurrentFrom(source: ViewController) {
    const next = this.create(source.classId);
    next.load(source.save());
    next.setName('Current View');
    this.setCurrent(next);
    this.attach(next);
  }

  /** Copies the current view into the saved list under `name` (rviz copyCurrentToList). */
  saveCurrent(name: string): ViewController {
    const cur = this.current();
    const copy = this.create(cur.classId);
    copy.load(cur.save());
    copy.setName(name);
    this.setSaved([...this.saved(), copy]);
    this.rebuildTree();
    return copy;
  }

  removeSaved(view: ViewController) {
    this.setSaved(this.saved().filter((v) => v !== view));
    this.rebuildTree();
  }

  renameSaved(view: ViewController, name: string) {
    view.setName(name);
  }

  /** The saved view a tree property belongs to, if any. */
  savedOf(prop: { parent: unknown } | null): ViewController | null {
    let p: unknown = prop;
    while (p && (p as { parent: unknown }).parent !== this.treeRoot) p = (p as { parent: unknown }).parent;
    return this.saved().find((v) => v === p) ?? null;
  }

  update(dt: number) {
    this.current().update(dt);
  }

  save(): YamlMap {
    const saved = this.saved();
    return { Current: this.current().save(), Saved: saved.length ? saved.map((v) => v.save()) : null };
  }

  load(yaml: YamlValue) {
    if (!isYamlMap(yaml)) return;
    const savedList: ViewController[] = [];
    if (Array.isArray(yaml.Saved)) {
      for (const entry of yaml.Saved) {
        if (!isYamlMap(entry)) continue;
        const classId = typeof entry.Class === 'string' ? entry.Class : ORBIT_INFO.classId;
        const v = this.create(classId);
        v.load(entry);
        savedList.push(v);
      }
    }
    this.setSaved(savedList);
    const cur = yaml.Current;
    if (isYamlMap(cur)) {
      const classId = typeof cur.Class === 'string' ? cur.Class : ORBIT_INFO.classId;
      const v = this.create(classId);
      v.load(cur);
      this.setCurrent(v);
      this.attach(v);
    } else {
      this.rebuildTree();
    }
  }
}
