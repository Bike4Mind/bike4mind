import { constants as fsConstants } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
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

// Stands in for ctypes, whose real module is denied with _ctypes: scipy, scikit-learn (through threadpoolctl),
// pandas, and numpy import it. Pure Python value types; every entry point that loads, calls, or touches memory raises.
const CTYPES_STUB_PY = `
import types as _types

_REFUSED = 'ctypes cannot load a library, call a function pointer, or access memory in this runtime'


def _refuse(*args, **kwargs):
    raise OSError(_REFUSED)


class ArgumentError(Exception):
    pass


DEFAULT_MODE = 0
RTLD_LOCAL = 0
RTLD_GLOBAL = 256


class _CData:
    _size_ = None
    from_address = classmethod(_refuse)
    from_buffer = classmethod(_refuse)
    from_buffer_copy = classmethod(_refuse)
    in_dll = classmethod(_refuse)

    @classmethod
    def from_param(cls, obj):
        return obj


class _SimpleCData(_CData):
    _default = 0

    def __init__(self, value=None):
        self.value = self._default if value is None else value

    @property
    def value(self):
        return self._value

    @value.setter
    def value(self, value):
        self._value = self._check(value)

    def _check(self, value):
        return value

    def __repr__(self):
        return '%s(%r)' % (type(self).__name__, self._value)


def _integer(name, size, signed):
    bits = size * 8

    def _check(self, value):
        value = value.__index__() & ((1 << bits) - 1)
        return value - (1 << bits) if signed and value >= 1 << (bits - 1) else value

    return type(name, (_SimpleCData,), {'_size_': size, '_check': _check})


def _value(name, size, check, default):
    return type(name, (_SimpleCData,), {'_size_': size, '_check': lambda self, value: check(value), '_default': default})


def _optional(kind):
    def check(value):
        if value is not None and not isinstance(value, kind):
            raise TypeError('expected %s or None' % kind.__name__)
        return value
    return check


# Sizes are wasm32's.
c_byte = _integer('c_byte', 1, True)
c_ubyte = _integer('c_ubyte', 1, False)
c_short = _integer('c_short', 2, True)
c_ushort = _integer('c_ushort', 2, False)
c_int = _integer('c_int', 4, True)
c_uint = _integer('c_uint', 4, False)
c_long = _integer('c_long', 4, True)
c_ulong = _integer('c_ulong', 4, False)
c_longlong = _integer('c_longlong', 8, True)
c_ulonglong = _integer('c_ulonglong', 8, False)
c_int8, c_uint8, c_int16, c_uint16 = c_byte, c_ubyte, c_short, c_ushort
c_int32, c_uint32, c_int64, c_uint64 = c_int, c_uint, c_longlong, c_ulonglong
c_size_t, c_ssize_t = c_uint, c_int
c_float = _value('c_float', 4, float, 0.0)
c_double = _value('c_double', 8, float, 0.0)
c_longdouble = _value('c_longdouble', 16, float, 0.0)
c_bool = _value('c_bool', 1, bool, False)
c_char = _value('c_char', 1, _optional(bytes), b'\\x00')
c_wchar = _value('c_wchar', 4, _optional(str), '\\x00')
c_char_p = _value('c_char_p', 4, _optional(bytes), None)
c_wchar_p = _value('c_wchar_p', 4, _optional(str), None)
c_void_p = _integer('c_void_p', 4, False)


class Structure(_CData):
    def __init__(self, *args, **kwargs):
        for (name, *_), value in zip(getattr(type(self), '_fields_', ()), args):
            setattr(self, name, value)
        for name, value in kwargs.items():
            setattr(self, name, value)


class Union(Structure):
    pass


BigEndianStructure = LittleEndianStructure = Structure


class Array(_CData):
    pass


class _Pointer(_CData):
    _size_ = 4
    __init__ = _refuse


_pointer_types = {}


def POINTER(cls):
    if cls not in _pointer_types:
        _pointer_types[cls] = type('LP_%s' % getattr(cls, '__name__', 'object'), (_Pointer,), {'_type_': cls})
    return _pointer_types[cls]


class _CFuncPtr(_CData):
    _size_ = 4
    restype = None
    argtypes = ()

    def __init__(self, *args):
        self._value = args[0] if args and isinstance(args[0], int) else None

    __call__ = _refuse


def CFUNCTYPE(restype, *argtypes, **kwargs):
    return type('CFunctionType', (_CFuncPtr,), {'_restype_': restype, '_argtypes_': argtypes})


PYFUNCTYPE = CFUNCTYPE


class CDLL:
    __init__ = _refuse


PyDLL = CDLL


class LibraryLoader:
    def __init__(self, dlltype):
        pass

    def __getattr__(self, name):
        if name.startswith('_'):
            raise AttributeError(name)
        _refuse()

    __getitem__ = LoadLibrary = _refuse


cdll = LibraryLoader(CDLL)
pydll = LibraryLoader(PyDLL)
addressof = byref = create_string_buffer = create_unicode_buffer = _refuse
memmove = memset = pointer = resize = string_at = wstring_at = _refuse


# scipy casts addresses to function pointer types when it imports. The result holds the number, is never called, and
# never casts back to an address, so it cannot reach memory or code.
def cast(obj, cls):
    if not (isinstance(cls, type) and issubclass(cls, _CFuncPtr) and isinstance(obj, int)):
        _refuse()
    return cls(obj)


def sizeof(obj):
    size = getattr(obj, '_size_', None)
    if size is None:
        raise TypeError('this type has no size')
    return size


alignment = sizeof


def get_errno():
    return 0


def set_errno(value):
    return 0


util = _types.ModuleType('ctypes.util')
util.find_library = lambda name: None
`;

