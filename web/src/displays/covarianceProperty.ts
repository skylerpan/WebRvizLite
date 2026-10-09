/**
 * rviz_default_plugins CovarianceProperty: the "Covariance" group shared by
 * PoseWithCovariance and Odometry (spec §6.6). Saved as
 * `Covariance: {Value, Position: {Value, Color, Alpha, Scale}, Orientation: {...}}`.
 */

import { BoolPropertyImpl, ColorPropertyImpl, EnumPropertyImpl, FloatPropertyImpl } from '../property/Property';
import type { Property } from '../property/types';
import type { CovarianceStyle } from '../render/covarianceVisual';

export class CovariancePropertyImpl extends BoolPropertyImpl {
  readonly position: BoolPropertyImpl;
  readonly positionColor: ColorPropertyImpl;
  readonly positionAlpha: FloatPropertyImpl;
  readonly positionScale: FloatPropertyImpl;
  readonly orientation: BoolPropertyImpl;
  readonly orientationFrame: EnumPropertyImpl;
  readonly orientationColorStyle: EnumPropertyImpl;
  readonly orientationColor: ColorPropertyImpl;
  readonly orientationAlpha: FloatPropertyImpl;
  readonly orientationOffset: FloatPropertyImpl;
  readonly orientationScale: FloatPropertyImpl;

  constructor(parent: Property, onStyleChange: () => void, onWorkerChange: () => void) {
    super('Covariance', true, parent, { description: 'Whether or not the covariances of the messages should be shown.' });
    this.position = new BoolPropertyImpl('Position', true, this, { description: 'Whether or not to show the position part of covariances' });
    this.positionColor = new ColorPropertyImpl('Color', { r: 204, g: 51, b: 204 }, this.position, { description: 'Color to draw the position covariance ellipse.' });
    this.positionAlpha = new FloatPropertyImpl('Alpha', 0.3, this.position, { description: '0 is fully transparent, 1.0 is fully opaque.', min: 0, max: 1 });
    this.positionScale = new FloatPropertyImpl('Scale', 1, this.position, { description: 'Scale factor to be applied to covariance ellipse. Corresponds to the number of standard deviations to display', min: 0 });
    this.orientation = new BoolPropertyImpl('Orientation', true, this, { description: 'Whether or not to show the orientation part of covariances' });
    this.orientationFrame = new EnumPropertyImpl('Frame', 'Local', ['Local', 'Fixed'], this.orientation, { description: 'Frame used to display the orientation covariance.' });
    this.orientationColorStyle = new EnumPropertyImpl('Color Style', 'Unique', ['Unique', 'RGB'], this.orientation, { description: 'Style to color the orientation covariance: XYZ with same unique color or following RGB order' });
    this.orientationColor = new ColorPropertyImpl('Color', { r: 255, g: 255, b: 127 }, this.orientation, { description: 'Color to draw the covariance ellipse.' });
    this.orientationAlpha = new FloatPropertyImpl('Alpha', 0.5, this.orientation, { description: '0 is fully transparent, 1.0 is fully opaque.', min: 0, max: 1 });
    this.orientationOffset = new FloatPropertyImpl('Offset', 1, this.orientation, { description: 'For 3D poses: the distance where to position the ellipses representing orientation covariance. For 2D poses: the height of the triangle representing the variance on yaw', min: 0 });
    this.orientationScale = new FloatPropertyImpl('Scale', 1, this.orientation, { description: 'Scale factor to be applied to orientation covariance shapes. Corresponds to the number of standard deviations to display', min: 0 });

    this.orientationColorStyle.onChange((v) => {
      this.orientationColor.setHidden(v === 'RGB');
      onStyleChange();
    });
    for (const p of [this, this.position, this.positionColor, this.positionAlpha, this.orientation, this.orientationFrame, this.orientationColor, this.orientationAlpha, this.orientationOffset]) {
      p.onChange(onStyleChange);
    }
    // Scales (and the offset, which sizes the discs) change what the worker computes.
    for (const p of [this.positionScale, this.orientationScale, this.orientationOffset]) p.onChange(onWorkerChange);
  }

  /** Decoder options for the worker's covariance maths. */
  workerOptions(): Record<string, number> {
    return { pos_scale: this.positionScale.value(), ori_scale: this.orientationScale.value(), ori_offset: this.orientationOffset.value() };
  }

  style(): CovarianceStyle {
    const enabled = this.value();
    return {
      position: { enabled: enabled && this.position.value(), color: this.positionColor.value(), alpha: this.positionAlpha.value() },
      orientation: {
        enabled: enabled && this.orientation.value(),
        frame: this.orientationFrame.value() as 'Local' | 'Fixed',
        colorStyle: this.orientationColorStyle.value() as 'Unique' | 'RGB',
        color: this.orientationColor.value(),
        alpha: this.orientationAlpha.value(),
        offset: this.orientationOffset.value(),
      },
    };
  }
}
