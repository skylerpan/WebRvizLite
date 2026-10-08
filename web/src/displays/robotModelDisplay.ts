/**
 * rviz_default_plugins/RobotModel (robot_model_display.cpp + robot.cpp /
 * robot_link.cpp / robot_joint.cpp): draws the URDF from /robot_description
 * (or a file), placing every link by TF. Links are grouped under "Links" with
 * per-link enable / Alpha / Show Axes / Show Trail and read-only poses.
 */

import * as THREE from 'three/webgpu';
import { DisplayBase } from './Display';
import { BoolPropertyImpl, EnumPropertyImpl, FloatPropertyImpl, GroupProperty, QuaternionPropertyImpl, RosTopicPropertyImpl, StringPropertyImpl, VectorPropertyImpl, isYamlMap } from '../property/Property';
import type { ChangeSource, Property, YamlMap, YamlValue } from '../property/types';
import type { DisplayClassInfo } from './types';
import type { DataMessage } from '../worker/messages';
import { parseUrdf, type UrdfJoint, type UrdfLink, type UrdfModel, type UrdfOrigin, type UrdfVisual } from '../render/urdf';
import { disposeInstantiated, instantiateMesh, loadMesh, setObjectAlpha } from '../render/meshLoader';
import { Axes, UNIT_BOX, UNIT_CYLINDER_Z, UNIT_SPHERE } from '../render/primitives';
import { boxAround, roQuaternion, roString, roVector, selectionGroup, setQuaternion, setVector } from './selectionInfo';
import type { PickHit } from '../render/picking';

export const ROBOT_MODEL_INFO: DisplayClassInfo = {
  classId: 'rviz_default_plugins/RobotModel',
  name: 'RobotModel',
  description: 'Displays a visual representation of a robot in the correct pose (as defined by the current TF transforms).',
  messageTypes: ['std_msgs/msg/String'],
};

const LINK_TREE_STYLES = ['Links in Alphabetic Order', 'Joints in Alphabetic Order', 'Tree of links', 'Tree of links and joints'];
const SHARED = [UNIT_BOX, UNIT_CYLINDER_Z, UNIT_SPHERE];
const DEFAULT_COLOR = new THREE.Color(0.8, 0.8, 0.8);

/** One URDF link: scene nodes + its property row. */
class LinkEntry {
  readonly node = new THREE.Group();
  readonly visual = new THREE.Group();
  readonly collision = new THREE.Group();
  readonly axes = new Axes(0.1, 0.01);
  readonly enabled: BoolPropertyImpl;
  readonly alpha: FloatPropertyImpl;
  readonly showTrail: BoolPropertyImpl;
  readonly showAxes: BoolPropertyImpl;
  readonly position: VectorPropertyImpl;
  readonly orientation: QuaternionPropertyImpl;
  readonly details: GroupProperty;
  hasTransform = false;

  constructor(readonly link: UrdfLink, saved: YamlMap | undefined, onChange: () => void) {
    this.node.name = link.name;
    this.node.userData.linkName = link.name;
    this.node.matrixAutoUpdate = false;
    this.axes.visible = false;
    this.node.add(this.visual, this.collision, this.axes);
    this.enabled = new BoolPropertyImpl(link.name, true, null, { description: `Enable or disable rendering of link "${link.name}".` });
    this.details = new GroupProperty('Details', this.enabled, { description: 'Link details' });
    this.alpha = new FloatPropertyImpl('Alpha', 1, this.details, { description: 'Amount of transparency to apply to this link.', min: 0, max: 1 });
    this.showTrail = new BoolPropertyImpl('Show Trail', false, this.details, { description: 'Enable/disable a 2 meter "ribbon" which follows this link.' });
    this.showAxes = new BoolPropertyImpl('Show Axes', false, this.details, { description: 'Enable/disable showing the axes of this link.' });
    this.position = new VectorPropertyImpl('Position', { x: 0, y: 0, z: 0 }, this.details, { description: 'Position of this link, in the current Fixed Frame.  (Not editable)', readOnly: true });
    this.orientation = new QuaternionPropertyImpl('Orientation', { x: 0, y: 0, z: 0, w: 1 }, this.details, { description: 'Orientation of this link, in the current Fixed Frame.  (Not editable)', readOnly: true });
    if (saved) this.enabled.load(saved, 'config');
    for (const p of [this.enabled, this.alpha, this.showAxes]) p.onChange(onChange);
  }

