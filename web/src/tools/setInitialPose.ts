/** rviz_default_plugins/SetInitialPose ("2D Pose Estimate"): publishes PoseWithCovarianceStamped. */

import { FloatPropertyImpl, RosTopicPropertyImpl } from '../property/Property';
import { PoseToolBase } from './poseTool';
import { stampFromNs, type ToolClassInfo } from './types';

export const SET_INITIAL_POSE_INFO: ToolClassInfo = {
  classId: 'rviz_default_plugins/SetInitialPose',
  name: '2D Pose Estimate',
  description: 'Set the initial pose of the robot (publishes geometry_msgs/PoseWithCovarianceStamped).',
  shortcut: 'p',
};

const MSG_TYPE = 'geometry_msgs/msg/PoseWithCovarianceStamped';

export class SetInitialPoseTool extends PoseToolBase {
  readonly topic: RosTopicPropertyImpl;
  readonly covX: FloatPropertyImpl;
  readonly covY: FloatPropertyImpl;
  readonly covYaw: FloatPropertyImpl;

  constructor() {
    super(SET_INITIAL_POSE_INFO.classId, SET_INITIAL_POSE_INFO.shortcut, SET_INITIAL_POSE_INFO.name);
    // initial_pose_tool.cpp: the default topic has no leading slash.
    this.topic = new RosTopicPropertyImpl('Topic', 'initialpose', [MSG_TYPE], this.properties, { description: 'The topic on which to publish initial pose estimates.' });
    this.covX = new FloatPropertyImpl('Covariance x', 0.5 * 0.5, this.properties, { description: 'Covariance on the x-axis.', min: 0 });
    this.covY = new FloatPropertyImpl('Covariance y', 0.5 * 0.5, this.properties, { description: 'Covariance on the y-axis.', min: 0 });
    this.covYaw = new FloatPropertyImpl('Covariance yaw', (Math.PI / 12) * (Math.PI / 12), this.properties, { description: 'Covariance on the yaw-axis.', min: 0 });
  }

  protected override onPoseSet(x: number, y: number, yaw: number) {
    if (!this.ctx) return;
    const covariance = new Array<number>(36).fill(0);
    covariance[0] = this.covX.value();
    covariance[7] = this.covY.value();
    covariance[35] = this.covYaw.value();
    const msg = {
      header: { stamp: stampFromNs(this.ctx.rosTimeNs()), frame_id: this.ctx.fixedFrame() },
      pose: { pose: { position: { x, y, z: 0 }, orientation: this.yawQuaternion(yaw) }, covariance },
    };
    this.ctx.bridge.publish(this.topic.value(), MSG_TYPE, this.topic.qos(), msg);
    this.ctx.viewport()?.setStatus(`Setting pose: ${x.toFixed(3)} ${y.toFixed(3)} ${yaw.toFixed(3)} [frame=${this.ctx.fixedFrame()}]`);
  }
}
