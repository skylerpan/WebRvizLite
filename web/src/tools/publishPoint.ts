/** rviz_default_plugins/PublishPoint (point_tool.cpp): click a surface point, publish it as PointStamped. */

import { BoolPropertyImpl, RosTopicPropertyImpl } from '../property/Property';
import { ToolBase } from './Tool';
import { stampFromNs, type ToolClassInfo } from './types';
import type { ViewportPointerEvent } from '../views/types';

export const PUBLISH_POINT_INFO: ToolClassInfo = {
  classId: 'rviz_default_plugins/PublishPoint',
  name: 'Publish Point',
  description: 'Publish a point on a surface as a geometry_msgs/PointStamped.',
  shortcut: 'u',
};

const MSG_TYPE = 'geometry_msgs/msg/PointStamped';

export class PublishPointTool extends ToolBase {
  readonly topic: RosTopicPropertyImpl;
  readonly singleClick: BoolPropertyImpl;
  private downX = 0;
  private downY = 0;

  constructor() {
    super(PUBLISH_POINT_INFO.classId, PUBLISH_POINT_INFO.shortcut);
    this.topic = new RosTopicPropertyImpl('Topic', '/clicked_point', [MSG_TYPE], this.properties, { description: 'The topic on which to publish points.' });
    this.singleClick = new BoolPropertyImpl('Single click', true, this.properties, { description: 'Switch away from this tool after one click.' });
  }

  override activate() {
    const vp = this.ctx?.viewport();
    vp?.setCursor('crosshair');
    vp?.setStatus('Click on a point in the scene to publish it.');
  }

  override deactivate() {
    const vp = this.ctx?.viewport();
    vp?.setCursor('default');
    vp?.setStatus('');
  }

  override handleMouse(e: ViewportPointerEvent) {
    const ctx = this.ctx;
    const vp = ctx?.viewport();
    if (!ctx || !vp) return;
    if (e.type === 'down') {
      this.downX = e.x;
      this.downY = e.y;
      return;
    }
    if (e.type === 'up' && e.button === 0) {
      if (Math.abs(e.x - this.downX) > 3 || Math.abs(e.y - this.downY) > 3) return;
      void vp.pickPoint(e.x, e.y).then((hit) => {
        if (!hit) {
          vp.setStatus('No surface under the cursor; nothing published.');
          return;
        }
        const p = hit.worldPos;
        const msg = { header: { stamp: stampFromNs(ctx.rosTimeNs()), frame_id: ctx.fixedFrame() }, point: { x: p.x, y: p.y, z: p.z } };
        ctx.bridge.publish(this.topic.value(), MSG_TYPE, this.topic.qos(), msg);
        vp.setStatus(`Published point: ${p.x.toFixed(3)} ${p.y.toFixed(3)} ${p.z.toFixed(3)} [frame=${ctx.fixedFrame()}]`);
        if (this.singleClick.value()) ctx.revertToDefault();
      });
      return;
    }
    if (e.type === 'wheel' || (e.type === 'move' && e.buttons)) ctx.views.current().handleMouse(e);
  }
}
