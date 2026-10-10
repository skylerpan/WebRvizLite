import { defineConfig } from '@playwright/test';

/**
 * E2E tests drive the real app in Google Chrome against the mock server.
 * `make test-e2e` builds the server first; `E2E_SERVER_BIN` points at another
 * binary, `E2E_BASE_URL` at an already running frontend (e.g. the production
 * build served by the Rust server), `E2E_CHANNEL` picks another browser channel.
 */
const CI = !!process.env.CI;

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results',
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: CI ? 1 : 0,
  reporter: CI ? 'github' : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    channel: process.env.E2E_CHANNEL ?? 'chrome',
    headless: true,
    viewport: { width: 1400, height: 900 },
    acceptDownloads: true,
    // Traces of this WebGL-heavy page come out truncated and then fail the test themselves;
    // failures keep the console output (see config.spec.ts) and the page snapshot instead.
    trace: 'off',
    screenshot: 'only-on-failure',
    launchOptions: {
      // Headless Chrome has no GPU; three.js falls back to WebGL2 on SwiftShader.
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    },
  },
  webServer: [
    {
      command: 'node e2e/start-server.mjs',
      url: 'http://127.0.0.1:8765/api/health',
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'npx vite --port 5173 --strictPort',
      url: 'http://localhost:5173',
      reuseExistingServer: !CI,
      timeout: 60_000,
    },
  ],
});
