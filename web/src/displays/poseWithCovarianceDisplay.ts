/** rviz_default_plugins/PoseWithCovariance (pose_with_covariance_display.cpp): one pose + its covariance. */

import * as THREE from 'three/webgpu';
import { MessageFilterDisplayBase } from './Display';
import type { DisplayClassInfo } from './types';
import type { DataMessage } from '../worker/messages';
import type { PoseCovMsg } from '../worker/decoders';
import { Arrow, Axes } from '../render/primitives';
import { PoseShapeProps } from '../render/poseShape';
import { CovarianceVisuals } from '../render/covarianceVisual';
import { CovariancePropertyImpl } from './covarianceProperty';
import { boxAround, roQuaternion, roString, roVector, selectionGroup, setQuaternion, setVector } from './selectionInfo';
import type { PickHit } from '../render/picking';
import type { Property } from '../property/types';

export const POSE_WITH_COVARIANCE_INFO: DisplayClassInfo = {
  classId: 'rviz_default_plugins/PoseWithCovariance',
  name: 'PoseWithCovariance',
  description: 'Displays a geometry_msgs::PoseWithCovarianceStamped message.',
  messageTypes: ['geometry_msgs/msg/PoseWithCovarianceStamped'],
};

export class PoseWithCovarianceDisplay extends MessageFilterDisplayBase<DataMessage> {
  readonly shape: PoseShapeProps;
  readonly covariance: CovariancePropertyImpl;
  private arrow: Arrow | null = null;
  private axes: Axes | null = null;
  private covs: CovarianceVisuals | null = null;
  private last: PoseCovMsg | null = null;

  constructor() {
    super(POSE_WITH_COVARIANCE_INFO.classId, POSE_WITH_COVARIANCE_INFO.name, POSE_WITH_COVARIANCE_INFO.messageTypes, POSE_WITH_COVARIANCE_INFO.description);
    this.decoder = 'pose_with_covariance';
    this.shape = new PoseShapeProps(this, () => this.redraw());
    this.covariance = new CovariancePropertyImpl(this, () => this.redraw(), () => this.updateDecoderOptions());
  }

  protected override decoderOptions() {
    return { covariance: this.covariance.workerOptions() };
  }

  protected override onInitialize() {
    this.arrow = new Arrow();
    this.axes = new Axes();
    this.covs = new CovarianceVisuals();
    this.sceneNode.add(this.arrow, this.axes, this.covs);
    this.makePickable(this.sceneNode);
    this.redraw();
  }

  private redraw() {
    if (!this.arrow || !this.axes || !this.covs) return;
    const d = this.last;
    this.shape.applyTo(this.arrow, this.axes, d !== null);
    if (d) {
      this.arrow.position.set(d.positions[0], d.positions[1], d.positions[2]);
      this.arrow.quaternion.set(d.orientations[0], d.orientations[1], d.orientations[2], d.orientations[3]);
      this.axes.position.copy(this.arrow.position);
      this.axes.quaternion.copy(this.arrow.quaternion);
      this.covs.begin();
      this.covs.push(d, this.covariance.style());
      this.covs.end();
    } else {
      this.covs.hide();
    }
  }

  processMessage(msg: DataMessage) {
    const d = msg.data as PoseCovMsg;
    if (!msg.inFixedFrame) {
      this.setStatus('error', 'Transform', msg.tfError ?? 'transform failed');
      return;
    }
    this.setStatus(msg.tfError ? 'warn' : 'ok', 'Transform', msg.tfError ?? 'Transform OK');
    if (![...d.positions, ...d.orientations].every(Number.isFinite)) {
      this.setStatus('error', 'Pose', 'Message contains invalid floating point values (nans or infs)');
      return;
    }
    if (!d.covariance.every(Number.isFinite)) {
      this.setStatus('error', 'Covariance', 'Message contains invalid covariance values (nans or infs)');
      return;
    }
    this.deleteStatus('Pose');
    this.deleteStatus('Covariance');
    this.last = d;
    this.redraw();
  }

  override describeSelection(_hit: PickHit): Property | null {
    const d = this.last;
    if (!d) return null;
    const g = selectionGroup(`Pose [${this.name()}]`);
    roVector(g, 'Position', { x: d.positions[0], y: d.positions[1], z: d.positions[2] });
    roQuaternion(g, 'Orientation', { x: d.orientations[0], y: d.orientations[1], z: d.orientations[2], w: d.orientations[3] });
    for (let r = 0; r < 6; r++) roString(g, `Covariance ${r}`, Array.from(d.covariance.subarray(r * 6, r * 6 + 6), (v) => v.toPrecision(4)).join('; '));
    return g;
  }
  override updateSelection(_hit: PickHit, prop: Property) {
    const d = this.last;
    if (!d) return;
    setVector(prop.child('Position'), { x: d.positions[0], y: d.positions[1], z: d.positions[2] });
    setQuaternion(prop.child('Orientation'), { x: d.orientations[0], y: d.orientations[1], z: d.orientations[2], w: d.orientations[3] });
  }
  override selectionBounds(_hit: PickHit, out: THREE.Box3): boolean {
    const d = this.last;
    if (!d) return false;
    return boxAround(out, { x: d.positions[0], y: d.positions[1], z: d.positions[2] }, this.shape.extent());
  }

  override reset() {
    super.reset();
    this.last = null;
    this.redraw();
  }

  override dispose() {
    this.arrow?.dispose();
    this.axes?.dispose();
    this.covs?.dispose();
    super.dispose();
  }
}