// Import refusals, not a boundary: a guest that walks gc or a function's defaults can still find these.
const LOCKDOWN_PY = `
import os
import sys
import types
import _imp

os.environ.pop('_', None)
_B4M_DENIED = frozenset(('js', 'pyodide_js', 'pyodide', '_pyodide', '_pyodide_core', 'micropip', 'ctypes', '_ctypes'))

def _b4m_refuse(name, denied=_B4M_DENIED):
    if name.partition('.')[0] in denied:
        raise ModuleNotFoundError(f'No module named {name!r}', name=name)

for _b4m_name in [name for name in sys.modules if name.partition('.')[0] in _B4M_DENIED]:
    del sys.modules[_b4m_name]

# The stub is served from sys.modules; any other ctypes module, and _ctypes, stays refused.
_b4m_ctypes = types.ModuleType('ctypes')
exec(compile(${JSON.stringify(CTYPES_STUB_PY)}, '<ctypes>', 'exec'), _b4m_ctypes.__dict__)
sys.modules['ctypes'] = _b4m_ctypes
sys.modules['ctypes.util'] = _b4m_ctypes.util

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
del _b4m_name, _b4m_ctypes, _B4mDeniedFinder, _b4m_create_builtin, _b4m_refuse, _B4M_DENIED
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
  const dataDir = request.dataDir ?? null;
  if (dataDir !== null && typeof dataDir !== 'string') return null;
  return {
    op: request.op,
    glue: request.glue,
    code: request.code,
    paramsJson: request.paramsJson,
    pyodideVersion: request.pyodideVersion,
    dataDir,
  };
}

// The parent's read-only directory of this call's files. The process may only read it, so a write fails on the host
// as well as in Pyodide's own permission check on the read-only modes.
function mountData(pyodide: PyodideInterface, dataDir: string | null): void {
  const fs = pyodide.FS as {
    mkdirTree: (path: string) => void;
    mount: (type: unknown, options: { root: string }, mountpoint: string) => void;
    unmount: (mountpoint: string) => void;
    filesystems: { NODEFS: unknown };
  };
  try {
    fs.unmount('/data');
  } catch {
    // Nothing mounted yet.
  }
  if (dataDir === null) return;
  fs.mkdirTree('/data');
  fs.mount(fs.filesystems.NODEFS, { root: dataDir }, '/data');
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
    // Agg: matplotlib's Pyodide backend draws through the js module, which the lockdown refuses.
    env: isolated ? { HOME: '/home/pyodide', MPLBACKEND: 'Agg' } : hostEnv,
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
): Promise<Extract<CallableFunctionChildReply, { ok: true }>> {
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
      outputsJson: text(fields.value_json),
      outputProblemsJson: text(fields.output_problems_json),
      printed: (text(fields.stdout) ?? '') + (text(fields.stderr) ?? ''),
      error: text(fields.error),
      errorClass: text(fields.error_class),
    };
  } catch (error) {
    // Only a failure outside the glue's own handling lands here.
    const message = error instanceof Error ? error.message : 'Traceback (most recent call last):\nException';
    // Pyodide's PythonError names the exception's type in `type`; the message is guest text.
    const errorClass = text((error as { type?: unknown } | null)?.type);
    return { ok: true, initMs, printed: '', error: message.slice(0, MAX_ERROR_CHARS), errorClass };
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
      // Pyodide's package loader calls mkdir on its cache directory, here the read-only Pyodide directory, and
      // the permission model refuses every mkdir. An existing directory is reported as made; no write is allowed.
      const { mkdir, stat } = fsPromises;
      Object.assign(fsPromises, {
        mkdir: async (path: string, options?: { recursive?: boolean }) =>
          (await stat(path).catch(() => null))?.isDirectory() ? undefined : mkdir(path, options),
      });
      syncBuiltinESMExports();
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
    try {
      mountData(pyodide, request.dataDir);
    } catch {
      await send({ ok: false, failure: 'load' });
      break;
    }
    if (isolated && !locked) {
      lockDown(pyodide);
      locked = true;
    }
    // Read before guest code runs, so the guest cannot change what the stamp names.
    const packages = Object.keys(pyodide.loadedPackages).sort();
    // The parent's time limit starts here; no guest code has run yet.
    await send({ started: true });
    await send({ ...(await runRequest(pyodide, request, initMs)), packages });
    if (!reuse) break;
  }
  proc.exit(0);
}

main().catch(() => proc.exit(1));
