import { constants as fsConstants } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PyodideInterface } from 'pyodide';
import type {
  CallableFunctionChildReply,
  CallableFunctionChildRequest,
  CallableFunctionChildRunStarted,
} from '@bike4mind/server-utils/callableFunctions/runtimeParent';

// One Python function run, spawned by runtimeParent.ts in @bike4mind/server-utils. Node runs this file
// with type stripping, so it imports only Node builtins, types, and Pyodide from the directory it is given.

const proc = process;
const argv = proc.argv.slice(2);
const pyodideDir = argv.find(arg => !arg.startsWith('--')) ?? '';
// Test and benchmark switches: the parent never passes either.
const isolated = !argv.includes('--unsafe-no-isolation');
const reuse = argv.includes('--reuse');

// Above the parent's largest request: twice the input and source ceilings in runtimeParent.ts (JSON escaping).
const MAX_REQUEST_CHARS = 16 * 1024 * 1024;
const MAX_ERROR_CHARS = 100_000;
const NETWORK_GLOBALS = ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest'];
const HOST_GLOBALS = ['process', 'global', 'require', '_createPyodideModule'];
const PROCESS_ESCAPES = ['getBuiltinModule', 'binding', '_linkedBinding', 'dlopen', 'mainModule'];

// Import refusals, not a boundary: a guest that walks gc or a function's defaults can still find these.
const LOCKDOWN_PY = `
import os
import sys
import _imp

os.environ.pop('_', None)
_B4M_DENIED = frozenset(('js', 'pyodide_js', 'pyodide', '_pyodide', '_pyodide_core', 'micropip', 'ctypes', '_ctypes'))

def _b4m_refuse(name, denied=_B4M_DENIED):
    if name.partition('.')[0] in denied:
        raise ModuleNotFoundError(f'No module named {name!r}', name=name)

for _b4m_name in [name for name in sys.modules if name.partition('.')[0] in _B4M_DENIED]:
    del sys.modules[_b4m_name]

class _B4mDeniedFinder:
    @staticmethod
    def find_spec(name, path=None, target=None, refuse=_b4m_refuse):
        refuse(name)
        return None

def _b4m_create_builtin(spec, create=_imp.create_builtin, refuse=_b4m_refuse):
    refuse(spec.name)
    return create(spec)

sys.meta_path.insert(0, _B4mDeniedFinder)
_imp.create_builtin = _b4m_create_builtin
del _b4m_name, _B4mDeniedFinder, _b4m_create_builtin, _b4m_refuse, _B4M_DENIED
`;

interface PythonResult {
  toJs: (options: { dict_converter: typeof Object.fromEntries }) => unknown;
  destroy: () => void;
}

const send = (line: CallableFunctionChildReply | CallableFunctionChildRunStarted): Promise<void> =>
  new Promise(resolve => proc.stdout.write(`${JSON.stringify(line)}\n`, () => resolve()));

function removeAll(target: object, names: string[]): void {
  for (const name of names) Reflect.deleteProperty(target, name);
}

async function* requestLines(): AsyncGenerator<string> {
  let buffered = '';
  proc.stdin.setEncoding('utf8');
  for await (const chunk of proc.stdin) {
    buffered += String(chunk);
    let newline = buffered.indexOf('\n');
    while (newline >= 0) {
      yield buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf('\n');
    }
    if (buffered.length > MAX_REQUEST_CHARS) throw new Error('request too large');
  }
  if (buffered) yield buffered;
}

function parseRequest(line: string): CallableFunctionChildRequest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const request = raw as Record<string, unknown>;
  if (request.op !== 'read_contract' && request.op !== 'call') return null;
  if (typeof request.glue !== 'string' || typeof request.code !== 'string') return null;
  if (typeof request.pyodideVersion !== 'string') return null;
  if (request.paramsJson !== null && typeof request.paramsJson !== 'string') return null;
  return {
    op: request.op,
    glue: request.glue,
    code: request.code,
    paramsJson: request.paramsJson,
    pyodideVersion: request.pyodideVersion,
  };
}

