import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { pyodideSandboxWorkerBody } from './sandboxWorkerBody';
import type { PyodideWorkerMessage, PyodideWorkerResponse } from './types';
import { DEFAULT_PYODIDE_BASE_URL } from '@client/app/utils/pyodideDistribution';
import {
  FUNCTION_CALL_GLUE_PY,
  FUNCTION_CONTRACT_GLOBAL,
  FUNCTION_CONTRACT_LIMITS,
  FUNCTION_ENTRY_POINT,
  PYODIDE_VERSION,
} from '@bike4mind/common';

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

  it('runs the call glue and the Pyodide release the server runtime shares', () => {
    expect(source).toContain(FUNCTION_CALL_GLUE_PY);
    expect(DEFAULT_PYODIDE_BASE_URL).toContain(`/v${PYODIDE_VERSION}/`);
  });

  it('loads function code as a module other than __main__ and refuses NaN in JSON', () => {
    // A script-style demo block must not run during a call, and NaN is not JSON.
    expect(source).toContain("namespace = {'__name__': 'b4m_function'}");
    expect(source).toContain("exec(compile(code, 'function.py', 'exec'), namespace)");
    expect(source.match(/allow_nan=False/g)).toHaveLength(2);
  });

  // The wrapper is Python text inside a serialized function, so it cannot import the shared names or limits.
  it('reads the contract and entry point under the shared names', () => {
    expect(source).toContain(`namespace.get('${FUNCTION_CONTRACT_GLOBAL}')`);
    expect(source).toContain(`_FunctionCallError('${FUNCTION_CONTRACT_GLOBAL} is not defined')`);
    expect(source).toContain(`namespace.get('${FUNCTION_ENTRY_POINT}')`);
  });

  it('refuses an async run by name', () => {
    expect(source).toContain('if inspect.iscoroutinefunction(run):');
    expect(source).toContain("_FunctionCallError('run must be defined with def, not async def')");
  });

  it('caps printed output and the error text before posting them', () => {
    expect(source).toContain('_MAX_OUTPUT_CHARS = 100000');
    expect(source).toContain("'stdout': stdout.getvalue()[:_MAX_OUTPUT_CHARS]");
    expect(source).toContain("'stderr': stderr.getvalue()[:_MAX_OUTPUT_CHARS]");
    expect(source).toContain("'error': None if error is None else error[:_MAX_OUTPUT_CHARS]");
  });

  it('refuses an oversized contract before posting it', () => {
    expect(source).toContain(`_MAX_CONTRACT_BYTES = ${FUNCTION_CONTRACT_LIMITS.maxContractBytes}`);
    expect(source).toContain('if len(contract_text) > _MAX_CONTRACT_BYTES:');
    expect(source).toContain("_FunctionCallError('The function contract is larger than 32 KB.')");
  });

  it('checks output number types in Python, where 3.0 and True are still distinct from 3 and 1', () => {
    expect(source).toContain(
      "if isinstance(value, bool) or not isinstance(value, (int, float)):\n            problems.append({'path': path, 'message': 'must be a number'})"
    );
    expect(source).toContain(
      "elif kind == 'integer' and not isinstance(value, int):\n            problems.append({'path': path, 'message': 'must be a whole number'})"
    );
    expect(source).toContain("_output_type_problems(contract.get('outputs'), value, '', output_problems)");
    expect(source).toContain("'output_problems_json': json.dumps(output_problems) if output_problems else None");
    expect(source).toContain(`_MAX_PROBLEMS = ${FUNCTION_CONTRACT_LIMITS.maxProblems}`);
  });

  it('refuses an oversized result before posting it', () => {
    expect(source).toContain(`_MAX_RESULT_BYTES = ${FUNCTION_CONTRACT_LIMITS.maxResultBytes}`);
    expect(source).toContain('if len(value_text) > _MAX_RESULT_BYTES:');
    expect(source).toContain("_FunctionCallError('The function returned a result larger than 256 KB.')");
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

  it('reports a run that only wrote to stderr as a success, with stderr as output', async () => {
    const { posted, pyodide, send } = startWorker();
    await send({ type: 'initialize' });
    pyodide.runPythonAsync.mockResolvedValueOnce({
      toJs: () => ({ stdout: 'ok\n', stderr: 'DeprecationWarning: x\n', plots: [], error: null }),
    });

    await send({ type: 'execute', code: 'print(1)', packages: [], timeoutMs: 1000 });

    expect(posted.at(-1)).toMatchObject({
      type: 'result',
      result: { success: true, output: 'ok\nDeprecationWarning: x\n', error: undefined },
    });
  });

  it('reports a raised exception as a failure', async () => {
    const { posted, pyodide, send } = startWorker();
    await send({ type: 'initialize' });
    pyodide.runPythonAsync.mockResolvedValueOnce({
      toJs: () => ({ stdout: '', stderr: '', plots: [], error: 'Traceback ... ZeroDivisionError' }),
    });

    await send({ type: 'execute', code: '1/0', packages: [], timeoutMs: 1000 });

    expect(posted.at(-1)).toMatchObject({
      type: 'result',
      result: { success: false, error: 'Traceback ... ZeroDivisionError' },
    });
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

  it('describes a function through globals, never by putting the code into the Python source', async () => {
    const { posted, pyodide, send } = startWorker();
    await send({ type: 'initialize' });
    pyodide.runPythonAsync.mockResolvedValueOnce({
      toJs: () => ({
        contract_json: '{"name": "f"}',
        value_json: undefined,
        stdout: 'hi\n',
        stderr: '',
        error: undefined,
      }),
    } as never);
    const code = 'FUNCTION = {"name": "f"}\ndef run():\n    return {}';

    await send({ type: 'call', code, packages: [], paramsJson: null, timeoutMs: 1000 });

    expect(pyodide.globals.set).toHaveBeenCalledWith('_fn_code', code);
    expect(pyodide.globals.set).toHaveBeenCalledWith('_fn_params_json', null);
    const wrapper = String(pyodide.runPythonAsync.mock.calls.at(-1)?.[0]);
    expect(wrapper).not.toContain(code);
    expect(wrapper).toContain('_b4m_call_function(_fn_code, _fn_params_json)');
    expect(pyodide.globals.delete).toHaveBeenCalledWith('_fn_code');
    expect(pyodide.globals.delete).toHaveBeenCalledWith('_fn_params_json');
    expect(posted.at(-1)).toEqual({
      type: 'call-result',
      result: {
        success: true,
        contractJson: '{"name": "f"}',
        valueJson: undefined,
        output: 'hi\n',
        error: undefined,
        executionTime: expect.any(Number),
      },
    });
  });

  it('passes params as JSON text and reports an error from the call', async () => {
    const { posted, pyodide, send } = startWorker();
    await send({ type: 'initialize' });
    pyodide.runPythonAsync.mockResolvedValueOnce({
      toJs: () => ({
        contract_json: '{}',
        value_json: undefined,
        stdout: '',
        stderr: '',
        error: 'run must return a dict',
      }),
    } as never);

    await send({ type: 'call', code: 'x = 1', packages: [], paramsJson: '{"span": 4}', timeoutMs: 1000 });

    expect(pyodide.globals.set).toHaveBeenCalledWith('_fn_params_json', '{"span": 4}');
    expect(posted.at(-1)).toMatchObject({
      type: 'call-result',
      result: { success: false, contractJson: '{}', error: 'run must return a dict' },
    });
  });

  it('posts the output problems Python found as JSON text', async () => {
    const { posted, pyodide, send } = startWorker();
    await send({ type: 'initialize' });
    const problemsJson = '[{"path": "count", "message": "must be a whole number"}]';
    pyodide.runPythonAsync.mockResolvedValueOnce({
      toJs: () => ({
        contract_json: '{}',
        value_json: '{"count": 3.0}',
        output_problems_json: problemsJson,
        stdout: '',
        stderr: '',
        error: undefined,
      }),
    } as never);

    await send({ type: 'call', code: 'x = 1', packages: [], paramsJson: '{}', timeoutMs: 1000 });

    expect(posted.at(-1)).toMatchObject({
      type: 'call-result',
      result: { success: true, valueJson: '{"count": 3.0}', outputProblemsJson: problemsJson },
    });
  });

  it('passes only strings on from what Python returned', async () => {
    const { posted, pyodide, send } = startWorker();
    await send({ type: 'initialize' });
    pyodide.runPythonAsync.mockResolvedValueOnce({
      toJs: () => ({ contract_json: { name: 'f' }, value_json: 5, stdout: ['x'], stderr: '', error: undefined }),
    } as never);

    await send({ type: 'call', code: 'x = 1', packages: [], paramsJson: '{}', timeoutMs: 1000 });

    expect(posted.at(-1)).toMatchObject({
      type: 'call-result',
      result: { success: true, contractJson: undefined, valueJson: undefined, output: '' },
    });
  });

  it('reports a runtime failure during a call as a failed call-result', async () => {
    const { posted, pyodide, send } = startWorker();
    await send({ type: 'initialize' });
    pyodide.runPythonAsync.mockRejectedValueOnce(new Error('PythonError: boom'));

    await send({ type: 'call', code: 'x = 1', packages: [], paramsJson: null, timeoutMs: 1000 });

    expect(posted.at(-1)).toMatchObject({
      type: 'call-result',
      result: { success: false, error: 'PythonError: boom' },
    });
  });
});
