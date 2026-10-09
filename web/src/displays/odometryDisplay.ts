/**
 * rviz_default_plugins/Odometry (odometry_display.cpp): keeps the last `Keep`
 * poses that moved more than the tolerances, drawn as instanced arrows or axes
 * plus batched covariance visuals. The arrow/axes sizes are children of Shape.
 */

import * as THREE from 'three/webgpu';
import { MessageFilterDisplayBase } from './Display';
import { FloatPropertyImpl, IntPropertyImpl } from '../property/Property';
import type { DisplayClassInfo } from './types';
import type { DataMessage } from '../worker/messages';
import type { PoseCovMsg } from '../worker/decoders';
import { InstancedArrows, InstancedAxes } from '../render/instanced';
import { PoseShapeProps } from '../render/poseShape';
import { CovarianceVisuals } from '../render/covarianceVisual';
import { CovariancePropertyImpl } from './covarianceProperty';
import { addPoseRows, boxAround, selectionGroup } from './selectionInfo';
import type { PickHit } from '../render/picking';
import type { Property } from '../property/types';

export const ODOMETRY_INFO: DisplayClassInfo = {
  classId: 'rviz_default_plugins/Odometry',
  name: 'Odometry',
  description: 'Accumulates and displays poses from a nav_msgs::Odometry message.',
  messageTypes: ['nav_msgs/msg/Odometry'],
};

const UNLIMITED_CAP = 100_000;

export class OdometryDisplay extends MessageFilterDisplayBase<DataMessage> {
  readonly positionTolerance: FloatPropertyImpl;
  readonly angleTolerance: FloatPropertyImpl;
  readonly keep: IntPropertyImpl;
  readonly shape: PoseShapeProps;
  readonly covariance: CovariancePropertyImpl;
  private arrows: InstancedArrows | null = null;
  private axes: InstancedAxes | null = null;
  /** Kept messages, oldest first. */
  private readonly history: PoseCovMsg[] = [];
  private covs: CovarianceVisuals | null = null;
  private positions = new Float32Array(0);
  private orientations = new Float32Array(0);
  private lastUsed: PoseCovMsg | null = null;

  constructor() {
    super(ODOMETRY_INFO.classId, ODOMETRY_INFO.name, ODOMETRY_INFO.messageTypes, ODOMETRY_INFO.description);
    this.decoder = 'odometry';
    this.positionTolerance = new FloatPropertyImpl('Position Tolerance', 0.1, this, { description: 'Distance, in meters from the last arrow dropped, that will cause a new arrow to drop.', min: 0 });
    this.angleTolerance = new FloatPropertyImpl('Angle Tolerance', 0.1, this, { description: 'Angular distance from the last arrow dropped, that will cause a new arrow to drop.', min: 0 });
    this.keep = new IntPropertyImpl('Keep', 100, this, { description: 'Number of arrows to keep before removing the oldest.  0 means keep all of them.', min: 0 });
    this.shape = new PoseShapeProps(this, () => this.redraw(), { sizesUnderShape: true });
    this.covariance = new CovariancePropertyImpl(this, () => this.redraw(), () => this.updateDecoderOptions());
    this.keep.onChange(() => {
      this.trim();
      this.redraw();
    });
  }

  protected override decoderOptions() {
    return { covariance: this.covariance.workerOptions() };
  }

  protected override onInitialize() {
    this.arrows = new InstancedArrows();
    this.axes = new InstancedAxes();
    this.covs = new CovarianceVisuals();
    this.sceneNode.add(this.arrows, this.axes, this.covs);
    this.makePickable(this.sceneNode);
    this.redraw();
  }