  dispose() {
    disposeInstantiated(this.visual, SHARED);
    disposeInstantiated(this.collision, SHARED);
    this.axes.dispose();
  }
}

class JointEntry {
  readonly row: GroupProperty;
  constructor(readonly joint: UrdfJoint) {
    this.row = new GroupProperty(joint.name, null, { description: `Joint "${joint.name}"` });
    new StringPropertyImpl('Type', joint.type, this.row, { description: 'Joint type.', readOnly: true });
    new StringPropertyImpl('Parent', joint.parent, this.row, { description: 'Parent link.', readOnly: true });
    new StringPropertyImpl('Child', joint.child, this.row, { description: 'Child link.', readOnly: true });
    if (joint.type === 'revolute' || joint.type === 'prismatic') {
      new FloatPropertyImpl('Lower Limit', joint.limit?.lower ?? 0, this.row, { description: 'Lower limit of this joint.', readOnly: true });
      new FloatPropertyImpl('Upper Limit', joint.limit?.upper ?? 0, this.row, { description: 'Upper limit of this joint.', readOnly: true });
    }
    if (joint.type !== 'fixed') {
      new VectorPropertyImpl('Joint Axis', { x: joint.axis[0], y: joint.axis[1], z: joint.axis[2] }, this.row, { description: 'Axis of this joint.', readOnly: true });
    }
  }
}

export class RobotModelDisplay extends DisplayBase {
  readonly visualEnabled: BoolPropertyImpl;
  readonly collisionEnabled: BoolPropertyImpl;
  readonly massProperties: GroupProperty;
  readonly showMass: BoolPropertyImpl;
  readonly showInertia: BoolPropertyImpl;
  readonly updateInterval: FloatPropertyImpl;
  readonly alpha: FloatPropertyImpl;
  readonly descriptionSource: EnumPropertyImpl;
  readonly descriptionFile: StringPropertyImpl;
  readonly descriptionTopic: RosTopicPropertyImpl;
  readonly tfPrefix: StringPropertyImpl;
  readonly links: GroupProperty;
  readonly linkTreeStyle: EnumPropertyImpl;
  readonly expandTree: BoolPropertyImpl;
  readonly expandLinkDetails: BoolPropertyImpl;
  readonly expandJointDetails: BoolPropertyImpl;
  readonly allLinksEnabled: BoolPropertyImpl;

  private model: UrdfModel | null = null;
  private readonly entries = new Map<string, LinkEntry>();
  private jointRows: JointEntry[] = [];
  private subscriptionId: number | null = null;
  private sinceUpdate = 0;
  private changingAll = false;
  private readonly massNodes = new THREE.Group();
  /** Per-link YAML from the config, applied when the robot loads (rviz saves them under Links). */
  private savedLinks: YamlMap = {};
  private lastUrdf = '';

