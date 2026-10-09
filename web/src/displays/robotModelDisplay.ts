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
import { Arrow, Axes, UNIT_BOX, UNIT_CYLINDER_Z, UNIT_SPHERE } from '../render/primitives';
import type { QosProfile } from '../worker/messages';
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
/** rviz robot_link.cpp: links without a material use RVIZ/ShadedRed. */
const DEFAULT_COLOR = new THREE.Color(1, 0, 0);

/** rviz RobotJoint::updateChildVisibility: a joint row hides its child link and everything below. */
const JOINT_AXIS_TYPES = new Set(['continuous', 'revolute', 'prismatic', 'planar']);
const JOINT_AXIS_COLOR = new THREE.Color(0, 0.8, 0);

/** Flattens a `Details: {...}` sub-map (tree styles) so a row loads in either layout. */
function flattenDetails(saved: YamlMap | undefined): YamlMap | undefined {
  if (!saved) return undefined;
  const { Details, ...rest } = saved;
  return isYamlMap(Details) ? { ...Details, ...rest } : saved;
}

/** One URDF link: scene nodes + its property row (rviz robot_link.cpp). */
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
  /** "Details" sub-group used by the two tree styles (rviz useDetailProperty). */
  readonly details: GroupProperty;
  private detailsOn = false;
  hasTransform = false;

  constructor(readonly link: UrdfLink, saved: YamlMap | undefined, onChange: () => void) {
    this.node.name = link.name;
    this.node.userData.linkName = link.name;
    this.node.matrixAutoUpdate = false;
    this.axes.visible = false;
    this.node.add(this.visual, this.collision, this.axes);
    this.enabled = new BoolPropertyImpl(link.name, true, null, { description: `Link <b>${link.name}</b>. Check/uncheck to show/hide this link in the display.` });
    this.details = new GroupProperty('Details', null, { description: 'Link details' });
    this.alpha = new FloatPropertyImpl('Alpha', 1, this.enabled, { description: 'Amount of transparency to apply to this link.', min: 0, max: 1 });
    this.showTrail = new BoolPropertyImpl('Show Trail', false, this.enabled, { description: 'Enable/disable a 2 meter "ribbon" which follows this link.' });
    this.showAxes = new BoolPropertyImpl('Show Axes', false, this.enabled, { description: 'Enable/disable showing the axes of this link.' });
    this.position = new VectorPropertyImpl('Position', { x: 0, y: 0, z: 0 }, this.enabled, { description: 'Position of this link, in the current Fixed Frame.  (Not editable)', readOnly: true });
    this.orientation = new QuaternionPropertyImpl('Orientation', { x: 0, y: 0, z: 0, w: 1 }, this.enabled, { description: 'Orientation of this link, in the current Fixed Frame.  (Not editable)', readOnly: true });
    // rviz hides Alpha on links without geometry.
    if (link.visuals.length === 0 && link.collisions.length === 0) this.alpha.setHidden(true);
    const flat = flattenDetails(saved);
    if (flat) this.enabled.load(flat, 'config');
    for (const p of [this.enabled, this.alpha, this.showAxes]) p.onChange(onChange);
  }

  /** Tree styles nest the rows under "Details"; list styles keep them directly under the link. */
  useDetails(on: boolean) {
    if (on === this.detailsOn) return;
    this.detailsOn = on;
    const rows = [this.alpha, this.showTrail, this.showAxes, this.position, this.orientation];
    const from = on ? this.enabled : this.details;
    const to = on ? this.details : this.enabled;
    for (const r of rows) {
      from.removeChild(r);
      to.addChild(r);
    }
    if (on) this.enabled.addChild(this.details, 0);
    else this.enabled.removeChild(this.details);
  }

  dispose() {
    disposeInstantiated(this.visual, SHARED);
    disposeInstantiated(this.collision, SHARED);
    this.axes.dispose();
  }
}

