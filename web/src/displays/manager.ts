/**
 * VisualizationManager: owns the root DisplayGroup ("root"), Global Options,
 * Global Status, the ViewManager, the ToolManager and the DisplayContext handed
 * to every Display (rviz_common::VisualizationManager).
 */

import { createEffect, createSignal, untrack, type Accessor } from 'solid-js';
import * as THREE from 'three/webgpu';
import { ColorPropertyImpl, GroupProperty, IntPropertyImpl, StatusListPropertyImpl, TfFramePropertyImpl, stripLeadingSlash } from '../property/Property';
import type { Rgb, YamlMap, YamlValue } from '../property/types';
import type { BridgeClient } from '../worker/client';
import { DisplayGroupImpl } from './Display';
import { createDisplayRegistry } from './registry';
import type { DisplayContext, DisplayRegistry } from './types';
import { ViewManager } from '../views/ViewManager';
import { ToolManager } from '../tools/ToolManager';

export class VisualizationManager {
  readonly registry: DisplayRegistry;
  readonly root: DisplayGroupImpl;
  readonly globalOptions: GroupProperty;
  readonly fixedFrameProperty: TfFramePropertyImpl;
  readonly backgroundColor: ColorPropertyImpl;
  readonly frameRate: IntPropertyImpl;
  readonly globalStatus: StatusListPropertyImpl;
  /** Fixed Frame with the leading "/" stripped (what tf lookups use). */
  readonly fixedFrame: Accessor<string>;
  readonly context: DisplayContext;
  readonly views: ViewManager;
  readonly tools: ToolManager;
  /** ROS time from the server clock, ns. */
  readonly rosTimeNs: Accessor<bigint>;
  private lastRosNs = 0n;

  constructor(readonly scene: THREE.Scene, readonly bridge: BridgeClient) {
    const [fixedFrame, setFixedFrame] = createSignal('base_link');
    this.fixedFrame = fixedFrame;
    this.registry = createDisplayRegistry(fixedFrame);
    this.root = new DisplayGroupImpl(this.registry, 'root', '');

    this.globalOptions = new GroupProperty('Global Options', this.root);
    this.fixedFrameProperty = new TfFramePropertyImpl('Fixed Frame', 'base_link', this.globalOptions, null, {
      description: 'Frame into which all data is transformed before being displayed.',
      includeFixedFrame: false,
    });
    this.backgroundColor = new ColorPropertyImpl('Background Color', { r: 48, g: 48, b: 48 }, this.globalOptions, {
      description: 'Background color for the 3D view.',
    });
    this.frameRate = new IntPropertyImpl('Frame Rate', 30, this.globalOptions, {
      description: 'RViz will try to render this many frames per second.',
      min: 1,
      max: 1000,
    });
    this.globalStatus = new StatusListPropertyImpl('Global Status', this.root);

    this.rosTimeNs = () => {
      const c = bridge.clock();
      return c ? c.rosTimeNs : 0n;
    };
    this.context = { scene, bridge, fixedFrame, tf: bridge.tf, rosTimeNs: this.rosTimeNs };

    this.views = new ViewManager({ tf: bridge.tf, fixedFrame });
    scene.add(this.views.helpers);
    this.tools = new ToolManager({ views: this.views, bridge, fixedFrame });

    this.fixedFrameProperty.onChange((v) => {
      const frame = stripLeadingSlash(v);
      setFixedFrame(frame);
      bridge.setFixedFrame(frame);
      this.root.fixedFrameChanged();
    });
    bridge.setFixedFrame(fixedFrame());
    // Fixed Frame options come from the tf buffer; Global Status reports whether it exists.
    createEffect(() => {
      bridge.tf.framesVersion();
      // untrack: property internals (children signals) must not re-trigger this effect.
      untrack(() => {
        this.fixedFrameProperty.setOptions([...bridge.tf.frames()]);
        this.updateFixedFrameStatus();
      });
    });
    this.frameRate.onChange((hz) => bridge.setTfRate(Math.min(60, hz)));

    this.root.initialize(this.context);
    this.updateFixedFrameStatus();
  }

  private updateFixedFrameStatus() {
    const frame = this.fixedFrame();
    const tf = this.bridge.tf;
    if (tf.frames().length === 0) this.globalStatus.setStatus('warn', 'Fixed Frame', 'No tf data.  Actual error: Frame [' + frame + '] does not exist');
    else if (!tf.has(frame)) this.globalStatus.setStatus('error', 'Fixed Frame', `Frame [${frame}] does not exist`);
    else this.globalStatus.setStatus('ok', 'Fixed Frame', 'OK');
  }

  background(): Rgb {
    return this.backgroundColor.value();
  }

  /** Once per rendered frame. */
  update(wallDt: number) {
    const ros = this.rosTimeNs();
    const rosDt = this.lastRosNs && ros ? Number(ros - this.lastRosNs) / 1e9 : wallDt;
    this.lastRosNs = ros;
    this.updateFixedFrameStatusIfChanged();
    this.views.update(wallDt);
    this.root.update(wallDt, rosDt);
  }

  private lastStatusKey = '';
  private updateFixedFrameStatusIfChanged() {
    const key = `${this.fixedFrame()}|${this.bridge.tf.frames().length}|${this.bridge.tf.has(this.fixedFrame())}`;
    if (key !== this.lastStatusKey) {
      this.lastStatusKey = key;
      this.updateFixedFrameStatus();
    }
  }

  /** The "Visualization Manager" section of a .rviz file. */
  save(): YamlMap {
    const map = this.root.save();
    map.Class = '';
    map.Name = 'root';
    map.Views = this.views.save();
    map.Tools = this.tools.save();
    return map;
  }

  load(yaml: YamlValue) {
    this.root.load(yaml);
    this.root.setName('root');
    const map = (yaml ?? {}) as YamlMap;
    this.views.load(map.Views ?? null);
    this.tools.load(map.Tools ?? null);
  }
}
