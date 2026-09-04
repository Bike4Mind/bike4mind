/**
 * Single source of truth for locating the installed `highs` WASM binary.
 *
 * Two deploy surfaces need this same path and would otherwise each hard-code it:
 *  - the browser bundle (apps/client/scripts/copy-highs-wasm.mjs -> public/highs.wasm)
 *  - the plain SST Lambdas that can execute the premium tool set (infra/toolRuntimeAssets.ts)
 *
 * The remaining two are covered for free and need nothing from here: the Next.js server and
 * the ChatCompletion container both ship real node_modules.
 *
 * Resolving from the installed package rather than a committed path is what keeps the
 * emscripten glue and the binary on the same version. A mismatch aborts instantiation with
 * a WebAssembly LinkError, which is exactly what a stale hand-copied binary once caused.
 */

import path from 'path';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);

const WASM_FILE = 'highs.wasm';

/**
 * Default repo root: this file lives in `<root>/scripts`.
 *
 * Only correct while this module is executed from source, which is true for the pnpm scripts.
 * Callers running inside a bundle (SST evaluates sst.config.ts as one) must pass their own
 * root instead - see infra/toolRuntimeAssets.ts, which passes `$cli.paths.root`.
 */
const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Absolute path to the installed `highs.wasm`, or null when `highs` is not installed.
 *
 * `highs` ships with the b4m-optihashi premium overlay, not with open-core, so null is a
 * normal result and every caller must treat it as a quiet no-op rather than an error.
 *
 * @param {string} [repoRoot]
 * @returns {string | null}
 */
export function resolveHighsWasm(repoRoot = DEFAULT_REPO_ROOT) {
  // highs does not export ./package.json, so resolve the package entry (which lives in the
  // build/ dir) and take the wasm sitting next to it. Search the workspace store + repo root
  // so it resolves regardless of which package context is asking.
  let entry;
  try {
    entry = require.resolve('highs', {
      paths: [
        path.join(repoRoot, 'node_modules/.pnpm/node_modules'),
        // The overlay engine is what declares highs; resolve from it too so a change in
        // hoisting does not silently break the copy.
        path.join(repoRoot, 'packages/premium/optihashi/engine'),
        // The client is where the browser copy has always resolved it from; keep that root
        // so a hoisting change cannot regress the surface that works today.
        path.join(repoRoot, 'apps/client'),
        repoRoot,
      ],
    });
  } catch {
    return null; // highs not installed (overlay absent)
  }
  return path.join(path.dirname(entry), WASM_FILE);
}

/**
 * Whether the b4m-optihashi overlay is hydrated into this checkout.
 *
 * Lets callers tell the two very different "no highs.wasm" cases apart: an open-core install
 * (expected, skip quietly) versus a hydrated overlay whose highs did not resolve (a real
 * misconfiguration that would ship a solver which aborts at runtime).
 *
 * @param {string} [repoRoot]
 * @returns {boolean}
 */
export function isOptihashiOverlayPresent(repoRoot = DEFAULT_REPO_ROOT) {
  return existsSync(path.join(repoRoot, 'packages/premium/optihashi'));
}
