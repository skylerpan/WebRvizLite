import { createSignal, type Accessor } from 'solid-js';
import { GroupProperty, isYamlMap } from '../property/Property';
import type { Property, YamlMap, YamlValue } from '../property/types';
import type { ViewportPointerEvent } from '../views/types';
import type { Tool, ToolContext } from './types';

/** rviz ToolManager::addTool turns "MoveCamera" into "Move Camera". */
export function addSpaceToCamelCase(name: string): string {
  return name.replace(/([a-z])([A-Z])/g, '$1 $2');
}

export abstract class ToolBase implements Tool {
  readonly classId: string;
  readonly name: Accessor<string>;
  protected readonly setName: (n: string) => void;
  readonly shortcut: string;
  readonly properties: GroupProperty;
  readonly available: boolean = true;
  protected ctx: ToolContext | null = null;

  constructor(classId: string, shortcut: string, name?: string) {
    this.classId = classId;
    this.shortcut = shortcut;
    [this.name, this.setName] = createSignal(name ?? addSpaceToCamelCase(classId.split('/').pop() ?? classId));
    this.properties = new GroupProperty(this.name(), null);
  }

  initialize(ctx: ToolContext) {
    this.ctx = ctx;
  }
  activate() {}
  deactivate() {}
  handleMouse(_e: ViewportPointerEvent) {}
  handleKey(_key: string, _e: KeyboardEvent): boolean {
    return false;
  }

  /** rviz Tool::save: property container, then Class. */
  save(): YamlMap {
    const yaml = this.properties.save();
    const map: YamlMap = isYamlMap(yaml) ? { ...yaml } : {};
    map.Class = this.classId;
    return map;
  }

  load(yaml: YamlMap) {
    const { Class: _c, ...rest } = yaml;
    this.properties.load(rest);
  }

  protected prop(name: string): Property | undefined {
    return this.properties.child(name);
  }
}

/** Config entry for a tool class we do not implement; keeps its YAML and shows greyed in the toolbar. */
export class UnknownTool extends ToolBase {
  override readonly available = false;
  private yaml: YamlMap = {};
  constructor(classId: string) {
    super(classId, '');
  }
  override save(): YamlMap {
    return { ...this.yaml, Class: this.classId };
  }
  override load(yaml: YamlMap) {
    this.yaml = { ...yaml };
  }
}

export function isTool(v: YamlValue): v is YamlMap {
  return isYamlMap(v) && typeof v.Class === 'string';
}
