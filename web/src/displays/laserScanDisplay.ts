/** rviz_default_plugins/LaserScan (laser_scan_display.cpp): projected to points in the worker. */

import { MessageFilterDisplayBase } from './Display';
import { PointCloudCommon, type CloudHost } from './pointCloudCommon';
import type { DisplayClassInfo } from './types';
import type { DataMessage } from '../worker/messages';
import type { PointCloudMsg } from '../worker/decoders';

export const LASER_SCAN_INFO: DisplayClassInfo = {
  classId: 'rviz_default_plugins/LaserScan',
  name: 'LaserScan',
  description: 'Displays the data from a sensor_msgs::LaserScan message as points in the world, drawn as points, billboards, or boxes.',
  messageTypes: ['sensor_msgs/msg/LaserScan'],
};

export class LaserScanDisplay extends MessageFilterDisplayBase<DataMessage> implements CloudHost {
  readonly cloud: PointCloudCommon;

  constructor() {
    super(LASER_SCAN_INFO.classId, LASER_SCAN_INFO.name, LASER_SCAN_INFO.messageTypes, LASER_SCAN_INFO.description);
    this.decoder = 'laser_scan';
    this.cloud = new PointCloudCommon(this, this);
  }

  protected override decoderOptions() {
    return { color: this.cloud.colorOptions() };
  }

  pushDecoderOptions() {
    this.updateDecoderOptions();
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
