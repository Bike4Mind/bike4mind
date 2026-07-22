/**
 * Copy the HiGHS solver WASM binary to the public directory.
 *
 * The b4m-optihashi premium overlay loads highs.wasm as a plain same-origin static asset:
 * its emscripten glue fetches `${location.origin}/highs.wasm`. Copying the wasm straight out
 * of the installed `highs` package guarantees the served binary always matches the `highs`
 * version resolved in node_modules, so the glue and the wasm can never drift. A mismatch
 * aborts instantiation with a WebAssembly LinkError (e.g. "Import #N requires a callable"),
 * which is exactly what a stale hand-copied binary caused.
 *
 * No-op when `highs` is not installed (open-core installs without the overlay). Runs via
 * pnpm postinstall / predev / prebuild so the binary is always present and current.
 */

import { copyFileSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WASM_FILE = 'highs.wasm';

function resolveHighsWasm() {
  // highs does not export ./package.json, so resolve the package entry (which lives in the
  // build/ dir) and take the wasm sitting next to it. Search the workspace store + repo root
  // so it resolves under pnpm's nested node_modules from the client package context.
  const repoRoot = path.resolve(__dirname, '../../..');
  let entry;
  try {
    entry = require.resolve('highs', {
      paths: [path.join(repoRoot, 'node_modules/.pnpm/node_modules'), repoRoot, __dirname],
    });
  } catch {
    return null; // highs not installed (overlay absent) -> nothing to serve
  }
  return path.join(path.dirname(entry), WASM_FILE);
}

function main() {
  const source = resolveHighsWasm();
  if (!source) {
    console.log('[copy-highs-wasm] highs not installed - skipping');
    return;
  }

  const destinationDir = path.resolve(__dirname, '../public');
  const destination = path.join(destinationDir, WASM_FILE);

  mkdirSync(destinationDir, { recursive: true });
  copyFileSync(source, destination);

  console.log(`[copy-highs-wasm] Copied ${WASM_FILE} -> public/${WASM_FILE}`);
}

try {
  main();
} catch (error) {
  console.error('[copy-highs-wasm] Failed to copy highs.wasm:', error);
  process.exit(1);
}