  constructor() {
    super(ROBOT_MODEL_INFO.classId, ROBOT_MODEL_INFO.name, ROBOT_MODEL_INFO.description);
    this.visualEnabled = new BoolPropertyImpl('Visual Enabled', true, this, { description: "Whether to display the visual representation of the robot." });
    this.collisionEnabled = new BoolPropertyImpl('Collision Enabled', false, this, { description: "Whether to display the collision representation of the robot." });
    this.massProperties = new GroupProperty('Mass Properties', this, { description: 'Mass properties of the links.' });
    this.showMass = new BoolPropertyImpl('Mass', false, this.massProperties, { description: 'Whether to display the visual representation of the mass of each link.' });
    this.showInertia = new BoolPropertyImpl('Inertia', false, this.massProperties, { description: 'Whether to display the visual representation of the inertia of each link.' });
    this.updateInterval = new FloatPropertyImpl('Update Interval', 0, this, { description: 'Interval at which to update the links, in seconds.  0 means to update every update cycle.', min: 0 });
    this.alpha = new FloatPropertyImpl('Alpha', 1, this, { description: 'Amount of transparency to apply to the links.', min: 0, max: 1 });
    this.descriptionSource = new EnumPropertyImpl('Description Source', 'Topic', ['Topic', 'File'], this, { description: 'Source to get the robot description from.' });
    this.descriptionFile = new StringPropertyImpl('Description File', '', this, { description: 'Path to the robot description.', hidden: true });
    // rviz2: /robot_description is latched by robot_state_publisher; subscribe transient local.
    this.descriptionTopic = new RosTopicPropertyImpl('Description Topic', '/robot_description', ROBOT_MODEL_INFO.messageTypes, this, { description: 'Topic where the robot description is published.', depth: 1, durability: 'Transient Local' });
    this.tfPrefix = new StringPropertyImpl('TF Prefix', '', this, { description: "Robot Model normally assumes the link name is the same as the tf frame name.  This option allows you to set a prefix.  Mainly useful for multi-robot situations." });
    this.links = new GroupProperty('Links', this, { description: 'All links of the robot.' });
    this.linkTreeStyle = new EnumPropertyImpl('Link Tree Style', LINK_TREE_STYLES[0], LINK_TREE_STYLES, this.links, { description: 'How the list of links is displayed' });
    this.expandTree = new BoolPropertyImpl('Expand Tree', false, this.links, { description: 'Expand or collapse link tree' });
    this.expandLinkDetails = new BoolPropertyImpl('Expand Link Details', false, this.links, { description: 'Expand or collapse link details' });
    this.expandJointDetails = new BoolPropertyImpl('Expand Joint Details', false, this.links, { description: 'Expand or collapse joint details' });
    this.allLinksEnabled = new BoolPropertyImpl('All Links Enabled', true, this.links, { description: 'Turn all links on or off.' });

    this.descriptionSource.onChange((v) => {
      this.descriptionFile.setHidden(v !== 'File');
      this.descriptionTopic.setHidden(v !== 'Topic');
      this.resubscribe();
    });
    this.descriptionTopic.onChange(() => this.resubscribe());
    for (const c of this.descriptionTopic.children()) c.onChange(() => this.resubscribe());
    this.descriptionFile.onChange(() => this.resubscribe());
    this.visualEnabled.onChange(() => this.applyVisibility());
    this.collisionEnabled.onChange(() => this.applyVisibility());
    this.alpha.onChange(() => this.applyAlpha());
    this.showMass.onChange(() => this.rebuildMass());
    this.showInertia.onChange(() => this.rebuildMass());
    this.linkTreeStyle.onChange(() => this.rebuildTree());
    this.allLinksEnabled.onChange((on) => {
      if (this.changingAll) return;
      this.changingAll = true;
      for (const e of this.entries.values()) e.enabled.setValue(on, 'user');
      this.changingAll = false;
      this.applyVisibility();
    });
    this.sceneNode.add(this.massNodes);
  }

  protected override onInitialize() {
    this.applyVisibility();
  }

  override onEnable() {
    this.resubscribe();
  }
  override onDisable() {
    this.unsubscribe();
  }

