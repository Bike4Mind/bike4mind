/**
 * Module-resolution hook (registered by selfhostSstAlias.mjs). Redirects the bare specifier
 * `sst` to `@bike4mind/resource` (the env-backed self-host shim); everything else resolves
 * normally. Runs off-thread via `module.register`, so resolution of the shim is delegated to
 * `nextResolve` using the original importer's context.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'sst') {
    return nextResolve('@bike4mind/resource', context);
  }
  return nextResolve(specifier, context);
}
