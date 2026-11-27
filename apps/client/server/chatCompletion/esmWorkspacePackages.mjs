/**
 * Loads every `@bike4mind/*` package as its ESM build, including from CommonJS `require()`.
 *
 * tsx runs apps/client (no `"type"`) as CommonJS, so a plain `require('@bike4mind/x')` picks the
 * package's `dist/*.cjs` build, while ESM-only `@bike4mind/database` and the `"type": "module"`
 * server-utils sources import the `dist/*.mjs` builds. The result is two instances of each dual
 * package in one process, and module-level state set on one is invisible to the other: connectDB
 * wires the model-catalog and price providers into the ESM llm-adapters while cliCompletions reads
 * the CJS one, so DB-only catalog models fail as unknown and billing loses the price overlay.
 *
 * Resolving with the `import` condition makes `require()` load the same `.mjs` module record the
 * ESM loader holds (Node's require(esm)), so each package has exactly one instance. Scoped to the
 * workspace scope: third-party dual packages keep Node's default resolution. Resolution only runs
 * at module load, so this adds no per-request work.
 *
 * Preloaded by every self-host tsx process via selfhostSstAlias.mjs. server.ts's
 * checkModelCatalogWired logs loudly in any process where the split is still present.
 */
import Module from 'node:module';

const WORKSPACE_SCOPE = '@bike4mind/';
const ESM_CONDITIONS = new Set(['node', 'import', 'module-sync', 'default']);

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  // Overrides caller-supplied conditions too: under module.registerHooks Node passes the CJS set on every require.
  if (typeof request === 'string' && request.startsWith(WORKSPACE_SCOPE)) {
    try {
      return originalResolveFilename.call(this, request, parent, isMain, { ...options, conditions: ESM_CONDITIONS });
    } catch {
      // A subpath exported only under `require` falls through to the default resolution.
    }
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};
