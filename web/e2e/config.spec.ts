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
import { expect, test } from '@playwright/test';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import YAML from 'yaml';
import { OPEN_FILE, SERVER_CONFIG, configName, expectLastDisplays, forwardBrowserErrors, menuItem, openApp, openMenu, pickWithFallbackDialog, recentItem, withoutFileSystemAccess } from './helpers';

type Doc = { Panels?: { Class: string }[]; 'Visualization Manager'?: { Displays?: { Name: string }[] }; 'WebRvizLite Layout'?: unknown };
const parse = (text: string) => YAML.parse(text) as Doc;
const displayNames = (doc: Doc) => (doc['Visualization Manager']?.Displays ?? []).map((d) => d.Name);

test.beforeEach(({ page }) => forwardBrowserErrors(page));

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
