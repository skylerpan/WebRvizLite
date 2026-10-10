// Starts the mock server for the E2E tests with a scratch copy of fixtures/default.rviz (Grid
// only: cheap to render in software) as its `-d` config, so the Save test can write to it
// without touching fixtures/.
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const tmpDir = join(here, '.tmp');
mkdirSync(tmpDir, { recursive: true });
export const CONFIG_PATH = join(tmpDir, 'server.rviz');
copyFileSync(join(repoRoot, 'fixtures/default.rviz'), CONFIG_PATH);

// E2E_SERVER_BIN is relative to where `npm run test:e2e` was started (web/), not to the server's cwd.
const bin = process.env.E2E_SERVER_BIN ? resolve(process.cwd(), process.env.E2E_SERVER_BIN) : join(repoRoot, 'target-host/release/webrvizlite');
const port = process.env.E2E_SERVER_PORT ?? '8765';
// cwd = repo root: `--mock` registers package://webrvizlite_fixtures as <cwd>/fixtures.
const child = spawn(bin, ['--mock', '--port', port, '--no-webtransport', '-d', CONFIG_PATH], { cwd: repoRoot, stdio: 'inherit' });
child.on('error', (e) => {
  console.error(`[e2e] cannot start ${bin}: ${e.message}\n[e2e] build it with \`make build CARGO_TARGET_DIR=target-host\` or set E2E_SERVER_BIN`);
  process.exit(1);
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig));
