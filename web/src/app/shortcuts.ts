/**
 * Keyboard shortcut table (spec §5.1). One place for every binding so a
 * settings UI can remap them later. Chrome reserves Ctrl+N / Ctrl+T / Ctrl+W,
 * hence the Ctrl+Alt+N for Add Display.
 *
 * Scopes: `global` works anywhere (except inside text inputs for plain keys),
 * `displays` only while the Displays tree has focus, `viewport` only while the
 * 3D view has focus (handled by the ToolManager / ViewManager).
 */

export type ShortcutScope = 'global' | 'displays' | 'viewport';

export interface Shortcut {
  id: string;
  /** Human-readable combination, e.g. "Ctrl+Shift+S". */
  keys: string;
  label: string;
  scope: ShortcutScope;
  /** RViz's original binding, for the help table. */
  rviz: string;
}

export const SHORTCUTS: Shortcut[] = [
  { id: 'open', keys: 'Ctrl+O', label: 'Open Config', scope: 'global', rviz: 'Ctrl+O' },
  { id: 'save', keys: 'Ctrl+S', label: 'Save Config', scope: 'global', rviz: 'Ctrl+S' },
  { id: 'saveAs', keys: 'Ctrl+Shift+S', label: 'Save Config As', scope: 'global', rviz: 'Ctrl+Shift+S' },
  { id: 'fullscreen', keys: 'F11', label: 'Fullscreen', scope: 'global', rviz: 'F11' },
  { id: 'addDisplay', keys: 'Ctrl+Alt+N', label: 'Add Display', scope: 'global', rviz: 'Ctrl+N' },
  { id: 'duplicateDisplay', keys: 'Ctrl+D', label: 'Duplicate Display', scope: 'displays', rviz: 'Ctrl+D' },
  { id: 'removeDisplay', keys: 'Delete', label: 'Remove Display', scope: 'displays', rviz: 'Ctrl+X' },
  { id: 'removeDisplayAlt', keys: 'Ctrl+X', label: 'Remove Display', scope: 'displays', rviz: 'Ctrl+X' },
  { id: 'renameDisplay', keys: 'F2', label: 'Rename Display', scope: 'displays', rviz: 'Ctrl+R' },
  { id: 'tool.interact', keys: 'I', label: 'Interact tool', scope: 'viewport', rviz: 'i' },
  { id: 'tool.moveCamera', keys: 'M', label: 'Move Camera tool', scope: 'viewport', rviz: 'm' },
  { id: 'tool.select', keys: 'S', label: 'Select tool', scope: 'viewport', rviz: 's' },
  { id: 'tool.focusCamera', keys: 'C', label: 'Focus Camera tool', scope: 'viewport', rviz: 'c' },
  { id: 'tool.measure', keys: 'N', label: 'Measure tool', scope: 'viewport', rviz: 'n' },
  { id: 'tool.setInitialPose', keys: 'P', label: '2D Pose Estimate tool', scope: 'viewport', rviz: 'p' },
  { id: 'tool.setGoal', keys: 'G', label: '2D Goal Pose tool', scope: 'viewport', rviz: 'g' },
  { id: 'tool.publishPoint', keys: 'U', label: 'Publish Point tool', scope: 'viewport', rviz: 'u' },
  { id: 'tool.default', keys: 'Esc', label: 'Back to the default tool', scope: 'viewport', rviz: 'Esc' },
  { id: 'view.reset', keys: 'Z', label: 'Reset view', scope: 'viewport', rviz: 'Z' },
  { id: 'view.focus', keys: 'F', label: 'Look at the point under the cursor (Tier 1)', scope: 'viewport', rviz: 'F' },
];

/** Normalizes a KeyboardEvent to the "Ctrl+Shift+S" form used in the table. */
export function comboOf(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let key = e.key;
  if (key === ' ') key = 'Space';
  else if (key === 'Escape') key = 'Esc';
  else if (key.length === 1) key = key.toUpperCase();
  parts.push(key);
  return parts.join('+');
}

export type ShortcutHandler = (id: string, e: KeyboardEvent) => boolean;

/**
 * Installs the global listener. `handler` returns true when it consumed the
 * shortcut. Plain keys (no Ctrl/Alt) are ignored while typing in inputs.
 */
export function installShortcuts(handler: ShortcutHandler, scopeOf: () => ShortcutScope[]): () => void {
  const listener = (e: KeyboardEvent) => {
    const combo = comboOf(e);
    const target = e.target instanceof Element ? e.target : null;
    const typing = target?.closest('input, select, textarea, [contenteditable]');
    const scopes = scopeOf();
    for (const s of SHORTCUTS) {
      if (s.keys !== combo || !scopes.includes(s.scope)) continue;
      if (typing && !e.ctrlKey && !e.metaKey && !e.altKey && s.keys !== 'Esc') continue;
      if (handler(s.id, e)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }
  };
  window.addEventListener('keydown', listener, { capture: true });
  return () => window.removeEventListener('keydown', listener, { capture: true });
}
