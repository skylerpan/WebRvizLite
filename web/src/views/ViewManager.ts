/**
 * rviz_common::ViewManager: owns the current ViewController, the registry of
 * view classes, and the "Views" config section (Current / Saved).
 */

import { createSignal, type Accessor } from 'solid-js';
import * as THREE from 'three/webgpu';
import { GroupProperty, isYamlMap } from '../property/Property';
import type { YamlMap, YamlValue } from '../property/types';
import { ORBIT_INFO, OrbitViewController } from './orbit';
import type { ViewClassInfo, ViewContext, ViewController } from './types';

export class ViewManager {
  private readonly classes = new Map<string, { info: ViewClassInfo; create: () => ViewController }>();
  /** Parent of the current view row, so the Views panel tree shows "Current View" as a root row. */
  readonly treeRoot = new GroupProperty('Views', null);
  readonly current: Accessor<ViewController>;
  private readonly setCurrent: (v: ViewController) => void;
  /** Saved views are kept verbatim until the Views panel implements them (Tier 1). */
  private savedYaml: YamlValue = null;
  private readonly ctx: ViewContext;
  /** Scene node for view helper geometry (orbit focal shape). */
  readonly helpers = new THREE.Group();

  constructor(ctx: ViewContext) {
    this.ctx = ctx;
    this.register(ORBIT_INFO, () => new OrbitViewController(ctx.fixedFrame));
    const first = this.create(ORBIT_INFO.classId);
    [this.current, this.setCurrent] = createSignal<ViewController>(first);
    this.attach(first);
  }

  register(info: ViewClassInfo, create: () => ViewController) {
    this.classes.set(info.classId, { info, create });
  }

  classInfos(): ViewClassInfo[] {
    return [...this.classes.values()].map((c) => c.info);
  }

  /**
   * Unknown classes (Tier 1 views such as TopDownOrtho) are driven as Orbit but
   * keep their Class and extra keys, so the config round-trips unchanged.
   */
  create(classId: string): ViewController {
    const entry = this.classes.get(classId);
    const v = entry ? entry.create() : new OrbitViewController(this.ctx.fixedFrame, classId);
    v.initialize(this.ctx);
    return v;
  }

  private attach(v: ViewController) {
    for (const c of this.treeRoot.children().slice()) this.treeRoot.removeChild(c);
    this.treeRoot.addChild(v);
    this.helpers.clear();
    if (v instanceof OrbitViewController) this.helpers.add(v.focalShape);
    v.setAspect(this.aspect);
  }

  private aspect = 1;
  setAspect(aspect: number) {
    this.aspect = aspect;
    this.current().setAspect(aspect);
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

  update(dt: number) {
    this.current().update(dt);
  }

  save(): YamlMap {
    return { Current: this.current().save(), Saved: this.savedYaml };
  }

  load(yaml: YamlValue) {
    if (!isYamlMap(yaml)) return;
    this.savedYaml = yaml.Saved ?? null;
    const cur = yaml.Current;
    if (isYamlMap(cur)) {
      const classId = typeof cur.Class === 'string' ? cur.Class : ORBIT_INFO.classId;
      const v = this.create(classId);
      v.load(cur);
      this.setCurrent(v);
      this.attach(v);
    }
  }
}