  /** rviz messageIsSimilar: skip poses within both tolerances of the last used one. */
  private isSimilar(d: PoseCovMsg): boolean {
    const l = this.lastUsed;
    if (!l) return false;
    const dx = d.positions[0] - l.positions[0], dy = d.positions[1] - l.positions[1], dz = d.positions[2] - l.positions[2];
    // rviz: similar only when BOTH differences are strictly within tolerance.
    if (!(Math.sqrt(dx * dx + dy * dy + dz * dz) < this.positionTolerance.value())) return false;
    tmpQa.set(l.orientations[0], l.orientations[1], l.orientations[2], l.orientations[3]);
    tmpQb.set(d.orientations[0], d.orientations[1], d.orientations[2], d.orientations[3]);
    return tmpQa.angleTo(tmpQb) < this.angleTolerance.value();
  }

  processMessage(msg: DataMessage) {
    const d = msg.data as PoseCovMsg;
    if (!msg.inFixedFrame) {
      this.setStatus('error', 'Transform', msg.tfError ?? 'transform failed');
      return;
    }
    this.setStatus(msg.tfError ? 'warn' : 'ok', 'Transform', msg.tfError ?? 'Transform OK');
    if (![...d.positions, ...d.orientations].every(Number.isFinite)) {
      this.setStatus('error', 'Topic', 'Message contained invalid floating point values (nans or infs)');
      return;
    }
    const q = d.orientations;
    // odometry_display.cpp: |x²+y²+z²+w² − 1| must be < 10e-3
    if (!(Math.abs(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3] - 1) < 0.01)) {
      this.setStatus('error', 'Topic', "Message contained unnormalized quaternion (squares of values don't add to 1)");
      return;
    }
    this.setStatus('ok', 'Topic', `${this.history.length} poses kept`);
    if (this.isSimilar(d)) return;
    this.lastUsed = d;
    this.history.push(d);
    this.trim();
    this.redraw();
  }

  private trim() {
    const cap = this.keep.value() > 0 ? this.keep.value() : UNLIMITED_CAP;
    while (this.history.length > cap) this.history.shift();
  }

  private redraw() {
    if (!this.arrows || !this.axes || !this.covs) return;
    const n = this.history.length;
    if (this.positions.length < n * 3) {
      this.positions = new Float32Array(Math.max(n * 3, this.positions.length * 2, 48));
      this.orientations = new Float32Array((this.positions.length / 3) * 4);
    }
    for (let i = 0; i < n; i++) {
      this.positions.set(this.history[i].positions, i * 3);
      this.orientations.set(this.history[i].orientations, i * 4);
    }
    const s = this.shape;
    const c = s.color.value();
    this.arrows.visible = s.isArrow();
    this.axes.visible = !s.isArrow();
    this.arrows.setColor(c.r, c.g, c.b, s.alpha.value());
    this.arrows.set(n, this.positions, this.orientations, s.shaftLength.value(), s.shaftRadius.value(), s.headLength.value(), s.headRadius.value());
    this.axes.set(n, this.positions, this.orientations, s.axesLength.value(), s.axesRadius.value());
    // Covariance visuals for every kept pose, in three instanced pools.
    const style = this.covariance.style();
    this.covs.begin();
    if (style.position.enabled || style.orientation.enabled) for (let i = 0; i < n; i++) this.covs.push(this.history[i], style);
    this.covs.end();
  }

  override describeSelection(hit: PickHit): Property | null {
    if (hit.instance >= this.history.length) return null;
    const d = this.history[hit.instance];
    const g = selectionGroup(`Pose ${hit.instance} [${this.name()}]`);
    addPoseRows(g, d.positions, d.orientations, 0);
    return g;
  }
  override selectionBounds(hit: PickHit, out: THREE.Box3): boolean {
    const d = this.history[hit.instance];
    if (!d) return false;
    return boxAround(out, { x: d.positions[0], y: d.positions[1], z: d.positions[2] }, this.shape.extent());
  }

  override reset() {
    super.reset();
    this.history.length = 0;
    this.lastUsed = null;
    this.redraw();
  }

  override dispose() {
    this.arrows?.dispose();
    this.axes?.dispose();
    this.covs?.dispose();
    super.dispose();
  }
}

const tmpQa = new THREE.Quaternion();
const tmpQb = new THREE.Quaternion();
