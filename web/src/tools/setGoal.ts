/** rviz_default_plugins/SetGoal ("2D Goal Pose"): publishes PoseStamped. */

import { RosTopicPropertyImpl } from '../property/Property';
import { PoseToolBase } from './poseTool';
import { stampFromNs, type ToolClassInfo } from './types';

export const SET_GOAL_INFO: ToolClassInfo = {
  classId: 'rviz_default_plugins/SetGoal',
  name: '2D Goal Pose',
  description: 'Set a goal pose for the robot (publishes geometry_msgs/PoseStamped).',
  shortcut: 'g',
};

const MSG_TYPE = 'geometry_msgs/msg/PoseStamped';

export class SetGoalTool extends PoseToolBase {
  readonly topic: RosTopicPropertyImpl;

  constructor() {
    super(SET_GOAL_INFO.classId, SET_GOAL_INFO.shortcut, SET_GOAL_INFO.name);
    // goal_tool.cpp: the default topic has no leading slash.
    this.topic = new RosTopicPropertyImpl('Topic', 'goal_pose', [MSG_TYPE], this.properties, { description: 'The topic on which to publish goals.' });
  }

  protected override onPoseSet(x: number, y: number, yaw: number) {
    if (!this.ctx) return;
    const msg = {
      header: { stamp: stampFromNs(this.ctx.rosTimeNs()), frame_id: this.ctx.fixedFrame() },
      pose: { position: { x, y, z: 0 }, orientation: this.yawQuaternion(yaw) },
    };
    this.ctx.bridge.publish(this.topic.value(), MSG_TYPE, this.topic.qos(), msg);
    console.info(`[${this.name()}] published to ${this.topic.value()}: x=${x.toFixed(3)} y=${y.toFixed(3)} yaw=${yaw.toFixed(3)} frame=${this.ctx.fixedFrame()}`);
  }
}
