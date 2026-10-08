/** rviz_default_plugins/MoveCamera: hands every mouse event to the current ViewController. */

import { ToolBase } from './Tool';
import type { ToolClassInfo } from './types';
import type { ViewportPointerEvent } from '../views/types';

export const MOVE_CAMERA_INFO: ToolClassInfo = {
  classId: 'rviz_default_plugins/MoveCamera',
  name: 'Move Camera',
  description: 'Drag the mouse with left, middle, or right buttons to change your viewpoint.',
  shortcut: 'm',
};

export class MoveCameraTool extends ToolBase {
  constructor() {
    super(MOVE_CAMERA_INFO.classId, MOVE_CAMERA_INFO.shortcut);
  }
  override handleMouse(e: ViewportPointerEvent) {
    this.ctx?.views.current().handleMouse(e);
  }
}