/** One URDF joint: its property row (rviz robot_joint.cpp) and optional axes / joint-axis arrow. */
class JointEntry {
  readonly enabled: BoolPropertyImpl;
  readonly details: GroupProperty;
  readonly showAxes: BoolPropertyImpl;
  readonly position: VectorPropertyImpl;
  readonly orientation: QuaternionPropertyImpl;
  readonly showJointAxis: BoolPropertyImpl | null = null;
  readonly node = new THREE.Group();
  readonly axes = new Axes(0.1, 0.01);
  readonly axisArrow: Arrow | null = null;
  readonly originMatrix = new THREE.Matrix4();
  private readonly rows: Property[];
  private detailsOn = false;

  constructor(readonly joint: UrdfJoint, saved: YamlMap | undefined, onChange: () => void) {
    this.enabled = new BoolPropertyImpl(joint.name, true, null, { description: `Joint <b>${joint.name}</b> with parent link <b>${joint.parent}</b> and child link <b>${joint.child}</b>.` });
    this.details = new GroupProperty('Details', null, { description: 'Joint details' });
    this.showAxes = new BoolPropertyImpl('Show Axes', false, this.enabled, { description: 'Enable/disable showing the axes of this joint.' });
    this.position = new VectorPropertyImpl('Position', { x: 0, y: 0, z: 0 }, this.enabled, { description: 'Position of this joint, in the current Fixed Frame.  (Not editable)', readOnly: true });
    this.orientation = new QuaternionPropertyImpl('Orientation', { x: 0, y: 0, z: 0, w: 1 }, this.enabled, { description: 'Orientation of this joint, in the current Fixed Frame.  (Not editable)', readOnly: true });
    this.rows = [this.showAxes, this.position, this.orientation];
    this.rows.push(new StringPropertyImpl('Type', joint.type, this.enabled, { description: 'Type of this joint.  (Not editable)', readOnly: true }));
    if (joint.limit) {
      this.rows.push(new FloatPropertyImpl('Lower Limit', joint.limit.lower, this.enabled, { description: 'Lower limit of this joint.  (Not editable)', readOnly: true }));
      this.rows.push(new FloatPropertyImpl('Upper Limit', joint.limit.upper, this.enabled, { description: 'Upper limit of this joint.  (Not editable)', readOnly: true }));
    }
    if (JOINT_AXIS_TYPES.has(joint.type)) {
      this.showJointAxis = new BoolPropertyImpl('Show Joint Axis', false, this.enabled, { description: 'Enable/disable showing the axis of this joint.' });
      this.rows.push(this.showJointAxis);
      this.rows.push(new VectorPropertyImpl('Joint Axis', { x: joint.axis[0], y: joint.axis[1], z: joint.axis[2] }, this.enabled, { description: 'Axis of this joint.  (Not editable)', readOnly: true }));
      // rviz: a green arrow along the joint axis.
      this.axisArrow = new Arrow(JOINT_AXIS_COLOR.getHex(), 0.15, 0.05, 0.05, 0.08);
      this.axisArrow.visible = false;
      this.axisArrow.quaternion.setFromUnitVectors(X_AXIS, tmpV.set(joint.axis[0], joint.axis[1], joint.axis[2]).normalize());
      this.node.add(this.axisArrow);
    }
    this.axes.visible = false;
    this.node.add(this.axes);
    this.node.userData.noPick = true;
    applyOrigin(this.node, joint.origin);
    this.originMatrix.copy(this.node.matrix);
    this.node.matrixAutoUpdate = false;
    const flat = flattenDetails(saved);
    if (flat) this.enabled.load(flat, 'config');
    for (const p of [this.enabled, this.showAxes, this.showJointAxis]) p?.onChange(onChange);
  }

  useDetails(on: boolean) {
    if (on === this.detailsOn) return;
    this.detailsOn = on;
    const from = on ? this.enabled : this.details;
    const to = on ? this.details : this.enabled;
    for (const r of this.rows) {
      from.removeChild(r);
      to.addChild(r);
    }
    if (on) this.enabled.addChild(this.details, 0);
    else this.enabled.removeChild(this.details);
  }

  dispose() {
    this.axes.dispose();
    this.axisArrow?.dispose();
  }
}

