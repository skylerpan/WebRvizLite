/**
 * rviz_common::ToolManager: the ordered tool list (toolbar), the active tool,
 * the default tool, keyboard shortcuts, and the "Tools" config section.
 */

import { createSignal, type Accessor } from 'solid-js';
import { MOVE_CAMERA_INFO, MoveCameraTool } from './moveCamera';
import { UnknownTool, isTool } from './Tool';
import { GroupProperty } from '../property/Property';
import type { Tool, ToolClassInfo, ToolContext } from './types';
import type { YamlValue } from '../property/types';
import type { ViewportPointerEvent } from '../views/types';

/** Tools rviz loads when the config has no Tools section (tool_manager.cpp). */
const DEFAULT_TOOLS = [
  'rviz_default_plugins/MoveCamera',
  'rviz_default_plugins/Interact',
  'rviz_default_plugins/Select',
  'rviz_default_plugins/SetInitialPose',
  'rviz_default_plugins/SetGoal',
];

export class ToolManager {
  private readonly classes = new Map<string, { info: ToolClassInfo; create: () => Tool }>();
  readonly tools: Accessor<readonly Tool[]>;
  private readonly setTools: (t: readonly Tool[]) => void;
  /** Root of the Tool Properties panel: one child per tool that has properties (rviz ToolPropertiesPanel). */
  readonly propertiesRoot = new GroupProperty('Tool Properties', null);
  readonly current: Accessor<Tool | null>;
  private readonly setCurrentSignal: (t: Tool | null) => void;
  private readonly ctx: ToolContext;

  constructor(ctx: Omit<ToolContext, 'revertToDefault'>) {
    this.ctx = { ...ctx, revertToDefault: () => this.revertToDefault() };
    const [tools, setTools] = createSignal<readonly Tool[]>([]);
    this.tools = tools;
    this.setTools = (t) => {
      setTools(t);
      this.syncPropertiesRoot();
    };
    [this.current, this.setCurrentSignal] = createSignal<Tool | null>(null);
    this.register(MOVE_CAMERA_INFO, () => new MoveCameraTool());
    this.load(null);
  }

  private syncPropertiesRoot() {
    const wanted = this.tools().filter((t) => t.available && t.properties.children().length > 0).map((t) => t.properties);
    for (const c of this.propertiesRoot.children().slice()) if (!wanted.includes(c as GroupProperty)) this.propertiesRoot.removeChild(c);
    for (const p of wanted) this.propertiesRoot.addChild(p);
  }

  register(info: ToolClassInfo, create: () => Tool) {
    this.classes.set(info.classId, { info, create });
  }

  classInfos(): ToolClassInfo[] {
    return [...this.classes.values()].map((c) => c.info);
  }

  create(classId: string): Tool {
    const entry = this.classes.get(classId);
    const tool = entry ? entry.create() : new UnknownTool(classId);
    tool.initialize(this.ctx);
    return tool;
  }

  addTool(classId: string): Tool {
    const tool = this.create(classId);
    this.setTools([...this.tools(), tool]);
    if (!this.current() && tool.available) this.setCurrent(tool);
    return tool;
  }

  removeTool(tool: Tool) {
    if (this.current() === tool) this.revertToDefault();
    this.setTools(this.tools().filter((t) => t !== tool));
  }

  /** rviz: the default tool is the first available one (MoveCamera in practice). */
  defaultTool(): Tool | null {
    return this.tools().find((t) => t.available) ?? null;
  }

  setCurrent(tool: Tool | null) {
    if (tool && !tool.available) return;
    const prev = this.current();
    if (prev === tool) return;
    prev?.deactivate();
    this.setCurrentSignal(tool);
    tool?.activate();
  }

  revertToDefault() {
    this.setCurrent(this.defaultTool());
  }

  handleMouse(e: ViewportPointerEvent) {
    this.current()?.handleMouse(e);
  }

  /** Shortcut keys (spec §5.1): tool letters, Esc for the default tool. Returns true if consumed. */
  handleKey(key: string, e: KeyboardEvent): boolean {
    if (this.current()?.handleKey(key, e)) return true;
    if (key === 'Escape') {
      this.revertToDefault();
      return true;
    }
    if (key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const tool = this.tools().find((t) => t.available && t.shortcut === key.toLowerCase());
      if (tool) {
        this.setCurrent(tool);
        return true;
      }
    }
    return false;
  }

  save(): YamlValue {
    return this.tools().map((t) => t.save());
  }

  load(yaml: YamlValue | null) {
    this.setCurrentSignal(null);
    this.setTools([]);
    const entries = Array.isArray(yaml) ? yaml.filter(isTool) : null;
    if (!entries || entries.length === 0) {
      for (const c of DEFAULT_TOOLS) this.addTool(c);
      return;
    }
    for (const entry of entries) {
      const tool = this.addTool(entry.Class as string);
      tool.load(entry);
    }
  }
}
