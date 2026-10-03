import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { pyodideSandboxWorkerBody } from './sandboxWorkerBody';
import type { PyodideWorkerMessage, PyodideWorkerResponse } from './types';
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

describe('pyodideSandboxWorkerBody package loading', () => {
  // Runs the real body against a stub runtime. The body reads `self` and `importScripts` as
  // worker globals, so those are what get stubbed.
  const startWorker = () => {
    const posted: PyodideWorkerResponse[] = [];
    const install = vi.fn().mockResolvedValue(undefined);
    const pyodide = {
      loadPackage: vi.fn().mockResolvedValue(undefined),
      loadPackagesFromImports: vi.fn(async (_code: string, options?: { messageCallback?: (m: string) => void }) => {
        options?.messageCallback?.('Loading scipy, openblas');
        pyodide.loadedPackages.scipy = 'default channel';
      }),
      loadedPackages: {} as Record<string, string>,
      pyimport: vi.fn(() => ({ install })),
      runPythonAsync: vi.fn(async () => ({
        toJs: () => ({ stdout: 'ok', stderr: '', plots: [], error: null }),
      })),
      globals: { set: vi.fn(), delete: vi.fn() },
    };
    const workerSelf: {
      postMessage: (message: PyodideWorkerResponse) => void;
      loadPyodide: () => Promise<typeof pyodide>;
      onmessage?: (event: MessageEvent<PyodideWorkerMessage>) => Promise<void>;
    } = {
      postMessage: message => posted.push(message),
      loadPyodide: async () => pyodide,
    };
    vi.stubGlobal('self', workerSelf);
    vi.stubGlobal('importScripts', vi.fn());

    pyodideSandboxWorkerBody();
    const send = (data: PyodideWorkerMessage) => workerSelf.onmessage!({ data } as MessageEvent<PyodideWorkerMessage>);
    return { posted, pyodide, install, send };
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads packages from the code imports before running it', async () => {
    const { posted, pyodide, send } = startWorker();
    await send({ type: 'initialize' });

    const code = 'from scipy.optimize import milp, LinearConstraint, Bounds\nprint(milp)';
    // The detected list is deliberately empty: loading must not depend on the regex scan.
    await send({ type: 'execute', code, packages: [], timeoutMs: 1000 });

    expect(pyodide.loadPackagesFromImports).toHaveBeenCalledWith(code, expect.any(Object));
    const userRun = pyodide.runPythonAsync.mock.calls.findIndex(([source]) => String(source).includes('milp'));
    expect(userRun).toBeGreaterThanOrEqual(0);
    expect(pyodide.loadPackagesFromImports.mock.invocationCallOrder[0]).toBeLessThan(
      pyodide.runPythonAsync.mock.invocationCallOrder[userRun]
    );

    // The loading state reaches the parent before the code runs, and the result follows it.
    const messages = posted.map(m => (m.type === 'executing' ? m.message : m.type));
    const loadingAt = messages.indexOf('Loading scipy, openblas');
    expect(loadingAt).toBeGreaterThanOrEqual(0);
    expect(messages.indexOf('Running...')).toBeGreaterThan(loadingAt);
    expect(posted.at(-1)).toMatchObject({ type: 'result', result: { success: true, output: 'ok' } });
  });

  it('skips the micropip backstop for packages Pyodide already loaded', async () => {
    const { install, send } = startWorker();
    await send({ type: 'initialize' });
    install.mockClear();

    await send({ type: 'execute', code: 'import scipy', packages: ['scipy'], timeoutMs: 1000 });

    expect(install).not.toHaveBeenCalledWith('scipy');
  });

  it('backstops with micropip under the distribution name', async () => {
    const { install, send } = startWorker();
    await send({ type: 'initialize' });
    install.mockClear();

    await send({ type: 'execute', code: 'import sklearn', packages: ['sklearn'], timeoutMs: 1000 });

    expect(install).toHaveBeenCalledWith('scikit-learn');
  });

  it('still runs the code when the import scan fails', async () => {
    const { posted, pyodide, send } = startWorker();
    await send({ type: 'initialize' });
    pyodide.loadPackagesFromImports.mockRejectedValueOnce(new Error('network down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await send({ type: 'execute', code: 'print(1)', packages: [], timeoutMs: 1000 });

    expect(posted.at(-1)).toMatchObject({ type: 'result', result: { success: true } });
    warn.mockRestore();
  });
});
