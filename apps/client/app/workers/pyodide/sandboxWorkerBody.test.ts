import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { pyodideSandboxWorkerBody } from './sandboxWorkerBody';
import { DEFAULT_PYODIDE_BASE_URL } from '@client/app/utils/pyodideDistribution';

/**
 * The worker body is shipped by serializing it, so its correctness depends on properties the
 * type system cannot see. Each of these fails only at runtime, inside a sandbox, on a user's
 * machine - which is why they are pinned here instead.
 */
describe('pyodideSandboxWorkerBody serialization', () => {
  const source = pyodideSandboxWorkerBody.toString();

  it('produces a syntactically valid IIFE', () => {
    // Parse only - never invoked. `self`/`importScripts` do not exist here.
    expect(() => new Function(`return (${source});`)).not.toThrow();
  });

  it('emits no TypeScript downlevel helper', () => {
    // A helper lives in module scope, so toString() would capture a call to something that
    // does not exist inside the worker. Today the package targets ES2018 and none are emitted;
    // lowering the target would break the sandbox silently without this.
    for (const helper of ['__awaiter', '__generator', '__rest', '__assign', '_asyncToGenerator', '__spreadArray']) {
      expect(source, `serialized worker references the ${helper} helper`).not.toContain(helper);
    }
  });

  it('closes over nothing outside itself', () => {
    // Every identifier the body relies on is either declared inside it or a worker global.
    // The import in the module is type-only, so nothing should survive erasure.
    const moduleSource = readFileSync(path.resolve(import.meta.dirname, 'sandboxWorkerBody.ts'), 'utf8');
    // Only the module's own import block - the worker body embeds Python that starts lines
    // with `import sys`, which a whole-file scan happily mistakes for an ES import.
    const importBlock = moduleSource.slice(0, moduleSource.indexOf('export function'));
    const runtimeImports = [...importBlock.matchAll(/^import\s+(?!type\b)/gm)].map(m => m[0]);
    expect(runtimeImports, 'a runtime import cannot survive Function.toString()').toEqual([]);
  });

  it('pins the same Pyodide distribution the CSP allow-lists', () => {
    // The body cannot import the constant (see above), so the copies are checked in lockstep.
    // A drift means Pyodide fetches from an origin connect-src does not name, and fails closed.
    expect(source).toContain(DEFAULT_PYODIDE_BASE_URL);
  });

  it('never contains a closing script tag', () => {
    // The route inlines this into a <script> element. See buildWorkerSource() for why the
    // escape exists; this asserts the input is clean in the first place.
    expect(source.toLowerCase()).not.toContain('</script');
  });
});
