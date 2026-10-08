/**
 * Shared point cloud behaviour (rviz PointCloudCommon): the style / size /
 * alpha / decay properties, the Position and Color Transformer properties with
 * their sub-properties, and the decay-time ring of GPU buffers. Used by
 * PointCloud2, LaserScan and (Tier 1/2) DepthCloud and the single-point displays.
 */

import { BoolPropertyImpl, ColorPropertyImpl, EnumPropertyImpl, FloatPropertyImpl, type PropertyBase } from '../property/Property';
import type { Display } from './types';
import type { DataMessage } from '../worker/messages';
import type { PointCloudMsg } from '../worker/decoders';
import type * as THREE from 'three/webgpu';
import { CloudBuffer, CloudObject, type PointStyle } from '../render/pointCloud';
import { boxAround, roString, roVector, selectionGroup } from './selectionInfo';
import type { PickHit } from '../render/picking';
import type { Property } from '../property/types';

const STYLES: PointStyle[] = ['Points', 'Squares', 'Flat Squares', 'Spheres', 'Boxes', 'Tiles'];
const ALL_TRANSFORMERS = ['FlatColor', 'AxisColor', 'Intensity', 'RGB8', 'RGBF32'];

export interface CloudHost extends Display {
  /** Push new decoder options to the worker. */
  pushDecoderOptions(): void;
  /** Channel values of point `index` of the latest message (worker re-decode), or null when unavailable. */
  describePoint(index: number): Promise<{ names: string[]; values: number[] } | null>;
}

export class PointCloudCommon {
  readonly selectable: BoolPropertyImpl;
  readonly style: EnumPropertyImpl;
  readonly sizeMeters: FloatPropertyImpl;
  readonly sizePixels: FloatPropertyImpl;
  readonly alpha: FloatPropertyImpl;
  readonly decayTime: FloatPropertyImpl;
  readonly positionTransformer: EnumPropertyImpl;
  readonly colorTransformer: EnumPropertyImpl;
  // FlatColor
  readonly flatColor: ColorPropertyImpl;
  // AxisColor
  readonly axis: EnumPropertyImpl;
  readonly axisAutocompute: BoolPropertyImpl;
  readonly axisMin: FloatPropertyImpl;
  readonly axisMax: FloatPropertyImpl;
  readonly axisUseFixedFrame: BoolPropertyImpl;
  // Intensity
  readonly channelName: EnumPropertyImpl;
  readonly useRainbow: BoolPropertyImpl;
  readonly invertRainbow: BoolPropertyImpl;
  readonly minColor: ColorPropertyImpl;
  readonly maxColor: ColorPropertyImpl;
  readonly intensityAutocompute: BoolPropertyImpl;
  readonly minIntensity: FloatPropertyImpl;
  readonly maxIntensity: FloatPropertyImpl;

  private readonly clouds: { buffer: CloudBuffer; object: CloudObject; stampMs: number }[] = [];
  private pool: { buffer: CloudBuffer; object: CloudObject }[] = [];
  private totalPoints = 0;

