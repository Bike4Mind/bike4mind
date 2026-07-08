/**
 * Self-host entrypoint shim for the always-on chatCompletion server.
 *
 * The server (`server.ts` -> `@server/utils/config`) does `import { Resource } from 'sst'`
 * and reads `Resource.*` at module-load time. In the hosted image SST injects those values;
 * the Next app resolves them via a turbopack build alias (`sst` -> `@bike4mind/resource`).
 * A plain `tsx`-run standalone server gets neither, so `import 'sst'` would hit the real SST
 * package and throw "It does not look like SST links are active".
 *
 * This module is loaded ONLY by the self-host container's CMD via `tsx --import`. It aliases
 * the bare specifier `sst` to the env-backed `@bike4mind/resource` shim - the runtime
 * equivalent of the app's build-time alias, scoped to this process so the cloud image (real
 * SST) is untouched.
 *
 * Both module systems are covered because tsx transpiles TS to CommonJS and loads it via
 * `require()`, so the ESM `module.register` resolve hook alone does NOT catch `sst`:
 *   - CJS: monkeypatch `Module._resolveFilename` (what tsx's compiled `require('sst')` hits).
 *   - ESM: register a resolve hook (for any genuinely ESM importer).
 */
import Module from 'node:module';
import { register } from 'node:module';

const ALIAS_FROM = 'sst';
const ALIAS_TO = '@bike4mind/resource';

// CJS path (tsx transpiles the server + its imports to CommonJS `require`).
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return originalResolveFilename.call(this, request === ALIAS_FROM ? ALIAS_TO : request, ...rest);
};

// ESM path (any importer that stays ESM).
register('./sstResolveHook.mjs', import.meta.url);
