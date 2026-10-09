/** rviz_default_plugins/PointCloud2 (point_cloud2_display.cpp). */

import { MessageFilterDisplayBase } from './Display';
import type { PickHit } from '../render/picking';
import type * as THREE from 'three/webgpu';
import { PointCloudCommon, type CloudHost } from './pointCloudCommon';
import type { DisplayClassInfo } from './types';
import type { DataMessage } from '../worker/messages';
import type { PointCloudMsg } from '../worker/decoders';

export const POINT_CLOUD2_INFO: DisplayClassInfo = {
  classId: 'rviz_default_plugins/PointCloud2',
  name: 'PointCloud2',
  description: 'Displays a point cloud from a sensor_msgs::PointCloud2 message as points in the world, drawn as points, billboards, or boxes.',
  messageTypes: ['sensor_msgs/msg/PointCloud2'],
};

export class PointCloud2Display extends MessageFilterDisplayBase<DataMessage> implements CloudHost {
  readonly cloud: PointCloudCommon;

  constructor() {
    super(POINT_CLOUD2_INFO.classId, POINT_CLOUD2_INFO.name, POINT_CLOUD2_INFO.messageTypes, POINT_CLOUD2_INFO.description);
    this.decoder = 'point_cloud2';
    this.cloud = new PointCloudCommon(this, this);
  }

  protected override decoderOptions() {
    return { color: this.cloud.colorOptions(), selectable: this.cloud.selectable.value() };
  }

  pushDecoderOptions() {
    this.updateDecoderOptions();
  }

  /** With Decay Time 0 only the newest cloud is shown, so intermediate clouds may be skipped. */
  protected override latestOnly() {
    return this.cloud.decayTime.value() === 0;
  }

  describePoint(index: number) {
    if (this.subscriptionId === null || !this.context) return Promise.resolve(null);
    return this.context.bridge.describePoint(this.subscriptionId, index);
  }
  override describeSelection(hit: PickHit) {
    return this.cloud.describeSelection(hit);
  }
  override selectionBounds(hit: PickHit, out: THREE.Box3) {
    return this.cloud.selectionBounds(hit, out);
  }


  processMessage(msg: DataMessage) {
    const d = msg.data as PointCloudMsg;
    if (!msg.inFixedFrame) {
      this.setStatus('error', 'Transform', msg.tfError ?? 'transform failed');
      return;
    }
    this.setStatus(msg.tfError ? 'warn' : 'ok', 'Transform', msg.tfError ?? 'Transform OK');
    this.cloud.addCloud(msg, performance.now());
    this.setStatus('ok', 'Points', `Showing [${this.cloud.pointCount()}] points from [${d.count}] in the message`);
  }

  override update() {
    this.cloud.update(performance.now());
  }

  override reset() {
    super.reset();
    this.cloud.reset();
  }

  override dispose() {
    this.cloud.dispose();
    super.dispose();
  }
}
