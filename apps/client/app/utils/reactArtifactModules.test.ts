import vm from 'node:vm';
import { describe, it, expect } from 'vitest';
import { moduleBaseName } from './importStatements';
import {
  ARTIFACT_MODULE_RUNTIME_FACTORY_SRC,
  createArtifactModuleResolver,
  type ArtifactModuleFactory,
  type ArtifactModuleRuntime,
} from './reactArtifactModules';

// Runs the serialized source the way the sandbox and published bundles do: in a context with
// nothing but JS built-ins and no string code generation.
function evaluate(): ArtifactModuleRuntime {
  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
  return vm.runInContext(`(${ARTIFACT_MODULE_RUNTIME_FACTORY_SRC})()`, context) as ArtifactModuleRuntime;
}

const factory =
  (
    body: (module: { exports: Record<string, unknown> }, require: (s: string) => unknown) => void
  ): ArtifactModuleFactory =>
  (module, _exports, require) =>
    body(module, require);

describe('createArtifactModuleRuntime', () => {
  it('is ASCII and safe to inline in a script block', () => {
    expect(ARTIFACT_MODULE_RUNTIME_FACTORY_SRC).toMatch(/^[\t\n\r\x20-\x7e]*$/);
    for (const bad of ['</script', '<script', '<!--', '${', '=>']) {
      expect(ARTIFACT_MODULE_RUNTIME_FACTORY_SRC.toLowerCase()).not.toContain(bad);
    }
  });

  it('links sibling modules from its serialized source, caching each one', () => {
    const runtime = evaluate();
    let loads = 0;
    const result = runtime.run(
      moduleBaseName,
      name => ({ external: name }),
      [
        [
          'Helper',
          factory(module => {
            loads++;
            module.exports.value = 42;
          }),
        ],
      ],
      factory((module, require) => {
        const a = require('./helper.tsx') as { value: number };
        const b = require('../lib/Helper') as { value: number };
        module.exports.default = [a.value, b === a, require('react')];
      })
    );
    expect(result).toEqual([42, true, { external: 'react' }]);
    expect(loads).toBe(1);
  });

  it('prefixes the failing file name once', () => {
    const runtime = evaluate();
    expect(() =>
      runtime.run(
        moduleBaseName,
        () => undefined,
        [
          ['Outer', factory((_m, require) => void require('./Inner'))],
          [
            'Inner',
            factory(() => {
              throw new Error('kaput');
            }),
          ],
        ],
        factory((_m, require) => void require('./Outer'))
      )
    ).toThrow(/^Inner: kaput$/);
  });
});

describe('createArtifactModuleResolver', () => {
  const resolve = createArtifactModuleResolver(moduleBaseName, ['Card', 'card.jsx', 'Panel']);

  it('matches by basename, ignoring directories, extension and case', () => {
    expect(resolve('../ui/panel.tsx')).toBe('Panel');
  });

  it('names a missing file and lists the available ones', () => {
    expect(() => resolve('./Gone')).toThrow(
      'Cannot resolve "./Gone": no artifact file is named "gone". Available files: Card, card.jsx, Panel.'
    );
    expect(() => createArtifactModuleResolver(moduleBaseName, [])('./x')).toThrow('Available files: none.');
  });

  it('rejects an import several files match', () => {
    expect(() => resolve('./CARD')).toThrow('files Card, card.jsx all match "card"');
  });
});
