/**
 * Copy the HiGHS solver WASM binary to the public directory.
 *
 * The b4m-optihashi premium overlay loads highs.wasm as a plain same-origin static asset:
 * its emscripten glue fetches `${location.origin}/highs.wasm`. Copying the wasm straight out
 * of the installed `highs` package guarantees the served binary always matches the `highs`
 * version resolved in node_modules, so the glue and the wasm can never drift.
 *
 * No-op when `highs` is not installed (open-core installs without the overlay). Runs via
 * pnpm postinstall / predev / prebuild so the binary is always present and current.
 *
 * The path itself comes from scripts/resolve-highs-wasm.mjs, shared with infra/ so the
 * browser and the Lambda bundles cannot disagree about where the binary lives.
 */

import { copyFileSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { resolveHighsWasm, isOptihashiOverlayPresent } from '../../../scripts/resolve-highs-wasm.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WASM_FILE = 'highs.wasm';

function main() {
  const source = resolveHighsWasm();
  if (!source) {
    // highs is pulled in by the b4m-optihashi overlay. Legitimately absent on open-core
    // installs (quiet skip). But if the overlay IS present and highs still will not resolve,
    // that is a real problem - the overlay would boot to a 404 wasm at runtime - so warn loudly.
    if (isOptihashiOverlayPresent()) {
      console.warn('[copy-highs-wasm] overlay present but highs did not resolve - public/highs.wasm will be MISSING at runtime');
    } else {
      console.log('[copy-highs-wasm] highs not installed (no overlay) - skipping');
    }
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