  constructor(private readonly host: CloudHost, parent: PropertyBase<boolean>) {
    this.selectable = new BoolPropertyImpl('Selectable', true, parent, { description: 'Whether or not the points in this point cloud are selectable.' });
    this.style = new EnumPropertyImpl('Style', 'Flat Squares', STYLES, parent, { description: 'Rendering mode to use, in order of computational complexity.' });
    this.sizeMeters = new FloatPropertyImpl('Size (m)', 0.01, parent, { description: 'Point size in meters.', min: 0 });
    this.sizePixels = new FloatPropertyImpl('Size (Pixels)', 3, parent, { description: 'Point size in pixels.', min: 1, hidden: true });
    this.alpha = new FloatPropertyImpl('Alpha', 1, parent, { description: 'Amount of transparency to apply to the points.  Note that this is experimental and does not always look correct.', min: 0, max: 1 });
    this.decayTime = new FloatPropertyImpl('Decay Time', 0, parent, { description: 'Duration, in seconds, to keep the incoming points.  0 means only show the latest points.', min: 0 });
    this.positionTransformer = new EnumPropertyImpl('Position Transformer', 'XYZ', ['XYZ'], parent, { description: 'Set the transformer to use to set the position of the points.' });
    this.colorTransformer = new EnumPropertyImpl('Color Transformer', '', ALL_TRANSFORMERS, parent, { description: 'Set the transformer to use to set the color of the points.' });

    this.flatColor = new ColorPropertyImpl('Color', { r: 255, g: 255, b: 255 }, parent, { description: 'Color to assign to every point.', hidden: true });
    this.axis = new EnumPropertyImpl('Axis', 'Z', ['X', 'Y', 'Z'], parent, { description: 'The axis to interpolate the color along.', hidden: true });
    this.axisAutocompute = new BoolPropertyImpl('Autocompute Value Bounds', true, parent, { description: 'Whether to automatically compute the value min/max values.', hidden: true });
    this.axisMin = new FloatPropertyImpl('Min Value', -10, parent, { description: 'Minimum value value, used to interpolate the color of a point.', hidden: true });
    this.axisMax = new FloatPropertyImpl('Max Value', 10, parent, { description: 'Maximum value value, used to interpolate the color of a point.', hidden: true });
    this.axisUseFixedFrame = new BoolPropertyImpl('Use Fixed Frame', true, parent, { description: 'Whether to color the points based on their location in the fixed frame or the local frame of the message.', hidden: true });
    this.channelName = new EnumPropertyImpl('Channel Name', 'intensity', ['intensity'], parent, { description: 'Select the channel to use to compute the intensity', hidden: true, editable: true });
    this.useRainbow = new BoolPropertyImpl('Use rainbow', true, parent, { description: 'Whether to use a rainbow of colors or interpolate between two.', hidden: true });
    this.invertRainbow = new BoolPropertyImpl('Invert Rainbow', false, parent, { description: 'Whether to invert rainbow colors', hidden: true });
    this.minColor = new ColorPropertyImpl('Min Color', { r: 0, g: 0, b: 0 }, parent, { description: 'Color to assign the points with the minimum intensity.  Actual color is interpolated between this and Max Color.', hidden: true });
    this.maxColor = new ColorPropertyImpl('Max Color', { r: 255, g: 255, b: 255 }, parent, { description: 'Color to assign the points with the maximum intensity.  Actual color is interpolated between this and Max Color.', hidden: true });
    this.intensityAutocompute = new BoolPropertyImpl('Autocompute Intensity Bounds', true, parent, { description: 'Whether to automatically compute the intensity min/max values.', hidden: true });
    this.minIntensity = new FloatPropertyImpl('Min Intensity', 0, parent, { description: 'Minimum possible intensity value, used to interpolate from Min Color to Max Color for a point.', hidden: true });
    this.maxIntensity = new FloatPropertyImpl('Max Intensity', 4096, parent, { description: 'Maximum possible intensity value, used to interpolate from Min Color to Max Color for a point.', hidden: true });

    this.selectable.onChange((on) => {
      for (const c of [...this.clouds, ...this.pool]) if (on) host.makePickable(c.object); else host.releasePickable(c.object);
    });
    this.style.onChange(() => this.updateStyle());
    this.sizeMeters.onChange(() => this.updateStyle());
    this.sizePixels.onChange(() => this.updateStyle());
    this.alpha.onChange(() => this.updateStyle());
    this.colorTransformer.onChange(() => {
      this.updateTransformerVisibility();
      host.pushDecoderOptions();
    });
    for (const p of [this.flatColor, this.axis, this.axisAutocompute, this.axisMin, this.axisMax, this.axisUseFixedFrame, this.channelName, this.useRainbow, this.invertRainbow, this.minColor, this.maxColor, this.intensityAutocompute, this.minIntensity, this.maxIntensity]) {
      p.onChange(() => {
        this.updateTransformerVisibility();
        host.pushDecoderOptions();
      });
    }
    this.updateStyle();
    this.updateTransformerVisibility();
  }

  /** Decoder options for the worker (`ColorOptions` in core). */
  colorOptions(): Record<string, unknown> {
    const c = (p: ColorPropertyImpl) => [p.value().r, p.value().g, p.value().b];
    return {
      transformer: this.colorTransformer.value(),
      flat_color: c(this.flatColor),
      axis: ['X', 'Y', 'Z'].indexOf(this.axis.value()),
      axis_autocompute: this.axisAutocompute.value(),
      axis_min: this.axisMin.value(),
      axis_max: this.axisMax.value(),
      axis_use_fixed_frame: this.axisUseFixedFrame.value(),
      channel: this.channelName.value(),
      use_rainbow: this.useRainbow.value(),
      invert_rainbow: this.invertRainbow.value(),
      min_color: c(this.minColor),
      max_color: c(this.maxColor),
      intensity_autocompute: this.intensityAutocompute.value(),
      min_intensity: this.minIntensity.value(),
      max_intensity: this.maxIntensity.value(),
    };
  }

  private updateTransformerVisibility() {
    const t = this.colorTransformer.value();
    this.flatColor.setHidden(t !== 'FlatColor');
    const axis = t === 'AxisColor';
    this.axis.setHidden(!axis);
    this.axisAutocompute.setHidden(!axis);
    this.axisMin.setHidden(!axis || this.axisAutocompute.value());
    this.axisMax.setHidden(!axis || this.axisAutocompute.value());
    this.axisUseFixedFrame.setHidden(!axis);
    const intensity = t === 'Intensity';
    this.channelName.setHidden(!intensity);
    this.useRainbow.setHidden(!intensity);
    this.invertRainbow.setHidden(!intensity || !this.useRainbow.value());
    this.minColor.setHidden(!intensity || this.useRainbow.value());
    this.maxColor.setHidden(!intensity || this.useRainbow.value());
    this.intensityAutocompute.setHidden(!intensity);
    this.minIntensity.setHidden(!intensity || this.intensityAutocompute.value());
    this.maxIntensity.setHidden(!intensity || this.intensityAutocompute.value());
  }

