/// <reference types="vitest/config" />
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';
import solid from 'vite-plugin-solid';

/**
 * `<repo version>+g<short sha>[.dirty]`, like the Rust crates' build scripts. The
 * repo version is `[workspace.package] version` in the root Cargo.toml, the one
 * place it is defined.
 */
function buildVersion(): string {
  const cargo = readFileSync(new URL('../Cargo.toml', import.meta.url), 'utf8');
  const pkg = /\[workspace\.package\][^[]*?^version\s*=\s*"([^"]+)"/ms.exec(cargo)?.[1];
  if (!pkg) throw new Error('vite.config.ts: no [workspace.package] version in ../Cargo.toml');
  try {
    const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const sha = git('rev-parse', '--short=9', 'HEAD');
    const dirty = git('status', '--porcelain', '--untracked-files=no') !== '';
    return `${pkg}+g${sha}${dirty ? '.dirty' : ''}`;
  } catch {
    return pkg; // not a git checkout
  }
}

export default defineConfig({
  plugins: [solid()],
  define: {
    __WRL_VERSION__: JSON.stringify(buildVersion()),
  },
  build: {
    // Needed for top-level await in the wasm-pack output and WASM ESM integration.
    target: 'es2022',
    // three.js alone is ~1 MB minified; the single-chunk warning is expected.
    chunkSizeWarningLimit: 1500,
  },
  worker: {
    format: 'es',
  },
  test: {
    // Playwright specs live in e2e/ and are run by `npm run test:e2e`.
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
  server: {
    port: 5173,
    fs: { allow: ['..'] },
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:8765', ws: true },
      '/api': { target: 'http://127.0.0.1:8765' },
    },
  },
});
