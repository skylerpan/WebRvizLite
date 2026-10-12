/**
 * Displays panel editors: Topic and TF frame fields are editable combos whose ▾
 * lists every option regardless of the text already in the field.
 */
import { expect, test } from '@playwright/test';
import { OPEN_FILE, closeFloatingPanels, expandRow, expectLastDisplays, configName, forwardBrowserErrors, openApp, pickWithFallbackDialog, treeRow, withoutFileSystemAccess } from './helpers';

const MOCK_FRAMES = ['base_footprint', 'base_link', 'camera_link', 'camera_optical_frame', 'caster_front_link', 'laser', 'livox_frame', 'map', 'odom', 'wheel_left_link', 'wheel_right_link'];
const popup = (page: import('@playwright/test').Page) => page.locator('.wrl-combo-popup');
const popupOptions = async (page: import('@playwright/test').Page) => (await popup(page).locator('.wrl-combo-option').allTextContents()).map((t) => t.trim());

test.beforeEach(async ({ page }) => {
  forwardBrowserErrors(page);
  await withoutFileSystemAccess(page);
  await openApp(page);
});

test('Grid → Reference Frame ▾ lists <Fixed Frame> and every TF frame while the field still reads <Fixed Frame>', async ({ page }) => {
  await expandRow(page, 'Grid');
  const row = treeRow(page, 'Reference Frame');
  const input = row.locator('input[role=combobox]');
  await expect(input).toHaveValue('<Fixed Frame>');
  await row.locator('.wrl-combo-btn').click();
  await expect(popup(page)).toBeVisible();
  await expect.poll(() => popupOptions(page)).toEqual(['<Fixed Frame>', ...MOCK_FRAMES]);
  // Portalled to <body>: inside the viewport, not clipped by the panel.
  const box = (await popup(page).boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  await popup(page).locator('.wrl-combo-option', { hasText: /^base_link$/ }).click();
  await expect(popup(page)).toHaveCount(0);
  await expect(input).toHaveValue('base_link');
});

test('Global Options → Fixed Frame ▾ lists the mock frames without <Fixed Frame>', async ({ page }) => {
  const row = treeRow(page, 'Fixed Frame').first();
  await row.locator('.wrl-combo-btn').click();
  await expect.poll(() => popupOptions(page)).toEqual(MOCK_FRAMES);
  await page.keyboard.press('Escape');
  await expect(popup(page)).toHaveCount(0);
});

test('LaserScan → Topic ▾ lists /scan although /scan is already the value', async ({ page }) => {
  await pickWithFallbackDialog(page, () => page.keyboard.press('Control+o'), OPEN_FILE);
  await expect(configName(page)).toHaveText('nav2_default_view.rviz');
  await expectLastDisplays(page, 'MarkerArray');
  await closeFloatingPanels(page); // the Realsense Image panel floats over the Displays tree
  await page.locator('[data-displays-panel] .wrl-tree').evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
  await expandRow(page, 'LaserScan');
  const row = treeRow(page, 'Topic').first();
  const input = row.locator('input[role=combobox]');
  await expect(input).toHaveValue('/scan');
  await row.locator('.wrl-combo-btn').click();
  await expect.poll(() => popupOptions(page)).toEqual(['/scan']);
});
