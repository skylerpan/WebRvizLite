// @vitest-environment jsdom
/**
 * Open / Save / Save As / Recent Configs on both browser paths: the File System
 * Access API (stubbed pickers) and the <input type=file> / download fallback used
 * in insecure contexts (http://<LAN IP>), which is where the Open bug lived.
 */
import { File as NodeFile } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasFileSystemAccess, openConfig, openRecent, recentConfigs, saveConfig, saveConfigAs, type ConfigSource, type RecentEntry } from './configIO';
import type { AppStore } from './store';

const RECENT_KEY = 'webrvizlite.recentConfigs';
const YAML_TEXT = 'Panels: []\nVisualization Manager:\n  Displays: []\n';

interface FakeApp {
  app: AppStore;
  loaded: { text: string; name: string }[];
  sources: ConfigSource[];
  names: string[];
  startup: { path: string | null; opts: unknown }[];
  source: ConfigSource;
  displayConfig: string | null;
}

function fakeApp(source: ConfigSource = { kind: 'embedded' }, configName = 'default.rviz'): FakeApp {
  const f: FakeApp = { loaded: [], sources: [], names: [], startup: [], source, displayConfig: null, app: null as never };
  f.app = {
    loadConfigText: (text: string, name: string) => f.loaded.push({ text, name }),
    setSource: (s: ConfigSource) => { f.sources.push(s); f.source = s; },
    source: () => f.source,
    configName: () => configName,
    setConfigName: (n: string) => f.names.push(n),
    saveConfigText: () => YAML_TEXT,
    bridge: { hello: () => (f.displayConfig ? { display_config: f.displayConfig } : { display_config: null }) },
    loadStartupConfig: async (path: string | null, opts: unknown) => { f.startup.push({ path, opts }); },
  } as never;
  return f;
}

/** A File the test can hand to the app (Node's File has `text()`; jsdom's may not). */
const makeFile = (name: string, text = YAML_TEXT) => new NodeFile([text], name, { type: 'application/yaml' }) as unknown as File;

interface FakeHandle extends FileSystemFileHandle {
  written: string[];
  permission: string;
}
function fakeHandle(name: string, text = YAML_TEXT): FakeHandle {
  const h = {
    kind: 'file',
    name,
    written: [] as string[],
    permission: 'granted',
    getFile: async () => makeFile(name, text),
    createWritable: async () => ({ write: async (d: string) => { h.written.push(d); }, close: async () => {} }),
    requestPermission: async () => h.permission,
  };
  return h as unknown as FakeHandle;
}

/**
 * The slice of IndexedDB that configIO uses, in memory. Values keep their identity
 * (browsers clone FileSystemFileHandles natively; a fake handle with methods would
 * not survive a real structured clone).
 */