  private updateStyle() {
    const style = this.style.value() as PointStyle;
    this.sizePixels.setHidden(style !== 'Points');
    this.sizeMeters.setHidden(style === 'Points');
    for (const c of this.clouds) c.object.setStyle(style, this.sizeMeters.value(), this.sizePixels.value(), this.alpha.value());
  }

  /** Handles a decoded cloud: appends it to the decay ring and uploads it. */
  addCloud(msg: DataMessage, nowMs: number) {
    const d = msg.data as PointCloudMsg;
    // Only list the transformers this cloud supports (rviz: supports()).
    const options = d.transformers.length ? d.transformers : ALL_TRANSFORMERS;
    if (options.join() !== this.colorTransformer.options().join()) this.colorTransformer.setOptions(options);
    if (this.colorTransformer.value() !== d.transformer && !options.includes(this.colorTransformer.value())) {
      this.colorTransformer.setValue(d.transformer, 'program');
    }
    if (d.channels.length && d.channels.join() !== this.channelName.options().join()) this.channelName.setOptions(d.channels);

    const decayMs = this.decayTime.value() * 1000;
    let slot: { buffer: CloudBuffer; object: CloudObject; stampMs: number };
    if (decayMs <= 0 && this.clouds.length > 0) {
      slot = this.clouds[0];
      // drop everything but one
      while (this.clouds.length > 1) this.release(this.clouds.pop()!);
    } else {
      const reused = this.pool.pop();
      slot = reused ? { ...reused, stampMs: nowMs } : this.makeSlot(nowMs);
      this.clouds.push(slot);
    }
    slot.stampMs = nowMs;
    const realloc = slot.buffer.set(d.count, d.positions, d.colors);
    slot.object.setStyle(this.style.value() as PointStyle, this.sizeMeters.value(), this.sizePixels.value(), this.alpha.value());
    slot.object.refresh(realloc);
    slot.object.visible = true;
    this.totalPoints = this.clouds.reduce((n, c) => n + c.buffer.count, 0);
  }

  private makeSlot(nowMs: number) {
    const buffer = new CloudBuffer();
    const object = new CloudObject(buffer);
    this.host.sceneNode.add(object);
    if (this.selectable.value()) this.host.makePickable(object);
    return { buffer, object, stampMs: nowMs };
  }

  private release(slot: { buffer: CloudBuffer; object: CloudObject }) {
    slot.object.visible = false;
    this.pool.push(slot);
  }

  /** Drops clouds older than Decay Time. */
  update(nowMs: number) {
    const decayMs = this.decayTime.value() * 1000;
    if (decayMs <= 0 || this.clouds.length <= 1) return;
    while (this.clouds.length > 1 && nowMs - this.clouds[0].stampMs > decayMs) this.release(this.clouds.shift()!);
    this.totalPoints = this.clouds.reduce((n, c) => n + c.buffer.count, 0);
  }

  pointCount(): number {
    return this.totalPoints;
  }

  /** Selection panel rows for a picked point: position / colour now, channels once the worker answers. */
  describeSelection(hit: PickHit): Property | null {
    const slot = this.clouds.find((c) => c.object === hit.object);
    if (!slot || hit.instance >= slot.buffer.count) return null;
    const i = hit.instance;
    const p = slot.buffer.positions.array as Float32Array;
    const c = slot.buffer.colors.array as Uint8Array;
    const g = selectionGroup(`Point ${i} [${this.host.name()}]`);
    roVector(g, 'Position', { x: p[i * 3], y: p[i * 3 + 1], z: p[i * 3 + 2] }, 'Position in the fixed frame.');
    roString(g, 'Color', `${c[i * 3]}; ${c[i * 3 + 1]}; ${c[i * 3 + 2]}`);
    const latest = this.clouds.reduce((a, b) => (b.stampMs >= a.stampMs ? b : a), this.clouds[0]);
    if (slot === latest) {
      void this.host.describePoint(i).then((info) => {
        if (!info) return;
        for (let k = 0; k < info.names.length; k++) {
          const v = info.values[k];
          roString(g, info.names[k], Number.isInteger(v) ? String(v) : v.toFixed(4), 'Value of this channel in the message (sensor frame).');
        }
      });
    }
    return g;
  }
  selectionBounds(hit: PickHit, out: THREE.Box3): boolean {
    const slot = this.clouds.find((c) => c.object === hit.object);
    if (!slot || hit.instance >= slot.buffer.count) return false;
    const i = hit.instance;
    const p = slot.buffer.positions.array as Float32Array;
    const size = this.style.value() === 'Points' ? 0.05 : Math.max(0.02, this.sizeMeters.value() * 2);
    return boxAround(out, { x: p[i * 3], y: p[i * 3 + 1], z: p[i * 3 + 2] }, size);
  }

  reset() {
    while (this.clouds.length) this.release(this.clouds.pop()!);
    this.totalPoints = 0;
  }

  dispose() {
    for (const c of [...this.clouds, ...this.pool]) c.object.dispose();
    this.clouds.length = 0;
    this.pool = [];
  }
}
