/** Shared helpers for the E2E specs: app startup, menus, the virtualised Displays tree. */
import { expect, type Page } from '@playwright/test';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = resolve(here, '../../fixtures');
/** The mock server's `-d` file (a scratch copy of fixtures/default.rviz, see start-server.mjs). */
export const SERVER_CONFIG = join(here, '.tmp/server.rviz');
export const OPEN_FILE = join(FIXTURES, 'nav2_default_view.rviz');

export const configName = (page: Page) => page.locator('.wrl-config-name');
export const displaysPanel = (page: Page) => page.locator('[data-displays-panel]');

/** Removes the File System Access API before the app loads: what every http://<LAN IP> origin looks like. */
export const withoutFileSystemAccess = (page: Page) =>
  page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    delete w.showOpenFilePicker;
    delete w.showSaveFilePicker;
  });

/** Browser-side failures end up in the test output instead of only in the trace. */
export function forwardBrowserErrors(page: Page) {
  page.on('pageerror', (e) => console.log(`[page error] ${e.message}`));
  page.on('console', (m) => {
    const noise = /WebGL|GL_INVALID|AttributeNode|No available adapters/;
    if ((m.type() === 'error' || m.type() === 'warning') && !noise.test(m.text())) console.log(`[console.${m.type()}] ${m.text()} ${m.location().url}`);
  });
}

/**
 * The Displays tree is virtualized (only the rows in view exist), so a display is
 * checked where it sits: scrolled to the end of the tree. server.rviz has only Grid,
 * nav2_default_view.rviz ends with MarkerArray.
 */
export async function expectLastDisplays(page: Page, has: string, hasNot?: string) {
  const tree = displaysPanel(page).locator('.wrl-tree');
  await expect.poll(async () => {
    // The scroll event that drives the virtualizer is dispatched with the next rendered frame,
    // which software-rendered headless Chrome may delay for seconds; fire it right away.
    await tree.evaluate((el) => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); });
    return tree.textContent();
  }).toContain(has);
  if (hasNot) await expect(tree).not.toContainText(hasNot);
}

export async function openApp(page: Page) {
  await page.goto('/');
  await expect(configName(page)).toHaveText('server.rviz');
  await expectLastDisplays(page, 'Grid', 'MarkerArray');
}

export async function openMenu(page: Page, label: string) {
  await page.getByRole('menubar').getByRole('button', { name: label, exact: true }).click();
  await expect(page.locator('.wrl-menu-dropdown')).toBeVisible();
}

/** A top-level dropdown item by label (`.wrl-menu-sub` items are submenu entries). */
export const menuItem = (page: Page, label: string | RegExp) => page.locator('.wrl-menu-dropdown .wrl-menu-item:not(.wrl-menu-sub)', { has: page.locator('.wrl-menu-label', { hasText: label }) });
export const recentItem = (page: Page, name: string) => page.locator('.wrl-menu-dropdown .wrl-menu-sub', { hasText: name });

/**
 * Picks a file in the fallback <input type=file> the way a user does. Playwright's own
 * `filechooser` event cannot be used: it holds an element handle, which keeps a detached
 * input alive and hides the bug. Raw CDP only knows the node id, so a GC between opening
 * the dialog and choosing the file (the time a user spends in the dialog) collects an
 * input that nothing references, and `DOM.setFileInputFiles` then has no node to set.
 */
export async function pickWithFallbackDialog(page: Page, trigger: () => Promise<void>, file: string) {
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

/** The tree row whose name cell reads exactly `name` (rows are virtualised: expand parents first). */
export const treeRow = (page: Page, name: string) => displaysPanel(page).locator('.wrl-row', { has: page.locator('.wrl-name', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}$`) }) });

/** Expands a collapsed tree row by its expander. */
export async function expandRow(page: Page, name: string) {
  const row = treeRow(page, name).first();
  const expander = row.locator('.wrl-expander');
  if ((await expander.textContent())?.trim() === '▸') await expander.click();
}

/** Closes floating display panels (Image / Camera) that would cover the Displays tree. */
export async function closeFloatingPanels(page: Page) {
  const close = page.locator('.dv-floating-overlay-host button[aria-label^="Close"]');
  for (let i = 0; i < 10 && (await close.count()) > 0; i++) await close.first().click();
  await expect(close).toHaveCount(0);
}
