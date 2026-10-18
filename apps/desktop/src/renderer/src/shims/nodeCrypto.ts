/**
 * Browser stand-in for the node:crypto helpers that the `@bike4mind/common` barrel pulls
 * in (createHash/createHmac, reached from artifactHelpers, anonymousSessionId and
 * lakeConfigAudit). The renderer is sandboxed with no node builtins, so that import has to
 * resolve to something or the bundle will not link at all.
 *
 * These throw instead of no-opping, which is the one way this differs from the
 * empty-module stubs apps/client registers in its turbopack resolveAlias: every current
 * caller is server-side and none runs at module scope, so nothing here executes today, and
 * a silently empty digest would be a correctness bug surfacing far from its cause.
 *
 * WebCrypto is not a drop-in replacement - subtle.digest is async and these are called
 * synchronously - so a renderer feature that genuinely needs a hash should compute it in
 * the main process and pass the result over IPC.
 */
const unavailable = (name: string): never => {
  throw new Error(
    `node:crypto ${name} is unavailable in the desktop renderer. ` +
      'Compute the hash in the main process and pass it over IPC.'
  );
};

export function createHash(_algorithm: string): never {
  return unavailable('createHash');
}

export function createHmac(_algorithm: string, _key: unknown): never {
  return unavailable('createHmac');
}

export default { createHash, createHmac };
