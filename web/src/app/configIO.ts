/**
 * Opening and saving .rviz files (spec §5.1): File System Access API when the
 * browser has it, upload/download otherwise; a config loaded through the
 * server's `-d` option is written back through the server. Recent configs are
 * remembered in localStorage (names) and IndexedDB (file handles).
 */

import type { AppStore } from './store';

export type ConfigSource =
  | { kind: 'embedded' }
  | { kind: 'server'; path: string }
  | { kind: 'handle'; handle: FileSystemFileHandle }
  | { kind: 'download'; name: string };

export interface RecentEntry {
  name: string;
  kind: 'server' | 'handle';
  openedAt: number;
}

const RECENT_KEY = 'webrvizlite.recentConfigs';
const MAX_RECENT = 10;

interface FsWindow {
  showOpenFilePicker?: (opts?: unknown) => Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?: (opts?: unknown) => Promise<FileSystemFileHandle>;
}

const fsWindow = window as unknown as FsWindow;
export const hasFileSystemAccess = typeof fsWindow.showOpenFilePicker === 'function';

const PICKER_TYPES = [{ description: 'RViz config', accept: { 'application/yaml': ['.rviz', '.yaml', '.yml'] } }];

// --- recent list -----------------------------------------------------------

export function recentConfigs(): RecentEntry[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as RecentEntry[];
  } catch {
    return [];
  }
}

function pushRecent(entry: RecentEntry) {
  const list = recentConfigs().filter((r) => r.name !== entry.name);
  list.unshift(entry);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
  } catch {
    /* storage may be unavailable */
  }
}

// IndexedDB keeps FileSystemFileHandles (they are structured-cloneable).
function handleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('webrvizlite', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('handles');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function storeHandle(name: string, handle: FileSystemFileHandle) {
  try {
    const db = await handleDb();
    const tx = db.transaction('handles', 'readwrite');
    tx.objectStore('handles').put(handle, name);
    await new Promise((r) => (tx.oncomplete = r));
  } catch {
    /* ignore */
  }
}

async function loadHandle(name: string): Promise<FileSystemFileHandle | null> {
  try {
    const db = await handleDb();
    const tx = db.transaction('handles', 'readonly');
    const req = tx.objectStore('handles').get(name);
    return await new Promise((resolve) => {
      req.onsuccess = () => resolve((req.result as FileSystemFileHandle) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

// --- open ------------------------------------------------------------------

export async function openConfig(app: AppStore): Promise<void> {
  if (hasFileSystemAccess) {
    let handles: FileSystemFileHandle[];
    try {
      handles = await fsWindow.showOpenFilePicker!({ types: PICKER_TYPES, multiple: false });
    } catch {
      return; // cancelled
    }
    const handle = handles[0];
    const file = await handle.getFile();
    app.loadConfigText(await file.text(), file.name);
    app.setSource({ kind: 'handle', handle });
    await storeHandle(file.name, handle);
    pushRecent({ name: file.name, kind: 'handle', openedAt: Date.now() });
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.rviz,.yaml,.yml';
  const file = await new Promise<File | null>((resolve) => {
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
  if (!file) return;
  app.loadConfigText(await file.text(), file.name);
  app.setSource({ kind: 'download', name: file.name });
}

export async function openRecent(app: AppStore, entry: RecentEntry): Promise<void> {
  if (entry.kind === 'server') {
    const hello = app.bridge.hello();
    await app.loadStartupConfig(hello?.display_config ?? null);
    return;
  }
  const handle = await loadHandle(entry.name);
  if (!handle) {
    await openConfig(app);
    return;
  }
  const perm = await (handle as unknown as { requestPermission?: (o: unknown) => Promise<string> }).requestPermission?.({ mode: 'readwrite' });
  if (perm && perm !== 'granted') return;
  const file = await handle.getFile();
  app.loadConfigText(await file.text(), file.name);
  app.setSource({ kind: 'handle', handle });
  pushRecent({ ...entry, openedAt: Date.now() });
}

// --- save ------------------------------------------------------------------

function download(text: string, name: string) {
  const blob = new Blob([text], { type: 'application/yaml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function writeHandle(handle: FileSystemFileHandle, text: string) {
  const writable = await (handle as unknown as { createWritable: () => Promise<{ write(d: string): Promise<void>; close(): Promise<void> }> }).createWritable();
  await writable.write(text);
  await writable.close();
}

/** Ctrl+S: write back where the config came from; falls back to Save As. */
export async function saveConfig(app: AppStore): Promise<void> {
  const text = app.saveConfigText();
  const src = app.source();
  switch (src.kind) {
    case 'server': {
      const res = await fetch('/api/display-config', { method: 'POST', headers: { 'content-type': 'application/yaml' }, body: text });
      if (!res.ok) throw new Error(`server refused to save: ${res.status} ${await res.text()}`);
      pushRecent({ name: app.configName(), kind: 'server', openedAt: Date.now() });
      return;
    }
    case 'handle':
      await writeHandle(src.handle, text);
      pushRecent({ name: app.configName(), kind: 'handle', openedAt: Date.now() });
      return;
    default:
      await saveConfigAs(app);
  }
}

/** Ctrl+Shift+S. */
export async function saveConfigAs(app: AppStore): Promise<void> {
  const text = app.saveConfigText();
  if (hasFileSystemAccess) {
    let handle: FileSystemFileHandle;
    try {
      handle = await fsWindow.showSaveFilePicker!({ types: PICKER_TYPES, suggestedName: app.configName() });
    } catch {
      return; // cancelled
    }
    await writeHandle(handle, text);
    app.setSource({ kind: 'handle', handle });
    app.setConfigName(handle.name);
    await storeHandle(handle.name, handle);
    pushRecent({ name: handle.name, kind: 'handle', openedAt: Date.now() });
    return;
  }
  download(text, app.configName());
}