  private resubscribe() {
    this.unsubscribe();
    if (!this.context || !this.enabled()) return;
    if (this.descriptionSource.value() === 'File') {
      const file = this.descriptionFile.value();
      if (!file) {
        this.setStatus('error', 'URDF', 'No description file set');
        return;
      }
      void fetch(`/api/mesh?uri=${encodeURIComponent(file.startsWith('file://') || file.startsWith('package://') ? file : `file://${file}`)}`)
        .then(async (r) => {
          if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
          this.loadUrdf(await r.text());
        })
        .catch((e) => this.setStatus('error', 'URDF', `Could not load [${file}]: ${String(e)}`));
      return;
    }
    const topic = this.descriptionTopic.value();
    if (!topic) {
      this.setStatus('warn', 'URDF', 'No description topic set');
      return;
    }
    this.subscriptionId = this.context.bridge.subscribe(
      topic, ROBOT_MODEL_INFO.messageTypes[0], this.descriptionTopic.qos(), 'string',
      (m) => this.loadUrdf(((m as DataMessage).data as { text: string }).text),
      {},
      (message) => this.setStatus('error', 'URDF', message),
    );
    this.setStatus('warn', 'URDF', `Waiting for robot description on [${topic}]`);
  }

  private unsubscribe() {
    if (this.subscriptionId !== null && this.context) {
      this.context.bridge.unsubscribe(this.subscriptionId);
      this.subscriptionId = null;
    }
  }

  private loadUrdf(text: string) {
    if (text === this.lastUrdf && this.model) return;
    let model: UrdfModel;
    try {
      model = parseUrdf(text);
    } catch (e) {
      this.setStatus('error', 'URDF', `URDF failed to parse: ${String(e)}`);
      return;
    }
    this.lastUrdf = text;
    this.model = model;
    this.rebuildLinks();
    this.setStatus('ok', 'URDF', `Robot "${model.name}": ${model.links.size} links, ${model.joints.size} joints`);
  }

  private clearLinks() {
    for (const e of this.entries.values()) {
      this.releasePickable(e.node);
      e.node.removeFromParent();
      e.dispose();
    }
    this.entries.clear();
    for (const c of this.links.children().slice()) {
      if (c !== this.linkTreeStyle && c !== this.expandTree && c !== this.expandLinkDetails && c !== this.expandJointDetails && c !== this.allLinksEnabled) this.links.removeChild(c);
    }
  }

  private rebuildLinks() {
    this.clearLinks();
    const model = this.model;
    if (!model) return;
    const onChange = () => this.applyVisibility();
    for (const link of model.links.values()) {
      const saved = isYamlMap(this.savedLinks[link.name]) ? (this.savedLinks[link.name] as YamlMap) : undefined;
      const e = new LinkEntry(link, saved, onChange);
      e.enabled.onChange(() => {
        if (!this.changingAll) this.syncAllEnabled();
      });
      e.alpha.onChange(() => this.applyAlpha());
      e.node.visible = false;
      this.buildGeometry(e.visual, link.visuals, false);
      this.buildGeometry(e.collision, link.collisions, true);
      this.sceneNode.add(e.node);
      this.makePickable(e.node);
      this.entries.set(link.name, e);
    }
    this.jointRows = [...model.joints.values()].map((j) => new JointEntry(j));
    this.rebuildTree();
    this.rebuildMass();
    this.applyVisibility();
    this.applyAlpha();
  }

  private buildGeometry(group: THREE.Group, visuals: UrdfVisual[], wireframe: boolean) {
    for (const v of visuals) {
      const holder = new THREE.Group();
      applyOrigin(holder, v.origin);
      const color = v.color ? new THREE.Color(v.color[0], v.color[1], v.color[2]) : undefined;
      const baseAlpha = v.color ? v.color[3] : 1;
      const g = v.geometry;
      if (g.type === 'mesh') {
        holder.userData.baseAlpha = baseAlpha;
        loadMesh(g.filename)
          .then((proto) => {
            const inst = instantiateMesh(proto, { color: wireframe ? new THREE.Color(0.3, 0.9, 0.3) : color, alpha: baseAlpha, scale: g.scale, wireframe, useEmbeddedMaterials: !wireframe });
            holder.add(inst);
            this.applyAlpha();
          })
          .catch((e) => this.setStatus('error', `Mesh ${g.filename}`, `Could not load mesh: ${String(e)}`));
      } else {
        const material = new THREE.MeshBasicMaterial({ color: wireframe ? 0x4de64d : (color ?? DEFAULT_COLOR), wireframe, transparent: baseAlpha < 1, opacity: baseAlpha });
        let mesh: THREE.Mesh;
        if (g.type === 'box') {
          mesh = new THREE.Mesh(UNIT_BOX, material);
          mesh.scale.set(g.size[0], g.size[1], g.size[2]);
        } else if (g.type === 'cylinder') {
          mesh = new THREE.Mesh(UNIT_CYLINDER_Z, material);
          mesh.scale.set(g.radius, g.radius, g.length);
        } else {
          mesh = new THREE.Mesh(UNIT_SPHERE, material);
          mesh.scale.setScalar(g.radius);
        }
        mesh.userData.sharedGeometry = true;
        holder.userData.baseAlpha = baseAlpha;
        holder.add(mesh);
      }
      group.add(holder);
    }
  }

  /** Mass as a sphere at the inertial origin, inertia as the equivalent box (rviz robot_link.cpp). */
  private rebuildMass() {
    for (const c of this.massNodes.children.slice()) {
      disposeInstantiated(c, SHARED);
      c.removeFromParent();
    }
    const model = this.model;
    if (!model || (!this.showMass.value() && !this.showInertia.value())) return;
    for (const e of this.entries.values()) {
      const inertial = e.link.inertial;
      if (!inertial || inertial.mass <= 0) continue;
      const holder = new THREE.Group();
      applyOrigin(holder, inertial.origin);
      holder.userData.noPick = true;
      if (this.showMass.value()) {
        const r = Math.cbrt(inertial.mass) * 0.03;
        const sphere = new THREE.Mesh(UNIT_SPHERE, new THREE.MeshBasicMaterial({ color: 0xff8800, transparent: true, opacity: 0.6 }));
        sphere.scale.setScalar(r);
        sphere.userData.sharedGeometry = true;
        holder.add(sphere);
      }
      if (this.showInertia.value()) {
        const [ixx, , , iyy, , izz] = inertial.inertia;
        const m = inertial.mass;
        // Box with the same diagonal inertia: ixx = m/12 (b² + c²) etc.
        const sx = Math.sqrt(Math.max(0, (6 / m) * (iyy + izz - ixx)));
        const sy = Math.sqrt(Math.max(0, (6 / m) * (ixx + izz - iyy)));
        const sz = Math.sqrt(Math.max(0, (6 / m) * (ixx + iyy - izz)));
        const box = new THREE.Mesh(UNIT_BOX, new THREE.MeshBasicMaterial({ color: 0x00aaff, wireframe: true }));
        box.scale.set(sx, sy, sz);
        box.userData.sharedGeometry = true;
        holder.add(box);
      }
      e.node.add(holder);
      this.massNodes.userData.count = (this.massNodes.userData.count ?? 0) + 1;
    }
  }

  /** Rows under "Links" for the chosen Link Tree Style. */
  private rebuildTree() {
    for (const c of this.links.children().slice()) {
      if (c !== this.linkTreeStyle && c !== this.expandTree && c !== this.expandLinkDetails && c !== this.expandJointDetails && c !== this.allLinksEnabled) this.links.removeChild(c);
    }
    for (const e of this.entries.values()) for (const c of e.enabled.children().slice()) if (c !== e.details) e.enabled.removeChild(c);
    for (const j of this.jointRows) for (const c of j.row.children().slice()) if (c.kind !== 'string' && c.kind !== 'float' && c.kind !== 'vector') j.row.removeChild(c);
    const model = this.model;
    if (!model) return;
    // Configs saved before the robot loaded carry `Link Tree Style: ""`; keep it for round-trip, draw as the default.
    const style = LINK_TREE_STYLES.includes(this.linkTreeStyle.value()) ? this.linkTreeStyle.value() : LINK_TREE_STYLES[0];
    const sorted = [...this.entries.values()].sort((a, b) => a.link.name.localeCompare(b.link.name));
    const childJoints = (link: string) => this.jointRows.filter((j) => j.joint.parent === link).sort((a, b) => a.joint.name.localeCompare(b.joint.name));
    const addLinkTree = (e: LinkEntry, parent: Property, withJoints: boolean) => {
      parent.addChild(e.enabled);
      for (const j of childJoints(e.link.name)) {
        const childEntry = this.entries.get(j.joint.child);
        if (withJoints) {
          e.enabled.addChild(j.row);
          if (childEntry) addLinkTree(childEntry, j.row, true);
        } else if (childEntry) {
          addLinkTree(childEntry, e.enabled, false);
        }
      }
    };
    switch (style) {
      case 'Joints in Alphabetic Order':
        for (const j of [...this.jointRows].sort((a, b) => a.joint.name.localeCompare(b.joint.name))) this.links.addChild(j.row);
        break;
      case 'Tree of links':
      case 'Tree of links and joints':
        for (const root of model.roots) {
          const e = this.entries.get(root);
          if (e) addLinkTree(e, this.links, style === 'Tree of links and joints');
        }
        break;
      default:
        for (const e of sorted) this.links.addChild(e.enabled);
    }
  }

  private syncAllEnabled() {
    const all = [...this.entries.values()].every((e) => e.enabled.value());
    this.changingAll = true;
    this.allLinksEnabled.setValue(all, 'program');
    this.changingAll = false;
    this.applyVisibility();
  }

  private applyVisibility() {
    const visual = this.visualEnabled.value();
    const collision = this.collisionEnabled.value();
    for (const e of this.entries.values()) {
      e.visual.visible = visual;
      e.collision.visible = collision;
      e.axes.visible = e.showAxes.value();
      e.node.visible = e.enabled.value() && e.hasTransform;
    }
  }

  private applyAlpha() {
    const a = this.alpha.value();
    for (const e of this.entries.values()) {
      const la = a * e.alpha.value();
      for (const holder of [...e.visual.children, ...e.collision.children]) setObjectAlpha(holder, la * ((holder.userData.baseAlpha as number | undefined) ?? 1));
    }
  }

  override update(wallDt: number) {
    if (!this.context || !this.model) return;
    this.sinceUpdate += wallDt;
    if (this.sinceUpdate < this.updateInterval.value()) return;
    this.sinceUpdate = 0;
    const tf = this.context.tf;
    const prefix = this.tfPrefix.value();
    let missing = 0;
    let shown = 0;
    for (const e of this.entries.values()) {
      const frame = prefix ? `${prefix}/${e.link.name}` : e.link.name;
      if (tf.lookup(frame, e.node.matrix, tmpPos, tmpQuat)) {
        e.hasTransform = true;
        e.node.matrixWorldNeedsUpdate = true;
        e.node.visible = e.enabled.value();
        e.position.setValue({ x: tmpPos.x, y: tmpPos.y, z: tmpPos.z });
        e.orientation.setValue({ x: tmpQuat.x, y: tmpQuat.y, z: tmpQuat.z, w: tmpQuat.w });
        shown++;
      } else {
        e.hasTransform = false;
        e.node.visible = false;
        missing++;
      }
    }
    if (missing === 0) this.setStatus('ok', 'Transform', `All ${shown} links transformed`);
    else this.setStatus(shown === 0 ? 'error' : 'warn', 'Transform', `${missing} link(s) without a transform to [${this.context.fixedFrame()}]`);
  }

  override describeSelection(hit: PickHit): Property | null {
    const e = this.entries.get(hit.object?.userData.linkName as string);
    if (!e) return null;
    const g = selectionGroup(`Link ${e.link.name} [${this.name()}]`);
    roString(g, 'Robot', this.model?.name ?? '');
    roVector(g, 'Position', e.position.value());
    roQuaternion(g, 'Orientation', e.orientation.value());
    return g;
  }
  override updateSelection(hit: PickHit, prop: Property) {
    const e = this.entries.get(hit.object?.userData.linkName as string);
    if (!e) return;
    setVector(prop.child('Position'), e.position.value());
    setQuaternion(prop.child('Orientation'), e.orientation.value());
  }
  override selectionBounds(hit: PickHit, out: THREE.Box3): boolean {
    const e = this.entries.get(hit.object?.userData.linkName as string);
    if (!e) return false;
    out.setFromObject(e.node);
    if (!out.isEmpty()) return true;
    return boxAround(out, e.position.value(), 0.2);
  }

  override reset() {
    super.reset();
    for (const e of this.entries.values()) {
      e.hasTransform = false;
      e.node.visible = false;
    }
  }

  override save(): YamlMap {
    const map = super.save();
    // Per-link rows are children of Links and already serialized by the property tree.
    return map;
  }

  override load(yaml: YamlValue, source: ChangeSource = 'config') {
    if (isYamlMap(yaml) && isYamlMap(yaml.Links)) {
      this.savedLinks = {};
      for (const [k, v] of Object.entries(yaml.Links)) if (isYamlMap(v) && !['Link Tree Style', 'Expand Tree', 'Expand Link Details', 'Expand Joint Details', 'All Links Enabled'].includes(k)) this.savedLinks[k] = v;
    }
    super.load(yaml, source);
  }

  override dispose() {
    this.unsubscribe();
    this.clearLinks();
    super.dispose();
  }
}

/** URDF origin: xyz translation + fixed-axis roll/pitch/yaw (R = Rz·Ry·Rx). */
function applyOrigin(obj: THREE.Object3D, origin: UrdfOrigin) {
  obj.position.set(origin.xyz[0], origin.xyz[1], origin.xyz[2]);
  obj.rotation.set(origin.rpy[0], origin.rpy[1], origin.rpy[2], 'ZYX');
}

const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
