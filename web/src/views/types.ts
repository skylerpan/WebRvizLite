/**
 * ViewController interfaces (spec §7.2), mirroring rviz_common::ViewController
 * and rviz_default_plugins' FramePositionTrackingViewController.
 */

import type { Accessor } from 'solid-js';
import type * as THREE from 'three/webgpu';
import type { Property, YamlMap } from '../property/types';
import type { TfSnapshot } from '../render/tf';

export interface ViewportPointerEvent {
  type: 'down' | 'move' | 'up' | 'wheel' | 'leave';
  x: number;
  y: number;
  dx: number;
  dy: number;
  /** Mouse buttons currently pressed (MouseEvent.buttons bitmask: 1 left, 2 right, 4 middle). */
  buttons: number;
  button: number;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  /** Wheel delta in "notches" (positive = scroll up / zoom in), 0 otherwise. */
  wheel: number;
  width: number;
  height: number;
}

export interface ViewContext {
  readonly tf: TfSnapshot;
  readonly fixedFrame: Accessor<string>;
}

/** A ViewController is a Property subtree (shown in the Views panel) that drives the camera. */
export interface ViewController extends Property<string> {
  readonly classId: string;
  readonly camera: THREE.Camera;
  /** Near Clip Distance, Target Frame, Invert Z Axis, stereo props live here. */
  initialize(ctx: ViewContext): void;
  /** Called every rendered frame: follow the target frame, update the camera. */
  update(dt: number): void;
  /** Aspect ratio of the viewport changed. */
  setAspect(aspect: number): void;
  handleMouse(e: ViewportPointerEvent): void;
  /** "Z" key / Zero button. */
  reset(): void;
  /** Place the camera to look at a point ("F" key). */
  lookAt(point: THREE.Vector3): void;
  /** Carry camera pose over from the previous controller when switching types. */
  mimic(previous: ViewController): void;
  save(): YamlMap;
  load(yaml: YamlMap): void;
}

export interface ViewClassInfo {
  readonly classId: string;
  readonly name: string;
  readonly description: string;
}
