/** A file's CommonJS wrapper, as the sandbox and the publish transpiler emit it. */
export type ArtifactModuleFactory = (
  this: unknown,
  module: { exports: Record<string, unknown> },
  exports: Record<string, unknown>,
  require: (specifier: string) => unknown
) => void;

export interface ArtifactModuleRuntime {
  /** Maps a relative specifier to the one file key it names, or throws the "Cannot resolve" error. */
  createResolver(moduleName: (path: string) => string, keys: string[]): (specifier: string) => string;
  /** Runs the entry factory against the sibling factories and returns its default export. */
  run(
    moduleName: (path: string) => string,
    requireExternal: (specifier: string) => unknown,
    files: Array<[string, ArtifactModuleFactory]>,
    entryFactory: ArtifactModuleFactory
  ): unknown;
}

/* eslint-disable no-var -- `var` keeps the serialized body free of anything a compiler might downlevel */
/**
 * Multi-file React artifact linker shared by the in-app sandbox (pages/api/react-artifact-sandbox.ts,
 * which evaluates ARTIFACT_MODULE_RUNTIME_FACTORY_SRC in the browser) and published bundles
 * (server/services/publish/transpileReactArtifact.ts, which inlines the same source and also calls
 * createResolver natively to reject unresolvable imports at publish). The body must stay
 * self-contained with no compiler-rewritten syntax, like createImportScanner in
 * b4m-core/utils/src/importStatements.ts; reactArtifactModules.test.ts evaluates it in an empty context.
 */
export function createArtifactModuleRuntime(): ArtifactModuleRuntime {
  'use strict';
  var RELATIVE = /^\.\.?\//;

  function createResolver(moduleName: (path: string) => string, keys: string[]): (specifier: string) => string {
    var keysByName: Record<string, string[]> = Object.create(null);
    for (var i = 0; i < keys.length; i++) {
      var name = moduleName(keys[i]);
      (keysByName[name] = keysByName[name] || []).push(keys[i]);
    }
    return function resolve(specifier: string): string {
      var wanted = moduleName(specifier);
      var matches = keysByName[wanted];
      if (!matches) {
        throw new Error(
          'Cannot resolve "' +
            specifier +
            '": no artifact file is named "' +
            wanted +
            '". Available files: ' +
            (keys.length ? keys.join(', ') : 'none') +
            '.'
        );
      }
      if (matches.length > 1) {
        throw new Error(
          'Cannot resolve "' +
            specifier +
            '": files ' +
            matches.join(', ') +
            ' all match "' +
            wanted +
            '". Give each file a unique name (case and extension are ignored).'
        );
      }
      return matches[0];
    };
  }

  function run(
    moduleName: (path: string) => string,
    requireExternal: (specifier: string) => unknown,
    files: Array<[string, ArtifactModuleFactory]>,
    entryFactory: ArtifactModuleFactory
  ): unknown {
    var factories: Record<string, ArtifactModuleFactory> = Object.create(null);
    var keys: string[] = [];
    for (var i = 0; i < files.length; i++) {
      factories[files[i][0]] = files[i][1];
      keys.push(files[i][0]);
    }
    var resolve = createResolver(moduleName, keys);
    var cache: Record<string, { exports: Record<string, unknown> }> = Object.create(null);
    var annotated: unknown = null;

    function load(key: string): Record<string, unknown> {
      // A module required again while still loading (a cycle) gets its partial exports, as in Node.
      if (cache[key]) return cache[key].exports;
      var record = (cache[key] = { exports: {} });
      try {
        factories[key].call(record.exports, record, record.exports, require);
      } catch (e) {
        // Name the innermost failing file once; the loads above it rethrow the error untouched.
        if (e && typeof e === 'object' && typeof (e as Error).message === 'string' && e !== annotated) {
          (e as Error).message = key + ': ' + (e as Error).message;
          annotated = e;
        }
        throw e;
      }
      return record.exports;
    }
    function require(specifier: string): unknown {
      if (!RELATIVE.test(specifier)) return requireExternal(specifier);
      return load(resolve(specifier));
    }

    var entry = { exports: {} as Record<string, unknown> };
    entryFactory.call(entry.exports, entry, entry.exports, require);
    return entry.exports.default;
  }

  return { createResolver: createResolver, run: run };
}
/* eslint-enable no-var */

/** The factory's source text, for the sandbox and published bundles to evaluate in the browser. */
export const ARTIFACT_MODULE_RUNTIME_FACTORY_SRC = String(createArtifactModuleRuntime);

export const createArtifactModuleResolver = createArtifactModuleRuntime().createResolver;
