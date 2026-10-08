/**
 * Base ViewController: the common properties from rviz_common::ViewController
 * and FramePositionTrackingViewController (Target Frame following).
 */

import * as THREE from 'three/webgpu';
import { BoolPropertyImpl, FloatPropertyImpl, TfFramePropertyImpl, PropertyBase, isYamlMap } from '../property/Property';
import type { ChangeSource, YamlMap, YamlValue } from '../property/types';
import type { ViewContext, ViewController, ViewportPointerEvent } from './types';

/** rviz formats the view row's value as "Orbit (rviz_default_plugins)". */
export function formatClassId(classId: string): string {
  const [pkg, name] = classId.split('/');
  return name ? `${name} (${pkg})` : classId;
}

export abstract class ViewControllerBase extends PropertyBase<string> implements ViewController {
  readonly classId: string;
  readonly camera: THREE.PerspectiveCamera;
  readonly nearClip: FloatPropertyImpl;
  readonly targetFrame: TfFramePropertyImpl;
  readonly invertZ: BoolPropertyImpl;
  readonly stereo: BoolPropertyImpl;
  protected ctx: ViewContext | null = null;
  /** Position of the target frame in the fixed frame; the camera orbits/moves relative to it. */
  protected readonly targetPosition = new THREE.Vector3();
  protected aspect = 1;

  constructor(classId: string, fixedFrame: () => string) {
    super('Current View', formatClassId(classId), null, { readOnly: false });
    this.classId = classId;
    this.reservedKeys = new Set(['Class', 'Name']);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10000);
    this.camera.up.set(0, 0, 1); // ROS: Z up
    this.nearClip = new FloatPropertyImpl('Near Clip Distance', 0.01, this, {
      description: "Anything closer to the camera than this threshold will not get rendered.",
      min: 0.001,
    });
    this.invertZ = new BoolPropertyImpl('Invert Z Axis', false, this, { description: 'Invert camera\'s Z axis for Z-down environments/models.' });
    this.targetFrame = new TfFramePropertyImpl('Target Frame', '<Fixed Frame>', this, fixedFrame, {
      description: 'TF frame whose motion this view will follow.',
    });
    // Stereo (spec: accepted and saved, never effective). rviz forces it false and hides it.
    this.stereo = new BoolPropertyImpl('Enable Stereo Rendering', true, this, { description: 'Render the main view in stereo if supported.', hidden: true });
    new BoolPropertyImpl('Swap Stereo Eyes', false, this.stereo, { description: 'Swap eyes if the monitor shows the left eye on the right.' });
    new FloatPropertyImpl('Stereo Eye Separation', 0.06, this.stereo, { description: 'Distance between eyes for stereo rendering.' });
    new FloatPropertyImpl('Stereo Focal Distance', 1.0, this.stereo, { description: 'Distance from eyes to screen.  For stereo rendering.' });
    this.nearClip.onChange((v) => {
      this.camera.near = v;
      this.camera.updateProjectionMatrix();
    });
  }

  readonly kind = 'string' as const;
  protected encodeValue(): YamlValue {
    return this.value();
  }
  protected decodeValue(yaml: YamlValue, source: ChangeSource): boolean {
    // Cosmetic label ("Orbit (rviz)" in default.rviz, "Orbit (rviz_default_plugins)" from rviz itself):
    // keep whatever the file says so the round trip is exact.
    return typeof yaml === 'string' ? this.setValue(yaml, source) : false;
  }

  initialize(ctx: ViewContext) {
    this.ctx = ctx;
    this.camera.near = this.nearClip.value();
    this.camera.updateProjectionMatrix();
    this.updateCamera();
  }

  setAspect(aspect: number) {
    if (aspect === this.aspect) return;
    this.aspect = aspect;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Follows the Target Frame's position (orientation is ignored, as in rviz). */
  update(_dt: number) {
    const frame = this.targetFrame.frameId();
    const fixed = this.ctx?.fixedFrame() ?? '';
    if (this.ctx && frame && frame !== fixed && this.ctx.tf.lookup(frame, tmpM, tmpPos)) {
      this.targetPosition.copy(tmpPos);
    } else {
      this.targetPosition.set(0, 0, 0);
    }
    this.updateCamera();
  }

  protected abstract updateCamera(): void;
  abstract handleMouse(e: ViewportPointerEvent): void;
  abstract reset(): void;
  abstract lookAt(point: THREE.Vector3): void;
  abstract mimic(previous: ViewController): void;

  override save(): YamlMap {
    const yaml = super.save();
    const map: YamlMap = isYamlMap(yaml) ? yaml : { Value: yaml };
    map.Class = this.classId;
    map.Name = this.name();
    return map;
  }

  override load(yaml: YamlValue, source: ChangeSource = 'config') {
    super.load(yaml, source);
    if (isYamlMap(yaml) && typeof yaml.Name === 'string') this.setName(yaml.Name);
  }
}

const tmpM = new THREE.Matrix4();
const tmpPos = new THREE.Vector3();
