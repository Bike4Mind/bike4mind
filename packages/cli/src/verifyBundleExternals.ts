/**
 * Pure helpers for the CLI build's "external imports must be declared" guard.
 *
 * The CLI bundles @bike4mind/* workspace packages inline but keeps npm packages
 * external, so every external the emitted bundle references must be a declared
 * production dependency of the CLI - otherwise the published binary dies at
 * startup with ERR_MODULE_NOT_FOUND (see packages/cli/tsdown.config.ts).
 *
 * Kept separate from tsdown.config.ts (and free of bundler types) so the logic
 * is unit-testable in isolation, mirroring package-deps.test.ts.
 */
import { builtinModules } from 'module';

const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map(m => `node:${m}`)]);

// @bike4mind/* packages are bundled inline (tsdown deps.neverBundle), never installed.
const BUNDLED_SCOPES = ['@bike4mind/'];

/** The slice of rolldown's plugin context this guard reads from the module graph. */
export type ModuleGraph = {
  getModuleIds(): Iterable<string>;
  getModuleInfo(id: string): { importedIds: string[]; dynamicallyImportedIds: string[] } | null;
};

/**
 * Collect every module specifier the bundle imports (static + dynamic) by walking
 * rolldown's module graph. External packages keep their bare-specifier id; internal
 * modules are absolute paths (filtered out downstream by isExternalPackage).
 *
 * Blind spot: this only sees import / dynamic-import edges the bundler tracks.
 * Runtime resolution via `require.resolve(...)` / `createRequire(...)` is invisible
 * both to the bundler and to this walk, so a dep reached only that way will NOT be
 * flagged here - it must be kept a real (bundler-visible) import or declared by hand.
 */
export function collectGraphSpecifiers(graph: ModuleGraph): Set<string> {
  const specifiers = new Set<string>();
  for (const id of graph.getModuleIds()) {
    const info = graph.getModuleInfo(id);
    if (!info) continue;
    for (const dep of info.importedIds) specifiers.add(dep);
    for (const dep of info.dynamicallyImportedIds) specifiers.add(dep);
  }
  return specifiers;
}

export function getPackageName(specifier: string): string {
  if (specifier.startsWith('@')) {
    return specifier.split('/').slice(0, 2).join('/');
  }
  return specifier.split('/')[0] ?? specifier;
}

/**
 * True when a module specifier refers to an installable npm package (i.e. one
 * that must appear in the CLI's dependencies). Filters out relative/absolute
 * paths, scheme-prefixed specifiers (node:, data:, ...), Node built-ins, and
 * the inline-bundled @bike4mind/* scope.
 */
export function isExternalPackage(specifier: string): boolean {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return false;
  if (specifier.includes(':')) return false;
  if (NODE_BUILTINS.has(specifier)) return false;
  if (BUNDLED_SCOPES.some(scope => specifier.startsWith(scope))) return false;
  return true;
}

/**
 * Given the external module specifiers referenced by the emitted bundle and the
 * set of declared production dependency names, return the package names that are
 * imported but not declared. A non-empty result means the built binary would
 * throw ERR_MODULE_NOT_FOUND on a fresh install.
 */
export function findUndeclaredBundleDeps(specifiers: Iterable<string>, declaredDeps: ReadonlySet<string>): string[] {
  const missing = new Set<string>();
  for (const specifier of specifiers) {
    if (!isExternalPackage(specifier)) continue;
    const pkgName = getPackageName(specifier);
    if (!declaredDeps.has(pkgName)) missing.add(pkgName);
  }
  return [...missing].sort();
}
