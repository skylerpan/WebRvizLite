/**
 * webrvizlite/LivoxCustomMsg: livox_ros_driver2/msg/CustomMsg (the Livox driver's
 * native format, `xfer_format: 1`) drawn through the shared point cloud pipeline.
 * RViz has no plugin for this type, so the class id is outside
 * rviz_default_plugins; rviz ignores it when it loads a saved config.
 * Properties are the PointCloud2 set. `reflectivity` arrives as the `intensity`
 * channel; `tag`, `line` and `offset_time` are selectable Channel Names.
 */

import { MessageFilterDisplayBase } from './Display';
import { PointCloudCommon, type CloudHost } from './pointCloudCommon';
import type { DisplayClassInfo } from './types';
import type { DataMessage } from '../worker/messages';
import type { PointCloudMsg } from '../worker/decoders';

export const LIVOX_INFO: DisplayClassInfo = {
  classId: 'webrvizlite/LivoxCustomMsg',
  name: 'LivoxCustomMsg',
  description: 'Displays a livox_ros_driver2::msg::CustomMsg point cloud (Livox native format) as points, billboards, or boxes. Reflectivity is available as the intensity channel.',
  messageTypes: ['livox_ros_driver2/msg/CustomMsg'],
};

export class LivoxDisplay extends MessageFilterDisplayBase<DataMessage> implements CloudHost {
  readonly cloud: PointCloudCommon;

  constructor() {
    super(LIVOX_INFO.classId, LIVOX_INFO.name, LIVOX_INFO.messageTypes, LIVOX_INFO.description);
    this.decoder = 'livox_custom_msg';
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