/** rviz Robot::setLinkTreeStyle: the "Links" group is renamed and described per style. */
const LINK_TREE_GROUP: Record<string, { name: string; description: string; tree: boolean; linkDetails: boolean; jointDetails: boolean }> = {
  'Links in Alphabetic Order': { name: 'Links', description: 'All links in the robot in alphabetic order.  Uncheck a link to hide its geometry.', tree: false, linkDetails: true, jointDetails: false },
  'Joints in Alphabetic Order': { name: 'Joints', description: 'All joints in the robot in alphabetic order.', tree: false, linkDetails: false, jointDetails: true },
  'Tree of links': { name: 'Link Tree', description: 'A tree of all links in the robot.  Uncheck a link to hide its geometry.', tree: true, linkDetails: true, jointDetails: false },
  'Tree of links and joints': { name: 'Link/Joint Tree', description: 'A tree of all joints and links in the robot.  Uncheck a link to hide its geometry.', tree: true, linkDetails: true, jointDetails: true },
};
const LINK_TREE_GROUP_NAMES = Object.values(LINK_TREE_GROUP).map((g) => g.name);

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
  /** Per-link / per-joint YAML from the config, applied when the robot loads (rviz saves them under the Links group). */
  private savedLinks: YamlMap = {};
  /** True once a QoS row changed: the subscription then follows the rows instead of KeepLast(1)+transient local. */
  private qosEdited = false;
  private geometryErrors: string[] = [];
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
    // robot_model_display.cpp: the rows show the generic QoS defaults, but the subscription itself is
    // KeepLast(1) + transient local until a QoS row is actually changed (see effectiveQos()).
    this.descriptionTopic = new RosTopicPropertyImpl('Description Topic', '', ROBOT_MODEL_INFO.messageTypes, this, { description: 'Topic where filepath to urdf is published.' });
    this.tfPrefix = new StringPropertyImpl('TF Prefix', '', this, { description: "Robot Model normally assumes the link name is the same as the tf frame name.  This option allows you to set a prefix.  Mainly useful for multi-robot situations." });
    this.links = new GroupProperty('Links', this, { description: LINK_TREE_GROUP[LINK_TREE_STYLES[0]].description });
    this.linkTreeStyle = new EnumPropertyImpl('Link Tree Style', LINK_TREE_STYLES[0], LINK_TREE_STYLES, this.links, { description: 'How the list of links is displayed' });
    this.expandTree = new BoolPropertyImpl('Expand Tree', false, this.links, { description: 'Expand or collapse link tree', hidden: true });
    this.expandLinkDetails = new BoolPropertyImpl('Expand Link Details', false, this.links, { description: 'Expand link details (sub properties) to see all info for all links.' });
    this.expandJointDetails = new BoolPropertyImpl('Expand Joint Details', false, this.links, { description: 'Expand joint details (sub properties) to see all info for all joints.', hidden: true });
    this.allLinksEnabled = new BoolPropertyImpl('All Links Enabled', true, this.links, { description: 'Turn all links on or off.' });

    this.descriptionSource.onChange((v) => {
      this.descriptionFile.setHidden(v !== 'File');
      this.descriptionTopic.setHidden(v !== 'Topic');
      this.resubscribe();
    });
    this.descriptionTopic.onChange(() => this.resubscribe());
    for (const c of this.descriptionTopic.children()) {
      c.onChange(() => {
        this.qosEdited = true;
        this.resubscribe();
      });
    }
    this.descriptionFile.onChange(() => this.resubscribe());
    this.visualEnabled.onChange(() => this.applyVisibility());
    this.collisionEnabled.onChange(() => this.applyVisibility());
    this.alpha.onChange(() => this.applyAlpha());
    this.showMass.onChange(() => this.rebuildMass());
    this.showInertia.onChange(() => this.rebuildMass());
    this.linkTreeStyle.onChange(() => {
      // rviz: every style change collapses the three Expand toggles.
      for (const p of [this.expandTree, this.expandLinkDetails, this.expandJointDetails]) p.setValue(false, 'program');
      this.rebuildTree();
    });
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
        .catch(() => this.setStatus('error', 'URDF', 'URDF is empty'));
      return;
    }
    const topic = this.descriptionTopic.value();
    if (!topic) {
      this.setStatus('warn', 'URDF', 'No description topic set');
      return;
    }
    this.subscriptionId = this.context.bridge.subscribe(
      topic, ROBOT_MODEL_INFO.messageTypes[0], this.effectiveQos(), 'string',
      (m) => this.loadUrdf(((m as DataMessage).data as { text: string }).text),
      {},
      (message) => this.setStatus('error', 'URDF', message),
    );
    this.setStatus('warn', 'URDF', `Waiting for robot description on [${topic}]`);
  }

  /** robot_model_display.cpp sets `rclcpp::QoS(KeepLast(1)).transient_local()`; editing a QoS row replaces it. */
  private effectiveQos(): QosProfile {
    if (this.qosEdited) return this.descriptionTopic.qos();
    return { depth: 1, history: 'keep_last', reliability: 'reliable', durability: 'transient_local' };
  }

  private unsubscribe() {
    if (this.subscriptionId !== null && this.context) {
      this.context.bridge.unsubscribe(this.subscriptionId);
      this.subscriptionId = null;
    }
  }

  private loadUrdf(text: string) {
    if (text === this.lastUrdf && this.model) return;
    if (!text.trim()) {
      this.setStatus('error', 'URDF', 'URDF is empty');
      return;
    }
    let model: UrdfModel;
    try {
      model = parseUrdf(text);
    } catch (e) {
      console.warn('[RobotModel] URDF parse error:', e);
      this.setStatus('error', 'URDF', 'URDF failed Model parse');
      return;
    }
    this.lastUrdf = text;
    this.model = model;
    this.geometryErrors = [];
    this.rebuildLinks();
    this.setStatus('ok', 'URDF', 'URDF parsed OK');
  }

  private clearLinks() {
    for (const e of this.entries.values()) {
      this.releasePickable(e.node);
      e.node.removeFromParent();
      e.dispose();
    }
    this.entries.clear();
    for (const j of this.jointRows) {
      j.node.removeFromParent();
      j.dispose();
    }
    this.jointRows = [];
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
      this.buildGeometry(e.visual, link.visuals, link.name);
      // rviz draws collision geometry with the same materials as the visuals.
      this.buildGeometry(e.collision, link.collisions, link.name);
      this.sceneNode.add(e.node);
      this.makePickable(e.node);
      this.entries.set(link.name, e);
    }
    this.jointRows = [...model.joints.values()].map((j) => {
      const saved = isYamlMap(this.savedLinks[j.name]) ? (this.savedLinks[j.name] as YamlMap) : undefined;
      const je = new JointEntry(j, saved, () => this.applyVisibility());
      je.enabled.onChange((on) => this.setSubtreeEnabled(j.child, on));
      this.sceneNode.add(je.node);
      return je;
    });
    this.rebuildTree();
    this.rebuildMass();
    this.applyVisibility();
    this.applyAlpha();
  }

  /** rviz RobotJoint::updateChildVisibility: unchecking a joint hides its child link and everything below. */
  private setSubtreeEnabled(link: string, on: boolean) {
    const e = this.entries.get(link);
    if (!e) return;
    e.enabled.setValue(on, 'program');
    for (const j of this.jointRows) if (j.joint.parent === link) this.setSubtreeEnabled(j.joint.child, on);
  }

  private buildGeometry(group: THREE.Group, visuals: UrdfVisual[], linkName: string) {
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
            const inst = instantiateMesh(proto, { color, alpha: baseAlpha, scale: g.scale, useEmbeddedMaterials: true });
            holder.add(inst);
            this.applyAlpha();
          })
          .catch((e) => {
            // robot_model_display.cpp collects these under the URDF status.
            this.geometryErrors.push(`• for link '${linkName}':\n${String(e)}`);
            this.setStatus('error', 'URDF', `Errors loading geometries:\n${this.geometryErrors.join('\n')}`);
          });
      } else {
        const material = new THREE.MeshBasicMaterial({ color: color ?? DEFAULT_COLOR, transparent: baseAlpha < 1, opacity: baseAlpha });
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
        const sphere = new THREE.Mesh(UNIT_SPHERE, new THREE.MeshBasicMaterial({ color: 0xff0000, transparent: true, opacity: 0.6 }));
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

  /** Rows under the Links group for the chosen Link Tree Style (rviz Robot::setLinkTreeStyle). */
  private rebuildTree() {
    for (const c of this.links.children().slice()) {
      if (c !== this.linkTreeStyle && c !== this.expandTree && c !== this.expandLinkDetails && c !== this.expandJointDetails && c !== this.allLinksEnabled) this.links.removeChild(c);
    }
    for (const e of this.entries.values()) for (const c of e.enabled.children().slice()) if (c !== e.details && !(e.details.children() as Property[]).includes(c) && (c as Property).kind === 'bool' && c !== e.alpha && c !== e.showTrail && c !== e.showAxes) e.enabled.removeChild(c);
    for (const j of this.jointRows) for (const c of j.enabled.children().slice()) if (c !== j.details && (c as Property).kind === 'bool' && c !== j.showAxes && c !== j.showJointAxis) j.enabled.removeChild(c);
    // Configs saved before the robot loaded carry `Link Tree Style: ""`; keep it for round-trip, draw as the default.
    const style = LINK_TREE_STYLES.includes(this.linkTreeStyle.value()) ? this.linkTreeStyle.value() : LINK_TREE_STYLES[0];
    const layout = LINK_TREE_GROUP[style];
    this.links.setName(layout.name);
    this.links.setDescription(layout.description);
    this.expandTree.setHidden(!layout.tree);
    this.expandLinkDetails.setHidden(!layout.linkDetails);
    this.expandJointDetails.setHidden(!layout.jointDetails);
    for (const e of this.entries.values()) e.useDetails(layout.tree);
    for (const j of this.jointRows) j.useDetails(layout.tree);
    const model = this.model;
    if (!model) return;
    const sorted = [...this.entries.values()].sort((a, b) => a.link.name.localeCompare(b.link.name));
    const childJoints = (link: string) => this.jointRows.filter((j) => j.joint.parent === link).sort((a, b) => a.joint.name.localeCompare(b.joint.name));
    const addLinkTree = (e: LinkEntry, parent: Property, withJoints: boolean) => {
      parent.addChild(e.enabled);
      for (const j of childJoints(e.link.name)) {
        const childEntry = this.entries.get(j.joint.child);
        if (withJoints) {
          e.enabled.addChild(j.enabled);
          if (childEntry) addLinkTree(childEntry, j.enabled, true);
        } else if (childEntry) {
          addLinkTree(childEntry, e.enabled, false);
        }
      }
    };
    switch (style) {
      case 'Joints in Alphabetic Order':
        for (const j of [...this.jointRows].sort((a, b) => a.joint.name.localeCompare(b.joint.name))) this.links.addChild(j.enabled);
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
    for (const j of this.jointRows) {
      const parent = this.entries.get(j.joint.parent);
      const show = !!parent?.hasTransform && parent.enabled.value();
      j.node.visible = show;
      if (!show) continue;
      // Joint pose = parent link pose × joint origin (rviz RobotJoint::getPosition).
      j.node.matrix.copy(parent.node.matrix).multiply(j.originMatrix);
      j.node.matrixWorldNeedsUpdate = true;
      j.node.matrix.decompose(tmpPos, tmpQuat, tmpScale);
      j.position.setValue({ x: tmpPos.x, y: tmpPos.y, z: tmpPos.z });
      j.orientation.setValue({ x: tmpQuat.x, y: tmpQuat.y, z: tmpQuat.z, w: tmpQuat.w });
      j.axes.visible = j.showAxes.value();
      if (j.axisArrow) j.axisArrow.visible = j.showJointAxis?.value() ?? false;
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
    if (isYamlMap(yaml)) {
      // rviz saves the group under its current name: Links / Joints / Link Tree / Link/Joint Tree.
      const key = LINK_TREE_GROUP_NAMES.find((n) => isYamlMap(yaml[n]));
      if (key) {
        this.links.setName(key);
        this.savedLinks = {};
        for (const [k, v] of Object.entries(yaml[key] as YamlMap)) if (isYamlMap(v) && !['Link Tree Style', 'Expand Tree', 'Expand Link Details', 'Expand Joint Details', 'All Links Enabled'].includes(k)) this.savedLinks[k] = v;
      }
    }
    super.load(yaml, source);
    this.rebuildTree();
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
const tmpScale = new THREE.Vector3();
const tmpV = new THREE.Vector3();
const X_AXIS = new THREE.Vector3(1, 0, 0);
