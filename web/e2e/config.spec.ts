/**
 * Open / Save / Save As / Recent Configs in a real Chrome against the mock server.
 *
 * The server starts with a scratch copy of fixtures/default.rviz as `server.rviz`
 * (see start-server.mjs) and the tests open fixtures/nav2_default_view.rviz; both
 * are cheap to render, which matters in software-rendered headless Chrome. Tests
 * cover the two browser paths: the <input type=file> / download fallback that
 * non-secure origins (http://<LAN IP>) get, and the File System Access API,
 * stubbed because its pickers are native dialogs.
 */
import { expect, test, type Page } from '@playwright/test';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(here, '../../fixtures');
const SERVER_CONFIG = join(here, '.tmp/server.rviz');
const OPEN_FILE = join(FIXTURES, 'nav2_default_view.rviz');

type Doc = { Panels?: { Class: string }[]; 'Visualization Manager'?: { Displays?: { Name: string }[] }; 'WebRvizLite Layout'?: unknown };
const parse = (text: string) => YAML.parse(text) as Doc;
const displayNames = (doc: Doc) => (doc['Visualization Manager']?.Displays ?? []).map((d) => d.Name);
const configName = (page: Page) => page.locator('.wrl-config-name');
const displaysPanel = (page: Page) => page.locator('[data-displays-panel]');

/** Removes the File System Access API before the app loads: what every http://<LAN IP> origin looks like. */
const withoutFileSystemAccess = (page: Page) =>
  page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    delete w.showOpenFilePicker;
    delete w.showSaveFilePicker;
  });

/** Browser-side failures end up in the test output instead of only in the trace. */
test.beforeEach(({ page }) => {
  page.on('pageerror', (e) => console.log(`[page error] ${e.message}`));
  page.on('console', (m) => {
    const noise = /WebGL|GL_INVALID|AttributeNode|No available adapters/;
    if ((m.type() === 'error' || m.type() === 'warning') && !noise.test(m.text())) console.log(`[console.${m.type()}] ${m.text()} ${m.location().url}`);
  });
});

/**
 * The Displays tree is virtualized (only the rows in view exist), so a display is
 * checked where it sits: scrolled to the end of the tree. server.rviz has only Grid,
 * nav2_default_view.rviz ends with MarkerArray.
 */
async function expectLastDisplays(page: Page, has: string, hasNot?: string) {
  const tree = displaysPanel(page).locator('.wrl-tree');
  await expect.poll(async () => {
    // The scroll event that drives the virtualizer is dispatched with the next rendered frame,
    // which software-rendered headless Chrome may delay for seconds; fire it right away.
    await tree.evaluate((el) => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); });
    return tree.textContent();
  }).toContain(has);
  if (hasNot) await expect(tree).not.toContainText(hasNot);
}

async function openApp(page: Page) {
  await page.goto('/');
  await expect(configName(page)).toHaveText('server.rviz');
  await expectLastDisplays(page, 'Grid', 'MarkerArray');
}

async function openMenu(page: Page, label: string) {
  await page.getByRole('menubar').getByRole('button', { name: label, exact: true }).click();
  await expect(page.locator('.wrl-menu-dropdown')).toBeVisible();
}

/** A top-level dropdown item by label (`.wrl-menu-sub` items are submenu entries). */
const menuItem = (page: Page, label: string | RegExp) => page.locator('.wrl-menu-dropdown .wrl-menu-item:not(.wrl-menu-sub)', { has: page.locator('.wrl-menu-label', { hasText: label }) });
const recentItem = (page: Page, name: string) => page.locator('.wrl-menu-dropdown .wrl-menu-sub', { hasText: name });

/**
 * Picks a file in the fallback <input type=file> the way a user does. Playwright's own
 * `filechooser` event cannot be used: it holds an element handle, which keeps a detached
 * input alive and hides the bug. Raw CDP only knows the node id, so a GC between opening
 * the dialog and choosing the file (the time a user spends in the dialog) collects an
 * input that nothing references, and `DOM.setFileInputFiles` then has no node to set.
 */
async function pickWithFallbackDialog(page: Page, trigger: () => Promise<void>, file: string) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Page.enable');
  await cdp.send('DOM.enable');
  await cdp.send('HeapProfiler.enable');
  await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true });
  const opened = new Promise<{ backendNodeId: number }>((resolve) => cdp.once('Page.fileChooserOpened', (e) => resolve(e as { backendNodeId: number })));
  await trigger();
  const { backendNodeId } = await opened;
  for (let i = 0; i < 3; i++) await cdp.send('HeapProfiler.collectGarbage');
  await page.waitForTimeout(500);
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('DOM.setFileInputFiles', { files: [file], backendNodeId });
  await cdp.send('Page.setInterceptFileChooserDialog', { enabled: false });
  await cdp.detach();
}

