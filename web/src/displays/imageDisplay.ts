/** rviz_default_plugins/Image (image_display.cpp): shows a sensor_msgs/Image in its own panel. */

import { RosTopicDisplayBase } from './Display';
import { BoolPropertyImpl, FloatPropertyImpl, IntPropertyImpl } from '../property/Property';
import type { DisplayClassInfo } from './types';
import type { DataMessage } from '../worker/messages';
import type { ImageMsg } from '../worker/decoders';
import { ImagePanel } from '../panels/ImagePanel';

export const IMAGE_INFO: DisplayClassInfo = {
  classId: 'rviz_default_plugins/Image',
  name: 'Image',
  description: 'Displays an image from a sensor_msgs::Image message.',
  messageTypes: ['sensor_msgs/msg/Image'],
};

let nextPanelId = 1;

export class ImageDisplay extends RosTopicDisplayBase<DataMessage> {
  readonly normalizeRange: BoolPropertyImpl;
  readonly minValue: FloatPropertyImpl;
  readonly maxValue: FloatPropertyImpl;
  readonly medianWindow: IntPropertyImpl;
  readonly panelId = `image:${nextPanelId++}`;
  private panelOpen = false;

  constructor() {
    super(IMAGE_INFO.classId, IMAGE_INFO.name, IMAGE_INFO.messageTypes, IMAGE_INFO.description, { depth: 5 });
    this.decoder = 'image';
    this.normalizeRange = new BoolPropertyImpl('Normalize Range', true, this, { description: 'If set to true, will try to estimate the range of possible values from the received images.' });
    this.minValue = new FloatPropertyImpl('Min Value', 0, this, { description: 'Value which will be displayed as black.', hidden: true });
    this.maxValue = new FloatPropertyImpl('Max Value', 1, this, { description: 'Value which will be displayed as white.', hidden: true });
    this.medianWindow = new IntPropertyImpl('Median window', 5, this, { description: 'Window size for median filter used for computin min/max.', min: 1 });
    this.normalizeRange.onChange((on) => {
      this.minValue.setHidden(on);
      this.maxValue.setHidden(on);
      this.updateDecoderOptions();
    });
    for (const p of [this.minValue, this.maxValue, this.medianWindow]) p.onChange(() => this.updateDecoderOptions());
    ImagePanel.closeHandlers.set(this.panelId, (byUser) => this.onPanelClosed(byUser));
  }

  /** rviz: closing the image panel disables the display; a layout rebuild just reopens it later. */
  private onPanelClosed(byUser: boolean) {
    this.panelOpen = false;
    if (byUser && this.enabled()) this.setEnabled(false);
  }

  protected override decoderOptions() {
    return { image: { normalize: this.normalizeRange.value(), min: this.minValue.value(), max: this.maxValue.value(), median_window: this.medianWindow.value() } };
  }

  private ensurePanel() {
    const host = this.context?.panels();
    if (!host || this.panelOpen) return;
    host.openDisplayPanel(this.panelId, 'image', this.name(), { width: 480, height: 360 });
    this.panelOpen = true;
  }

  override onEnable() {
    super.onEnable();
    this.ensurePanel();
  }

  override onDisable() {
    super.onDisable();
    if (this.panelOpen) {
      this.panelOpen = false;
      this.context?.panels()?.closePanel(this.panelId);
    }
  }

  override update() {
    // The layout may mount after the config loaded: open the panel once it exists.
    if (!this.panelOpen) this.ensurePanel();
  }

  override setName(name: string) {
    super.setName(name);
    if (this.panelOpen) this.context?.panels()?.setPanelTitle(this.panelId, name);
  }

  processMessage(msg: DataMessage) {
    const d = msg.data as ImageMsg;
    this.setStatus('ok', 'Image', `${d.width} x ${d.height} ${d.encoding}`);
    ImagePanel.draw(this.panelId, d);
  }

  override dispose() {
    ImagePanel.closeHandlers.delete(this.panelId);
    if (this.panelOpen) {
      this.panelOpen = false;
      this.context?.panels()?.closePanel(this.panelId);
    }
    super.dispose();
  }
}
