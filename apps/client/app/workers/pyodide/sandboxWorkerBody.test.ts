import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { pyodideSandboxWorkerBody } from './sandboxWorkerBody';
import { SANDBOX_RUNNING_MESSAGE, type PyodideWorkerMessage, type PyodideWorkerResponse } from './types';
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

  it('starts the parent time limit with the status it posts once guest code runs', () => {
    const posts = source.match(/message: ["']([^"']*)["']/g) ?? [];
    expect(posts.filter(post => post.slice(10, -1) === SANDBOX_RUNNING_MESSAGE)).toHaveLength(2);
  });

  // The same glue runs under real Pyodide in apps/workers/src/callableFunctions/callGlue.e2e.test.ts.
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
    expect(source).toContain("_FunctionCallError('The function returned a result larger than 5 MB.')");
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
    // A writable bit check on the parent directory stands in for Emscripten's permission check.
    const fsFiles = new Map<string, { mode: number; data?: Uint8Array; dir?: boolean; link?: string }>();
    const writable = (path: string) => ((fsFiles.get(path.slice(0, path.lastIndexOf('/')))?.mode ?? 0) & 0o200) !== 0;
    const FS = {
      analyzePath: (path: string) => ({ exists: fsFiles.has(path) }),
      mkdir: (path: string) => {
        if (fsFiles.has(path)) throw new Error('EEXIST');
        fsFiles.set(path, { mode: 0o755, dir: true });
      },
      readdir: (path: string) => [
        '.',
        '..',
        ...[...fsFiles.keys()]
          .filter(key => key.startsWith(`${path}/`))
          .map(key => key.slice(path.length + 1))
          .filter(name => !name.includes('/')),
      ],
      lstat: (path: string) => {
        const node = fsFiles.get(path);
        if (!node) throw new Error('ENOENT');
        return { mode: node.link !== undefined ? 0o120000 : node.dir ? 0o040000 : 0o100000 };
      },
      isDir: (mode: number) => (mode & 0o170000) === 0o040000,
      writeFile: (path: string, data: Uint8Array) => {
        if (!writable(path)) throw new Error('EACCES');
        fsFiles.set(path, { mode: 0o644, data });
      },
      // chmod follows a symlink; lchmod and unlink act on the link itself.
      chmod: (path: string, mode: number) => {
        const node = fsFiles.get(path)!;
        (node.link !== undefined ? fsFiles.get(node.link)! : node).mode = mode;
      },
      lchmod: (path: string, mode: number) => void (fsFiles.get(path)!.mode = mode),
      unlink: (path: string) => {
        if (fsFiles.get(path)?.dir) throw new Error('EISDIR');
        fsFiles.delete(path);
      },
      rmdir: (path: string) => {
        if (!fsFiles.get(path)?.dir) throw new Error('ENOTDIR');
        if ([...fsFiles.keys()].some(key => key.startsWith(`${path}/`))) throw new Error('ENOTEMPTY');
        fsFiles.delete(path);
      },
    };
    const pyodide = {
      FS,
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
    return { posted, pyodide, install, send, fsFiles };
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

    await send({ type: 'call', code, packages: [], paramsJson: null, timeoutMs: 1000, nonce: 'n1' });

    expect(pyodide.globals.set).toHaveBeenCalledWith('_fn_code', code);
    expect(pyodide.globals.set).toHaveBeenCalledWith('_fn_params_json', null);
    const wrapper = String(pyodide.runPythonAsync.mock.calls.at(-1)?.[0]);
    expect(wrapper).not.toContain(code);
    expect(wrapper).toContain('_b4m_call_function(_fn_code, _fn_params_json)');
    expect(pyodide.globals.delete).toHaveBeenCalledWith('_fn_code');
    expect(pyodide.globals.delete).toHaveBeenCalledWith('_fn_params_json');
    expect(posted.at(-1)).toEqual({
      type: 'call-result',
      nonce: 'n1',
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

  it('posts a result of exactly the 5 MB cap whole and quickly, with the event loop still turning', async () => {
    const { posted, pyodide, send } = startWorker();
    await send({ type: 'initialize' });
    const head = '{"text": "';
    const valueJson = `${head}${'x'.repeat(FUNCTION_CONTRACT_LIMITS.maxResultBytes - head.length - 2)}"}`;
    expect(valueJson).toHaveLength(5 * 1024 * 1024);
    pyodide.runPythonAsync.mockResolvedValueOnce({
      toJs: () => ({ contract_json: '{}', value_json: valueJson, stdout: '', stderr: '', error: undefined }),
    } as never);

    let widestGapMs = 0;
    let last = performance.now();
    const ticker = setInterval(() => {
      const now = performance.now();
      widestGapMs = Math.max(widestGapMs, now - last);
      last = now;
    }, 5);
    const started = performance.now();
    await send({ type: 'call', code: 'x = 1', packages: [], paramsJson: '{}', timeoutMs: 1000, nonce: 'n3' });
    const elapsedMs = performance.now() - started;
    await new Promise(resolve => setTimeout(resolve, 20));
    clearInterval(ticker);

    expect(posted.at(-1)).toMatchObject({ type: 'call-result', result: { success: true, valueJson } });
    // A 5 MiB hand-off takes a few milliseconds here, so only a copy or parse loop can reach 250 ms.
    expect(elapsedMs).toBeLessThan(250);
    expect(widestGapMs).toBeLessThan(250);
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

    await send({ type: 'call', code: 'x = 1', packages: [], paramsJson: '{"span": 4}', timeoutMs: 1000, nonce: 'n2' });

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

    await send({ type: 'call', code: 'x = 1', packages: [], paramsJson: '{}', timeoutMs: 1000, nonce: 'n3' });

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

    await send({ type: 'call', code: 'x = 1', packages: [], paramsJson: '{}', timeoutMs: 1000, nonce: 'n3' });

    expect(posted.at(-1)).toMatchObject({
      type: 'call-result',
      result: { success: true, contractJson: undefined, valueJson: undefined, output: '' },
    });
  });

  it('puts pinned files read-only under /data and empties it before the next call', async () => {
    const { pyodide, send, fsFiles } = startWorker();
    await send({ type: 'initialize' });
    const call = { type: 'call' as const, code: 'x = 1', packages: [], paramsJson: '{}', timeoutMs: 1000 };
    const bytes = new TextEncoder().encode('x,y\n1,2\n').buffer as ArrayBuffer;

    await send({ ...call, nonce: 'd1', files: [{ name: 'points.csv', bytes }] });

    expect(fsFiles.get('/data')?.mode).toBe(0o555);
    expect(fsFiles.get('/data/points.csv')?.mode).toBe(0o444);
    expect(() => pyodide.FS.writeFile('/data/new.csv', new Uint8Array(1))).toThrow('EACCES');
    await send({ ...call, nonce: 'd2' });
    expect([...fsFiles.keys()]).toEqual(['/data']);
  });

  it('removes a directory a guest made under /data, with its files, before the next call', async () => {
    const { posted, pyodide, send, fsFiles } = startWorker();
    await send({ type: 'initialize' });
    const call = { type: 'call' as const, code: 'x = 1', packages: [], paramsJson: '{}', timeoutMs: 1000 };
    const bytes = new TextEncoder().encode('x,y\n1,2\n').buffer as ArrayBuffer;
    const done = { toJs: () => ({ stdout: '', stderr: '', plots: [], error: null }) };
    let seen: string[] = [];
    pyodide.runPythonAsync
      .mockImplementationOnce(async () => {
        fsFiles.set('/data/sub', { mode: 0o755, dir: true });
        fsFiles.set('/data/sub/out.txt', { mode: 0o644, data: new Uint8Array(1) });
        return done;
      })
      .mockImplementationOnce(async () => {
        seen = pyodide.FS.readdir('/data').filter(name => name !== '.' && name !== '..');
        return done;
      });

    await send({ ...call, nonce: 'd1', files: [{ name: 'points.csv', bytes }] });
    await send({ ...call, nonce: 'd2', files: [{ name: 'other.csv', bytes }] });

    expect(posted.at(-1)).toMatchObject({ type: 'call-result', nonce: 'd2', result: { success: true } });
    expect(seen).toEqual(['other.csv']);
    expect([...fsFiles.keys()].filter(key => key.startsWith('/data/'))).toEqual(['/data/other.csv']);
  });

  it.each([
    ['a regular file', { mode: 0o644, data: new Uint8Array(1) }],
    ['a dangling symlink', { mode: 0o777, link: '/nowhere' }],
    ['a symlink to another directory', { mode: 0o777, link: '/lib/site' }],
  ])('replaces a /data that a guest turned into %s, and never follows it', async (_label, node) => {
    const { posted, pyodide, send, fsFiles } = startWorker();
    await send({ type: 'initialize' });
    const call = { type: 'call' as const, code: 'x = 1', packages: [], paramsJson: '{}', timeoutMs: 1000 };
    const bytes = new TextEncoder().encode('x,y\n1,2\n').buffer as ArrayBuffer;
    fsFiles.set('/lib/site', { mode: 0o755, dir: true });
    fsFiles.set('/lib/site/pkg.py', { mode: 0o644, data: new Uint8Array(1) });
    pyodide.runPythonAsync.mockImplementationOnce(async () => {
      fsFiles.delete('/data/points.csv');
      fsFiles.set('/data', node);
      return { toJs: () => ({ stdout: '', stderr: '', plots: [], error: null }) };
    });

    await send({ ...call, nonce: 'd1', files: [{ name: 'points.csv', bytes }] });
    await send({ ...call, nonce: 'd2', files: [{ name: 'points.csv', bytes }] });

    expect(posted.at(-1)).toMatchObject({ type: 'call-result', nonce: 'd2', result: { success: true } });
    expect(fsFiles.get('/data')).toMatchObject({ dir: true, mode: 0o555 });
    expect(fsFiles.get('/data/points.csv')?.mode).toBe(0o444);
    expect(fsFiles.get('/lib/site')?.mode).toBe(0o755);
    expect(fsFiles.has('/lib/site/pkg.py')).toBe(true);
  });

  it('reports a runtime failure during a call as a failed call-result', async () => {
    const { posted, pyodide, send } = startWorker();
    await send({ type: 'initialize' });
    pyodide.runPythonAsync.mockRejectedValueOnce(new Error('PythonError: boom'));

    await send({ type: 'call', code: 'x = 1', packages: [], paramsJson: null, timeoutMs: 1000, nonce: 'n4' });

    expect(posted.at(-1)).toMatchObject({
      type: 'call-result',
      nonce: 'n4',
      result: { success: false, error: 'PythonError: boom' },
    });
  });

  it('echoes the nonce of the call it answers, on a refusal before Python runs too', async () => {
    const { posted, send } = startWorker();
    await send({ type: 'call', code: 'x = 1', packages: [], paramsJson: null, timeoutMs: 1000, nonce: 'early' });
    expect(posted.at(-1)).toMatchObject({
      type: 'call-result',
      nonce: 'early',
      result: { success: false, error: 'Pyodide not initialized' },
    });
  });

  it('posts through the postMessage it bound at start, so replacing self.postMessage sees no nonce', async () => {
    const { posted, send } = startWorker();
    await send({ type: 'initialize' });
    const replaced = vi.fn();
    (self as unknown as { postMessage: (message: unknown) => void }).postMessage = replaced;

    await send({ type: 'call', code: 'x = 1', packages: [], paramsJson: '{}', timeoutMs: 1000, nonce: 'secret' });

    expect(replaced).not.toHaveBeenCalled();
    expect(posted.at(-1)).toMatchObject({ type: 'call-result', nonce: 'secret' });
  });
});
