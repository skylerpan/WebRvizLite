/**
 * Opening and saving .rviz files (spec §5.1): File System Access API when the
 * browser has it, upload/download otherwise; a config loaded through the
 * server's `-d` option is written back through the server. Recent configs are
 * remembered in localStorage (names) and IndexedDB (file handles, or a snapshot
 * of the picked File when the browser has no File System Access API).
 */

import type { AppStore } from './store';

export type ConfigSource =
  | { kind: 'embedded' }
  | { kind: 'server'; path: string }
  | { kind: 'handle'; handle: FileSystemFileHandle }
  | { kind: 'download'; name: string };

export interface RecentEntry {
  name: string;
  /** `handle`: FileSystemFileHandle in IndexedDB; `file`: snapshot of the picked File (no File System Access API). */
  kind: 'server' | 'handle' | 'file';
  openedAt: number;
}

const RECENT_KEY = 'webrvizlite.recentConfigs';
const MAX_RECENT = 10;

interface FsWindow {
  showOpenFilePicker?: (opts?: unknown) => Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?: (opts?: unknown) => Promise<FileSystemFileHandle>;
}

const fsWindow = () => window as unknown as FsWindow;

/** True in secure contexts of Chromium browsers; checked at call time so tests can toggle it. */
export function hasFileSystemAccess(): boolean {
  return typeof fsWindow().showOpenFilePicker === 'function';
}

const PICKER_TYPES = [{ description: 'RViz config', accept: { 'application/yaml': ['.rviz', '.yaml', '.yml'] } }];

// --- recent list -----------------------------------------------------------

export function recentConfigs(): RecentEntry[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown;
    return Array.isArray(list) ? (list as RecentEntry[]) : [];
  } catch {
    return [];
  }
}

function pushRecent(entry: RecentEntry) {
  const list = recentConfigs().filter((r) => !(r.name === entry.name && r.kind === entry.kind));
  list.unshift(entry);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
  } catch {
    /* storage may be unavailable */
  }
}

// IndexedDB keeps FileSystemFileHandles (structured-cloneable) and text snapshots of picked files.
interface FileSnapshot {
  name: string;
  text: string;
}
type StoredFile = FileSystemFileHandle | FileSnapshot;
const isHandle = (v: StoredFile): v is FileSystemFileHandle => typeof (v as FileSystemFileHandle).getFile === 'function';

function handleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('webrvizlite', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('handles');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const storedKey = (entry: Pick<RecentEntry, 'name' | 'kind'>) => (entry.kind === 'file' ? `file:${entry.name}` : entry.name);

async function storeFile(entry: Pick<RecentEntry, 'name' | 'kind'>, value: StoredFile) {
  try {
    const db = await handleDb();
    try {
      const tx = db.transaction('handles', 'readwrite');
      tx.objectStore('handles').put(value, storedKey(entry));
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  } catch {
    /* ignore: Recent Configs then falls back to the picker */
  }
}

async function loadStoredFile(entry: Pick<RecentEntry, 'name' | 'kind'>): Promise<StoredFile | null> {
  try {
    const db = await handleDb();
    try {
      const tx = db.transaction('handles', 'readonly');
      const req = tx.objectStore('handles').get(storedKey(entry));
      return await new Promise((resolve) => {
        req.onsuccess = () => resolve((req.result as StoredFile | undefined) ?? null);
        req.onerror = () => resolve(null);
      });
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

// --- open ------------------------------------------------------------------

/**
 * The hidden <input type=file> of the fallback picker. It must stay reachable
 * (and in the document) while the native dialog is open: a detached input is
 * garbage-collected and its `change` event is never delivered.
 */
let pendingInput: HTMLInputElement | null = null;

function pickFileFallback(): Promise<File | null> {
  pendingInput?.remove();
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.rviz,.yaml,.yml';
  input.hidden = true;
  document.body.appendChild(input);
  pendingInput = input;
  return new Promise<File | null>((resolve) => {
    const done = (file: File | null) => {
      if (pendingInput === input) pendingInput = null;
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => done(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => done(null));
    input.click();
  });
}

function loadSnapshot(app: AppStore, snap: FileSnapshot) {
  app.loadConfigText(snap.text, snap.name);
  app.setSource({ kind: 'download', name: snap.name });
}

export async function openConfig(app: AppStore): Promise<void> {
  if (hasFileSystemAccess()) {
    let handles: FileSystemFileHandle[];
    try {
      handles = await fsWindow().showOpenFilePicker!({ types: PICKER_TYPES, multiple: false });
    } catch {
      return; // cancelled
    }
    const handle = handles[0];
    const file = await handle.getFile();
    app.loadConfigText(await file.text(), file.name);
    app.setSource({ kind: 'handle', handle });
    pushRecent({ name: file.name, kind: 'handle', openedAt: Date.now() });
    await storeFile({ name: file.name, kind: 'handle' }, handle);
    return;
  }
  const file = await pickFileFallback();
  if (!file) return;
  const snap: FileSnapshot = { name: file.name, text: await file.text() };
  loadSnapshot(app, snap);
  pushRecent({ name: file.name, kind: 'file', openedAt: Date.now() });
  await storeFile({ name: file.name, kind: 'file' }, snap);
}

export async function openRecent(app: AppStore, entry: RecentEntry): Promise<void> {
  if (entry.kind === 'server') {
    const path = app.bridge.hello()?.display_config ?? null;
    if (!path) throw new Error('the server was started without a display config (-d)');
    await app.loadStartupConfig(path, { force: true });
    return;
  }
  const stored = await loadStoredFile(entry);
  if (!stored) {
    await openConfig(app);
    return;
  }
  if (!isHandle(stored)) {
    loadSnapshot(app, stored);
    pushRecent({ ...entry, openedAt: Date.now() });
    return;
  }
  const handle = stored;
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
  a.hidden = true;
  // In the document and revoked later: some browsers ignore clicks on detached anchors
  // or cancel the download when the URL is revoked before the request started.
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(a.href);
  }, 1000);
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
  if (hasFileSystemAccess()) {
    let handle: FileSystemFileHandle;
    try {
      handle = await fsWindow().showSaveFilePicker!({ types: PICKER_TYPES, suggestedName: app.configName() });
    } catch {
      return; // cancelled
    }
    await writeHandle(handle, text);
    app.setSource({ kind: 'handle', handle });
    app.setConfigName(handle.name);
    pushRecent({ name: handle.name, kind: 'handle', openedAt: Date.now() });
    await storeFile({ name: handle.name, kind: 'handle' }, handle);
    return;
  }
  download(text, app.configName());
}