test.describe('without the File System Access API (http://<LAN IP>)', () => {
  test.beforeEach(async ({ page }) => {
    await withoutFileSystemAccess(page);
    await openApp(page);
  });

  test('Ctrl+O opens a .rviz file picked in the browser dialog and lists it under Recent Configs', async ({ page }) => {
    await pickWithFallbackDialog(page, () => page.keyboard.press('Control+o'), OPEN_FILE);
    await expect(configName(page)).toHaveText('nav2_default_view.rviz');
    await expectLastDisplays(page, 'MarkerArray');
    await expect(page).toHaveTitle('nav2_default_view.rviz - WebRvizLite');

    await openMenu(page, 'File');
    await expect(recentItem(page, 'nav2_default_view.rviz')).toBeVisible();
  });

  test('File → Open Config… uses the same dialog', async ({ page }) => {
    await pickWithFallbackDialog(page, async () => {
      await openMenu(page, 'File');
      await menuItem(page, 'Open Config…').click();
    }, OPEN_FILE);
    await expect(configName(page)).toHaveText('nav2_default_view.rviz');
    await expectLastDisplays(page, 'MarkerArray');
  });

  test('Recent Configs reopens the file after a reload', async ({ page }) => {
    await pickWithFallbackDialog(page, () => page.keyboard.press('Control+o'), OPEN_FILE);
    await expect(configName(page)).toHaveText('nav2_default_view.rviz');
    await openMenu(page, 'File');
    await expect(recentItem(page, 'nav2_default_view.rviz')).toBeVisible();

    await page.reload();
    await expect(configName(page)).toHaveText('server.rviz');
    await expectLastDisplays(page, 'Grid', 'MarkerArray');
    await openMenu(page, 'File');
    await recentItem(page, 'nav2_default_view.rviz').click();
    await expect(configName(page)).toHaveText('nav2_default_view.rviz');
    await expectLastDisplays(page, 'MarkerArray');
  });

  test('Ctrl+Shift+S downloads the current config', async ({ page }) => {
    const download = page.waitForEvent('download');
    await page.keyboard.press('Control+Shift+s');
    const dl = await download;
    expect(dl.suggestedFilename()).toBe('server.rviz');
    const doc = parse(readFileSync((await dl.path())!, 'utf8'));
    expect(displayNames(doc)).toEqual(displayNames(parse(readFileSync(SERVER_CONFIG, 'utf8'))));
    expect(doc['WebRvizLite Layout']).toBeTruthy();
  });

  test('Ctrl+S on a file opened in the browser downloads it under its own name', async ({ page }) => {
    await pickWithFallbackDialog(page, () => page.keyboard.press('Control+o'), OPEN_FILE);
    await expect(configName(page)).toHaveText('nav2_default_view.rviz');
    const download = page.waitForEvent('download');
    await page.keyboard.press('Control+s');
    const dl = await download;
    expect(dl.suggestedFilename()).toBe('nav2_default_view.rviz');
    expect(displayNames(parse(readFileSync((await dl.path())!, 'utf8')))).toContain('Realsense');
  });
});

test.describe('server config (-d)', () => {
  test('Ctrl+S writes the layout change back to the server file', async ({ page }) => {
    const original = readFileSync(SERVER_CONFIG, 'utf8');
    const before = statSync(SERVER_CONFIG).mtimeMs;
    try {
      await withoutFileSystemAccess(page);
      await openApp(page);
      expect(parse(original).Panels!.map((p) => p.Class)).toContain('rviz_common/Views');

      await openMenu(page, 'Panels');
      await menuItem(page, /^Views$/).click();
      await page.keyboard.press('Control+s');

      await expect.poll(() => statSync(SERVER_CONFIG).mtimeMs, { timeout: 10_000 }).toBeGreaterThan(before);
      const saved = parse(readFileSync(SERVER_CONFIG, 'utf8'));
      expect(saved.Panels!.map((p) => p.Class)).not.toContain('rviz_common/Views');
      expect(saved.Panels!.map((p) => p.Class)).toContain('rviz_common/Displays');
      expect(displayNames(saved)).toEqual(displayNames(parse(original)));
      expect(saved['WebRvizLite Layout']).toBeTruthy();
    } finally {
      writeFileSync(SERVER_CONFIG, original);
    }
  });
});

test.describe('with the File System Access API (stubbed pickers)', () => {
  test('Ctrl+O loads through the handle, Ctrl+S writes back through it, Recent lists it', async ({ page }) => {
    const text = readFileSync(OPEN_FILE, 'utf8');
    await page.addInitScript(({ text }) => {
      const w = window as unknown as Record<string, unknown> & { __written: string[] };
      w.__written = [];
      const handle = {
        kind: 'file',
        name: 'nav2_default_view.rviz',
        getFile: async () => new File([text], 'nav2_default_view.rviz', { type: 'application/yaml' }),
        createWritable: async () => ({ write: async (d: string) => { w.__written.push(d); }, close: async () => {} }),
        requestPermission: async () => 'granted',
        queryPermission: async () => 'granted',
      };
      w.showOpenFilePicker = async () => [handle];
      w.showSaveFilePicker = async () => handle;
    }, { text });
    await openApp(page);

    await page.keyboard.press('Control+o');
    await expect(configName(page)).toHaveText('nav2_default_view.rviz');
    await expectLastDisplays(page, 'MarkerArray');

    await page.keyboard.press('Control+s');
    await expect.poll(() => page.evaluate(() => (window as unknown as { __written: string[] }).__written.length)).toBe(1);
    const written = await page.evaluate(() => (window as unknown as { __written: string[] }).__written[0]);
    expect(displayNames(parse(written))).toContain('Realsense');
    expect(parse(written)['WebRvizLite Layout']).toBeTruthy();

    await openMenu(page, 'File');
    await expect(recentItem(page, 'nav2_default_view.rviz')).toBeVisible();
  });
});