function memoryIndexedDb() {
  const store = new Map<string, unknown>();
  type Req = { result: unknown; error: null; onsuccess: null | (() => void); onerror: null | (() => void); onupgradeneeded?: null | (() => void) };
  const request = (result: unknown): Req => {
    const req: Req = { result, error: null, onsuccess: null, onerror: null };
    queueMicrotask(() => req.onsuccess?.());
    return req;
  };
  const db = {
    createObjectStore() {},
    close() {},
    transaction() {
      const tx = {
        error: null,
        oncomplete: null as null | (() => void),
        onerror: null,
        onabort: null,
        objectStore: () => ({
          put: (value: unknown, key: string) => {
            store.set(key, value);
            queueMicrotask(() => tx.oncomplete?.());
            return request(key);
          },
          get: (key: string) => request(store.get(key)),
        }),
      };
      return tx;
    },
  };
  const factory = {
    open() {
      const req: Req = { result: db, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      queueMicrotask(() => {
        req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
  return { store, factory };
}

const win = window as unknown as { showOpenFilePicker?: unknown; showSaveFilePicker?: unknown };
const flush = () => new Promise((r) => setTimeout(r, 0));

let idb: ReturnType<typeof memoryIndexedDb>;
beforeEach(() => {
  localStorage.clear();
  idb = memoryIndexedDb();
  vi.stubGlobal('indexedDB', idb.factory);
  delete win.showOpenFilePicker;
  delete win.showSaveFilePicker;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

/** Replaces the native file dialog: the picked files land on the input and `change` fires (or `cancel`). */
function stubFileDialog(pick: File[] | null) {
  const seen: { connected: boolean; accept: string }[] = [];
  vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
    seen.push({ connected: this.isConnected, accept: this.accept });
    setTimeout(() => {
      if (pick) {
        Object.defineProperty(this, 'files', { value: pick, configurable: true });
        this.dispatchEvent(new Event('change'));
      } else {
        this.dispatchEvent(new Event('cancel'));
      }
    }, 0);
  });
  return seen;
}

describe('openConfig without the File System Access API (http://<LAN IP>)', () => {
  it('reports the API as missing', () => {
    expect(hasFileSystemAccess()).toBe(false);
  });

  it('keeps the hidden <input type=file> in the document while the dialog is open, then loads the picked file', async () => {
    const f = fakeApp();
    const seen = stubFileDialog([makeFile('scene.rviz')]);
    await openConfig(f.app);
    // A detached input is garbage-collected while the native dialog is open and `change` never fires.
    expect(seen).toEqual([{ connected: true, accept: '.rviz,.yaml,.yml' }]);
    expect(f.loaded).toEqual([{ text: YAML_TEXT, name: 'scene.rviz' }]);
    expect(f.sources).toEqual([{ kind: 'download', name: 'scene.rviz' }]);
    expect(document.querySelectorAll('input[type=file]')).toHaveLength(0);
  });

  it('adds the file to Recent Configs as a snapshot and stores it for openRecent', async () => {
    const f = fakeApp();
    stubFileDialog([makeFile('scene.rviz', 'Panels: [a]\n')]);
    await openConfig(f.app);
    const recent = recentConfigs();
    expect(recent.map((r) => [r.name, r.kind])).toEqual([['scene.rviz', 'file']]);
    expect(idb.store.get('file:scene.rviz')).toEqual({ name: 'scene.rviz', text: 'Panels: [a]\n' });

    const again = fakeApp({ kind: 'server', path: 'x.rviz' });
    await openRecent(again.app, recent[0]);
    expect(again.loaded).toEqual([{ text: 'Panels: [a]\n', name: 'scene.rviz' }]);
    expect(again.source).toEqual({ kind: 'download', name: 'scene.rviz' });
  });

  it('loads nothing and removes the input when the dialog is cancelled', async () => {
    const f = fakeApp();
    stubFileDialog(null);
    await openConfig(f.app);
    expect(f.loaded).toEqual([]);
    expect(f.sources).toEqual([]);
    expect(recentConfigs()).toEqual([]);
    expect(document.querySelectorAll('input')).toHaveLength(0);
  });

  it('a second Open while a dialog is pending replaces the first input', async () => {
    const f = fakeApp();
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    const first = openConfig(f.app);
    const second = openConfig(f.app);
    const inputs = document.querySelectorAll('input[type=file]');
    expect(inputs).toHaveLength(1);
    inputs[0].dispatchEvent(new Event('cancel'));
    await second;
    expect(document.querySelectorAll('input')).toHaveLength(0);
    void first; // never settles: its input was removed, like a dialog the browser closed
  });
});

describe('openConfig with the File System Access API', () => {
  it('loads through the handle, remembers it and lists it in Recent Configs', async () => {
    const h = fakeHandle('robot.rviz', 'Panels: [h]\n');
    win.showOpenFilePicker = vi.fn(async () => [h]);
    expect(hasFileSystemAccess()).toBe(true);
    const f = fakeApp();
    await openConfig(f.app);
    expect(win.showOpenFilePicker).toHaveBeenCalledWith(expect.objectContaining({ multiple: false }));
    expect(f.loaded).toEqual([{ text: 'Panels: [h]\n', name: 'robot.rviz' }]);
    expect(f.source).toEqual({ kind: 'handle', handle: h });
    expect(recentConfigs().map((r) => [r.name, r.kind])).toEqual([['robot.rviz', 'handle']]);

    expect(idb.store.get('robot.rviz')).toBe(h);

    const again = fakeApp();
    await openRecent(again.app, recentConfigs()[0]);
    expect(win.showOpenFilePicker).toHaveBeenCalledTimes(1); // reopened through the stored handle, not the picker
    expect(again.loaded).toEqual([{ text: 'Panels: [h]\n', name: 'robot.rviz' }]);
    expect(again.source).toEqual({ kind: 'handle', handle: h });
  });

  it('a cancelled picker loads nothing', async () => {
    win.showOpenFilePicker = vi.fn(async () => { throw new DOMException('cancelled', 'AbortError'); });
    const f = fakeApp();
    await openConfig(f.app);
    expect(f.loaded).toEqual([]);
    expect(recentConfigs()).toEqual([]);
  });
});

describe('openRecent', () => {
  it('server entry reloads the -d config even when another config is open', async () => {
    const f = fakeApp({ kind: 'download', name: 'other.rviz' });
    f.displayConfig = '/cfg/a.rviz';
    await openRecent(f.app, { name: 'a.rviz', kind: 'server', openedAt: 1 });
    expect(f.startup).toEqual([{ path: '/cfg/a.rviz', opts: { force: true } }]);
  });

  it('server entry fails loudly when the server has no -d config', async () => {
    const f = fakeApp();
    await expect(openRecent(f.app, { name: 'a.rviz', kind: 'server', openedAt: 1 })).rejects.toThrow(/-d/);
    expect(f.startup).toEqual([]);
  });

  it('falls back to the picker when the stored file is gone', async () => {
    const f = fakeApp();
    const seen = stubFileDialog([makeFile('new.rviz')]);
    await openRecent(f.app, { name: 'gone.rviz', kind: 'file', openedAt: 1 });
    expect(seen).toHaveLength(1);
    expect(f.loaded.map((l) => l.name)).toEqual(['new.rviz']);
  });

  it('a handle whose write permission is denied loads nothing', async () => {
    const h = fakeHandle('robot.rviz');
    win.showOpenFilePicker = vi.fn(async () => [h]);
    const f = fakeApp();
    await openConfig(f.app);
    h.permission = 'denied';
    const again = fakeApp();
    await openRecent(again.app, recentConfigs()[0]);
    expect(again.loaded).toEqual([]);
  });
});

describe('recentConfigs', () => {
  const entry = (name: string, kind: RecentEntry['kind']): RecentEntry => ({ name, kind, openedAt: 1 });

  it('survives corrupt storage', () => {
    localStorage.setItem(RECENT_KEY, '{not json');
    expect(recentConfigs()).toEqual([]);
    localStorage.setItem(RECENT_KEY, '{"a":1}');
    expect(recentConfigs()).toEqual([]);
  });

  it('dedupes by name and kind, newest first, capped at 10', async () => {
    localStorage.setItem(RECENT_KEY, JSON.stringify([entry('scene.rviz', 'handle'), ...Array.from({ length: 9 }, (_, i) => entry(`old${i}.rviz`, 'file'))]));
    stubFileDialog([makeFile('scene.rviz')]);
    await openConfig(fakeApp().app);
    let list = recentConfigs();
    expect(list).toHaveLength(10);
    expect(list.slice(0, 2).map((r) => [r.name, r.kind])).toEqual([['scene.rviz', 'file'], ['scene.rviz', 'handle']]);
    expect(list.at(-1)!.name).toBe('old7.rviz');

    await saveConfig(fakeApp({ kind: 'server', path: 'p' }, 'scene.rviz').app).catch(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    await saveConfig(fakeApp({ kind: 'server', path: 'p' }, 'scene.rviz').app);
    list = recentConfigs();
    expect(list[0]).toMatchObject({ name: 'scene.rviz', kind: 'server' });
    expect(list.filter((r) => r.name === 'scene.rviz')).toHaveLength(3);
  });
});

describe('saveConfig', () => {
  it('server source: POSTs the YAML to /api/display-config', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const f = fakeApp({ kind: 'server', path: '/cfg/tier1.rviz' }, 'tier1.rviz');
    await saveConfig(f.app);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchMock.mock.calls[0] as unknown as [string, RequestInit]);
    expect(url).toBe('/api/display-config');
    expect(init).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/yaml' }, body: YAML_TEXT });
    expect(recentConfigs()[0]).toMatchObject({ name: 'tier1.rviz', kind: 'server' });
  });

  it('server source: a refused save throws with the server message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no display config (-d) given; use Save As', { status: 404 })));
    const f = fakeApp({ kind: 'server', path: '/cfg/tier1.rviz' });
    await expect(saveConfig(f.app)).rejects.toThrow(/404 no display config/);
    expect(recentConfigs()).toEqual([]);
  });

  it('handle source: writes through the handle', async () => {
    const h = fakeHandle('robot.rviz');
    const f = fakeApp({ kind: 'handle', handle: h }, 'robot.rviz');
    await saveConfig(f.app);
    expect(h.written).toEqual([YAML_TEXT]);
    expect(recentConfigs()[0]).toMatchObject({ name: 'robot.rviz', kind: 'handle' });
  });

  it('embedded / download source without the API: downloads the file through an attached anchor', async () => {
    vi.useFakeTimers();
    const urls = { created: 0, revoked: [] as string[] };
    vi.stubGlobal('URL', Object.assign(URL, {
      createObjectURL: vi.fn(() => { urls.created++; return 'blob:webrvizlite/1'; }),
      revokeObjectURL: vi.fn((u: string) => { urls.revoked.push(u); }),
    }));
    const clicks: { connected: boolean; download: string; href: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push({ connected: this.isConnected, download: this.download, href: this.href });
    });
    const f = fakeApp({ kind: 'download', name: 'scene.rviz' }, 'scene.rviz');
    await saveConfig(f.app);
    expect(clicks).toEqual([{ connected: true, download: 'scene.rviz', href: 'blob:webrvizlite/1' }]);
    expect(urls.created).toBe(1);
    // The URL stays valid until the browser has started the download.
    expect(urls.revoked).toEqual([]);
    expect(document.querySelectorAll('a')).toHaveLength(1);
    vi.runAllTimers();
    expect(urls.revoked).toEqual(['blob:webrvizlite/1']);
    expect(document.querySelectorAll('a')).toHaveLength(0);
  });
});

describe('saveConfigAs with the File System Access API', () => {
  it('writes to the chosen handle and makes it the current source', async () => {
    const h = fakeHandle('copy.rviz');
    win.showOpenFilePicker = vi.fn();
    win.showSaveFilePicker = vi.fn(async () => h);
    const f = fakeApp({ kind: 'server', path: '/cfg/tier1.rviz' }, 'tier1.rviz');
    await saveConfigAs(f.app);
    expect(win.showSaveFilePicker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: 'tier1.rviz' }));
    expect(h.written).toEqual([YAML_TEXT]);
    expect(f.source).toEqual({ kind: 'handle', handle: h });
    expect(f.names).toEqual(['copy.rviz']);
    expect(recentConfigs()[0]).toMatchObject({ name: 'copy.rviz', kind: 'handle' });
    await flush();
  });

  it('a cancelled picker changes nothing', async () => {
    win.showOpenFilePicker = vi.fn();
    win.showSaveFilePicker = vi.fn(async () => { throw new DOMException('cancelled', 'AbortError'); });
    const f = fakeApp({ kind: 'server', path: '/cfg/tier1.rviz' });
    await saveConfigAs(f.app);
    expect(f.sources).toEqual([]);
    expect(f.names).toEqual([]);
  });
});
