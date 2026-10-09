/**
 * The Shape (Arrow / Axes) property set shared by Pose, PoseWithCovariance and
 * Odometry (spec §8.2): same names, defaults and hidden rules as rviz
 * pose_display.cpp. `sizeParent` lets Odometry nest the sizes under Shape.
 */

import { ColorPropertyImpl, EnumPropertyImpl, FloatPropertyImpl } from '../property/Property';
import type { Property } from '../property/types';
import type { Arrow, Axes } from './primitives';

export class PoseShapeProps {
  readonly shape: EnumPropertyImpl;
  readonly color: ColorPropertyImpl;
  readonly alpha: FloatPropertyImpl;
  readonly shaftLength: FloatPropertyImpl;
  readonly shaftRadius: FloatPropertyImpl;
  readonly headLength: FloatPropertyImpl;
  readonly headRadius: FloatPropertyImpl;
  readonly axesLength: FloatPropertyImpl;
  readonly axesRadius: FloatPropertyImpl;

  constructor(parent: Property, onChange: () => void, opts: { sizesUnderShape?: boolean; description?: string } = {}) {
    this.shape = new EnumPropertyImpl('Shape', 'Arrow', ['Arrow', 'Axes'], parent, { description: opts.description ?? 'Shape to display the pose as.' });
    const sp = opts.sizesUnderShape ? this.shape : parent;
    this.color = new ColorPropertyImpl('Color', { r: 255, g: 25, b: 0 }, sp, { description: 'Color to draw the arrow.' });
    this.alpha = new FloatPropertyImpl('Alpha', 1, sp, { description: 'Amount of transparency to apply to the arrow.', min: 0, max: 1 });
    this.shaftLength = new FloatPropertyImpl('Shaft Length', 1, sp, { description: "Length of the arrow's shaft, in meters." });
    this.shaftRadius = new FloatPropertyImpl('Shaft Radius', 0.05, sp, { description: "Radius of the arrow's shaft, in meters." });
    this.headLength = new FloatPropertyImpl('Head Length', 0.3, sp, { description: "Length of the arrow's head, in meters." });
    this.headRadius = new FloatPropertyImpl('Head Radius', 0.1, sp, { description: "Radius of the arrow's head, in meters." });
    this.axesLength = new FloatPropertyImpl('Axes Length', 1, sp, { description: 'Length of each axis, in meters.', hidden: true });
    this.axesRadius = new FloatPropertyImpl('Axes Radius', 0.1, sp, { description: 'Radius of each axis, in meters.', hidden: true });
    this.shape.onChange(() => {
      this.updateVisibility();
      onChange();
    });
    for (const p of [this.color, this.alpha, this.shaftLength, this.shaftRadius, this.headLength, this.headRadius, this.axesLength, this.axesRadius]) p.onChange(onChange);
    this.updateVisibility();
  }

  isArrow() {
    return this.shape.value() === 'Arrow';
  }

  private updateVisibility() {
    const arrow = this.isArrow();
    for (const p of [this.color, this.alpha, this.shaftLength, this.shaftRadius, this.headLength, this.headRadius]) p.setHidden(!arrow);
    this.axesLength.setHidden(arrow);
    this.axesRadius.setHidden(arrow);
  }

  /** Applies colour and sizes to one Arrow + Axes pair and toggles which is shown. */
  applyTo(arrow: Arrow, axes: Axes, visible: boolean) {
    const isArrow = this.isArrow();
    arrow.visible = isArrow && visible;
    axes.visible = !isArrow && visible;
    const c = this.color.value();
    arrow.setColor(c.r, c.g, c.b, this.alpha.value());
    arrow.set(this.shaftLength.value(), this.shaftRadius.value(), this.headLength.value(), this.headRadius.value());
    axes.set(this.axesLength.value(), this.axesRadius.value());
  }

  /** Rough extent for selection boxes. */
  extent(): number {
    return this.isArrow() ? this.shaftLength.value() + this.headLength.value() : this.axesLength.value();
  }
}