async function load(): Promise<PyodideInterface> {
  const { loadPyodide } = (await import(
    pathToFileURL(join(pyodideDir, 'pyodide.mjs')).href
  )) as typeof import('pyodide');
  const hostEnv = Object.fromEntries(
    Object.entries(proc.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
  const pyodide = await loadPyodide({
    indexURL: pyodideDir.endsWith('/') ? pyodideDir : `${pyodideDir}/`,
    env: isolated ? { HOME: '/home/pyodide' } : hostEnv,
    // Pyodide's bootstrap imports only these two from `js`.
    jsglobals: isolated
      ? Object.assign(Object.create(null) as object, {
          setTimeout: (callback: () => void, ms?: number) => setTimeout(callback, ms),
          clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
        })
      : globalThis,
    stdout: () => {},
    stderr: () => {},
  });
  // Pyodide's default stdin on Node reads this process's stdin, which carries the requests.
  pyodide.setStdin({ error: true });
  return pyodide;
}

function lockDown(pyodide: PyodideInterface): void {
  pyodide.unregisterJsModule('js');
  pyodide.unregisterJsModule('pyodide_js');
  pyodide.runPython(LOCKDOWN_PY);
  removeAll(proc, PROCESS_ESCAPES);
  // After loading: Pyodide falls back to importing node-fetch when `fetch` is missing at load.
  removeAll(globalThis, [...HOST_GLOBALS, ...NETWORK_GLOBALS]);
}

async function runRequest(
  pyodide: PyodideInterface,
  request: CallableFunctionChildRequest,
  initMs: number
): Promise<CallableFunctionChildReply> {
  const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
  pyodide.globals.set('_fn_code', request.code);
  pyodide.globals.set('_fn_params_json', request.op === 'call' ? request.paramsJson : null);
  try {
    const result = (await pyodide.runPythonAsync(request.glue)) as PythonResult;
    const fields = result.toJs({ dict_converter: Object.fromEntries }) as Record<string, unknown>;
    result.destroy();
    return {
      ok: true,
      initMs,
      contractJson: text(fields.contract_json),
      valueJson: text(fields.value_json),
      outputProblemsJson: text(fields.output_problems_json),
      printed: (text(fields.stdout) ?? '') + (text(fields.stderr) ?? ''),
      error: text(fields.error),
    };
  } catch (error) {
    // A BaseException such as SystemExit gets past the glue's `except Exception`.
    const message = error instanceof Error ? error.message : 'Traceback (most recent call last):\nException';
    return { ok: true, initMs, printed: '', error: message.slice(0, MAX_ERROR_CHARS) };
  } finally {
    pyodide.globals.delete('_fn_code');
    pyodide.globals.delete('_fn_params_json');
  }
}

async function main(): Promise<void> {
  if (isolated) {
    // The permission model refuses process.binding, and Pyodide's NODEFS reads its fs constants from it.
    if (proc.permission) {
      Object.assign(proc, {
        binding: (name: string) => {
          if (name === 'constants') return { fs: fsConstants, os: osConstants };
          throw new Error('process.binding is not available');
        },
      });
    }
  }
  const lines = requestLines();
  let pyodide: PyodideInterface | null = null;
  let initMs = 0;
  let locked = false;
  for (;;) {
    let next: IteratorResult<string>;
    try {
      next = await lines.next();
    } catch {
      await send({ ok: false, failure: 'request' });
      break;
    }
    if (next.done) break;
    const request = parseRequest(next.value);
    if (!request) {
      await send({ ok: false, failure: 'request' });
      break;
    }
    if (!pyodide) {
      const started = performance.now();
      try {
        pyodide = await load();
      } catch {
        await send({ ok: false, failure: 'load' });
        break;
      }
      initMs = Math.round(performance.now() - started);
    }
    if (pyodide.version !== request.pyodideVersion) {
      await send({ ok: false, failure: 'version' });
      break;
    }
    try {
      // Wheels come from the local directory only; a missing one fails at the guest's import.
      await pyodide.loadPackagesFromImports(request.code, { messageCallback: () => {}, errorCallback: () => {} });
    } catch {
      // Same as above.
    }
    if (isolated && !locked) {
      lockDown(pyodide);
      locked = true;
    }
    // The parent's time limit starts here; no guest code has run yet.
    await send({ started: true });
    await send(await runRequest(pyodide, request, initMs));
    if (!reuse) break;
  }
  proc.exit(0);
}

main().catch(() => proc.exit(1));
