import type { PyodideWorkerMessage, PyodideWorkerResponse, ExecutionResult } from './types';

/**
 * The Pyodide worker, as a self-contained function.
 *
 * This does not run here. `/api/pyodide-sandbox` serializes it with `Function.prototype
 * .toString()` and the sandbox shell turns that text into a `blob:` Worker, because the shell
 * runs in an OPAQUE origin (see the route) and an opaque-origin document can neither construct
 * a Worker from an app-origin URL nor fetch one without CORS. Shipping the source through the
 * document is the only route in that does not hand the sandbox a way to talk to the app.
 *
 * Two rules follow from being serialized, and breaking either fails only at runtime:
 *
 * 1. **Reference nothing outside this function.** No imports, no module-scope constants, no
 *    helpers. `toString()` captures the body, never the closure, so an outer reference becomes
 *    a ReferenceError inside the worker. Type-only imports are fine - they are erased.
 * 2. **Emit no TypeScript downlevel helpers.** The package targets ES2018, so async/await and
 *    optional chaining compile natively and none are generated today. A future target change
 *    could inject `__awaiter`, which lives in module scope and would not survive `toString()`.
 *    `sandboxWorkerBody.test.ts` fails the build if one appears.
 */
export function pyodideSandboxWorkerBody(): void {
  const DEFAULT_PYODIDE_BASE_URL = 'https://cdn.jsdelivr.net/pyodide/v0.25.1/full/';
  const SUPPORTED_PACKAGES = ['numpy', 'pandas', 'matplotlib', 'scipy', 'scikit-learn'];
  // Import name -> distribution name, for the micropip backstop.
  const PACKAGE_NAME_MAP: Record<string, string> = {
    sklearn: 'scikit-learn',
  };

  interface PyodideInterface {
    loadPackage: (packages: string | string[]) => Promise<void>;
    loadPackagesFromImports: (
      code: string,
      options?: { messageCallback?: (message: string) => void }
    ) => Promise<unknown[]>;
    loadedPackages: Record<string, string>;
    pyimport: (name: string) => { install: (pkg: string) => Promise<void> };
    runPythonAsync: (
      code: string
    ) => Promise<{ toJs: (options: { dict_converter: typeof Object.fromEntries }) => Record<string, unknown> }>;
    globals: {
      set: (name: string, value: unknown) => void;
      delete: (name: string) => void;
    };
    FS: {
      analyzePath: (path: string) => { exists: boolean };
      mkdir: (path: string) => void;
      readdir: (path: string) => string[];
      lstat: (path: string) => { mode: number };
      isDir: (mode: number) => boolean;
      writeFile: (path: string, data: Uint8Array) => void;
      chmod: (path: string, mode: number) => void;
      lchmod: (path: string, mode: number) => void;
      unlink: (path: string) => void;
      rmdir: (path: string) => void;
    };
  }

  let pyodideBaseUrl = DEFAULT_PYODIDE_BASE_URL;
  let pyodide: PyodideInterface | null = null;
  const loadedPackages = new Set<string>();
  let cancelled = false;

  // Bound once at start, so guest code that replaces `self.postMessage` through `js` never sees a call's nonce.
  const postToParent = self.postMessage.bind(self);
  const post = (response: PyodideWorkerResponse): void => postToParent(response);

  async function initializePyodide(): Promise<void> {
    if (pyodide) {
      post({ type: 'ready' });
      return;
    }

    try {
      post({ type: 'initializing', progress: 10, message: 'Loading Pyodide script...' });
      importScripts(`${pyodideBaseUrl}pyodide.js`);

      post({ type: 'initializing', progress: 30, message: 'Initializing Python runtime...' });
      const loadPyodide = (
        self as unknown as { loadPyodide: (config: { indexURL: string }) => Promise<PyodideInterface> }
      ).loadPyodide;
      pyodide = await loadPyodide({ indexURL: pyodideBaseUrl });

      post({ type: 'initializing', progress: 60, message: 'Loading package manager...' });
      await pyodide.loadPackage('micropip');
      loadedPackages.add('micropip');

      post({ type: 'initializing', progress: 80, message: 'Configuring matplotlib...' });
      await setupMatplotlib();

      post({ type: 'ready' });
    } catch (error) {
      post({ type: 'error', error: error instanceof Error ? error.message : 'Failed to initialize Pyodide' });
    }
  }

  async function setupMatplotlib(): Promise<void> {
    if (!pyodide) return;

    const micropip = pyodide.pyimport('micropip');
    await micropip.install('matplotlib');
    loadedPackages.add('matplotlib');

    await pyodide.runPythonAsync(`
import sys
import io

# Configure matplotlib for headless rendering
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

# Figures are captured after the run, so the plt.show() a script ends with is not a mistake
# here - without this, its Agg warning is all the stderr a plotting script produces.
import warnings
warnings.filterwarnings('ignore', message='.*non-GUI backend.*')

def _capture_plot():
    """Capture current matplotlib figure as base64 PNG"""
    import base64
    buf = io.BytesIO()
    plt.savefig(buf, format='png', bbox_inches='tight', dpi=100)
    buf.seek(0)
    img_base64 = base64.b64encode(buf.read()).decode('utf-8')
    plt.close('all')
    return img_base64

# Store in builtins for easy access
import builtins
builtins._capture_plot = _capture_plot
`);
  }

  /**
   * Load what the code imports before any of it runs. Pyodide's own import scan (an AST walk,
   * so dotted and nested imports count) is the primary path; the caller's `packages` list is a
   * micropip backstop for anything it does not resolve.
   */
  async function loadPackages(code: string, packages: string[]): Promise<void> {
    if (!pyodide) return;
    const runtime = pyodide;

    try {
      await runtime.loadPackagesFromImports(code, {
        messageCallback: message => {
          if (message && message.trim()) post({ type: 'executing', message });
        },
      });
    } catch (error) {
      // Not fatal: an import that is still missing fails at execution with a clear error.
      console.warn('[PyodideWorker] loadPackagesFromImports failed:', error);
    }

    const micropip = runtime.pyimport('micropip');
    const packagesToLoad = packages
      .map(pkg => PACKAGE_NAME_MAP[pkg] || pkg)
      .filter(pkg => SUPPORTED_PACKAGES.includes(pkg) && !loadedPackages.has(pkg) && !(pkg in runtime.loadedPackages));

    for (const pkg of packagesToLoad) {
      try {
        await micropip.install(pkg);
        loadedPackages.add(pkg);
      } catch (error) {
        console.warn(`[PyodideWorker] Failed to load package ${pkg}:`, error);
      }
    }
  }

  async function executePython(code: string, packages: string[]): Promise<void> {
    if (!pyodide) {
      post({ type: 'error', error: 'Pyodide not initialized' });
      return;
    }

    cancelled = false;
    const startTime = performance.now();

    try {
      post({
        type: 'executing',
        message: packages.length > 0 ? `Loading packages: ${packages.join(', ')}` : 'Preparing...',
      });

      await loadPackages(code, packages);

      if (cancelled) {
        const cancelResult: ExecutionResult = {
          success: false,
          output: '',
          error: 'Execution cancelled',
          plots: [],
          executionTime: performance.now() - startTime,
        };
        post({ type: 'result', result: cancelResult });
        return;
      }

      const streamOutput = (text: string): void => {
        if (text && text.trim()) {
          post({ type: 'output', output: text });
        }
      };
      pyodide.globals.set('_stream_output', streamOutput);
      post({ type: 'executing', message: 'Running...' });

      const indentedCode = code
        .split('\n')
        .map(line => '    ' + line)
        .join('\n');

      const wrappedCode = `
import sys
from io import StringIO
import builtins

# Streaming stdout that sends output to JS in real-time
class _StreamingStdout:
    def __init__(self, stream_callback):
        self._callback = stream_callback
        self._buffer = []

    def write(self, text):
        if text:
            self._buffer.append(text)
            self._callback(text)

    def flush(self):
        pass

    def getvalue(self):
        return ''.join(self._buffer)

# Set up streaming stdout
_stdout_stream = _StreamingStdout(_stream_output)
_stderr_capture = StringIO()
_original_stdout = sys.stdout
_original_stderr = sys.stderr
sys.stdout = _stdout_stream
sys.stderr = _stderr_capture

_plots = []
_error = None

try:
    # User code
${indentedCode}

    # Capture any matplotlib plots
    try:
        import matplotlib.pyplot as plt
        if plt.get_fignums():
            _plots.append(builtins._capture_plot())
    except ImportError:
        pass

except Exception as e:
    import traceback
    _error = traceback.format_exc()
finally:
    sys.stdout = _original_stdout
    sys.stderr = _original_stderr

_result = {
    'stdout': _stdout_stream.getvalue(),
    'stderr': _stderr_capture.getvalue(),
    'plots': _plots,
    'error': _error
}
_result
`;

      const result = await pyodide.runPythonAsync(wrappedCode);
      const resultObj = result.toJs({ dict_converter: Object.fromEntries }) as {
        stdout: string;
        stderr: string;
        plots: string[];
        error: string | null;
      };

      // Only an exception fails a run. Stderr alone is warnings and diagnostics, so it reads
      // as output after stdout rather than turning a working script into an error.
      const executionResult: ExecutionResult = {
        success: !resultObj.error,
        output: (resultObj.stdout || '') + (resultObj.stderr || ''),
        error: resultObj.error || undefined,
        plots: resultObj.plots || [],
        executionTime: performance.now() - startTime,
      };
      post({ type: 'result', result: executionResult });
    } catch (error) {
      const errorResult: ExecutionResult = {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : String(error),
        plots: [],
        executionTime: performance.now() - startTime,
      };
      post({ type: 'result', result: errorResult });
    } finally {
      if (pyodide) {
        pyodide.globals.delete('_stream_output');
      }
    }
  }

  /**
   * Load the code as module `b4m_function` (so a `__main__` block does not run), read FUNCTION and, given
   * params, call `run(**params)`. Code and params enter through globals, never interpolation; only strings return.
   */
  async function callFunction(
    code: string,
    packages: string[],
    paramsJson: string | null,
    nonce: string,
    files: { name: string; bytes: ArrayBuffer }[]
  ): Promise<void> {
    const startTime = performance.now();
    const fail = (error: string): void =>
      post({
        type: 'call-result',
        nonce,
        result: { success: false, output: '', error, executionTime: performance.now() - startTime },
      });
    if (!pyodide) {
      fail('Pyodide not initialized');
      return;
    }

    cancelled = false;
    let globalsSet = false;
    try {
      post({
        type: 'executing',
        message: packages.length > 0 ? `Loading packages: ${packages.join(', ')}` : 'Preparing...',
      });
      await loadPackages(code, packages);
      if (cancelled) {
        fail('Execution cancelled');
        return;
      }
      // One Pyodide serves every call, so /data is emptied first; files and directory are then made read-only.
      const fs = pyodide.FS;
      // lstat and lchmod so a guest's symlink is removed itself, never followed out of /data.
      const empty = (dir: string) => {
        for (const entry of fs.readdir(dir)) {
          if (entry === '.' || entry === '..') continue;
          const path = `${dir}/${entry}`;
          if (fs.isDir(fs.lstat(path).mode)) {
            fs.lchmod(path, 0o755);
            empty(path);
            fs.rmdir(path);
          } else {
            fs.lchmod(path, 0o644);
            fs.unlink(path);
          }
        }
      };
      const lstatOrNull = (path: string) => {
        try {
          return fs.lstat(path);
        } catch {
          return null;
        }
      };
      // A guest may have replaced /data with a file or a symlink; the link itself goes, its target is never touched.
      const existing = lstatOrNull('/data');
      if (existing && !fs.isDir(existing.mode)) fs.unlink('/data');
      if (existing && fs.isDir(existing.mode)) {
        fs.chmod('/data', 0o755);
        empty('/data');
      } else if (files.length > 0) {
        fs.mkdir('/data');
      }
      for (const file of files) {
        // Must stay in sync with CALLABLE_FUNCTION_DATA_PIN_NAME_PATTERN, which this serialized body cannot import.
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(file.name)) throw new Error('Invalid data file name');
        fs.writeFile(`/data/${file.name}`, new Uint8Array(file.bytes));
        fs.chmod(`/data/${file.name}`, 0o444);
      }
      if (lstatOrNull('/data')) fs.chmod('/data', 0o555);
      post({ type: 'executing', message: 'Running...' });

      pyodide.globals.set('_fn_code', code);
      pyodide.globals.set('_fn_params_json', paramsJson);
      globalsSet = true;

      // Plain compile() refuses top-level await, so `async def run` is refused by name instead. The caps match
      // MAX_FUNCTION_OUTPUT_CHARS and FUNCTION_CONTRACT_LIMITS, which the parent applies again; json.dumps output
      // is ASCII, so its length is its size in bytes.
      const wrapper = `
import sys
import json
import inspect
import traceback
from io import StringIO

_MAX_OUTPUT_CHARS = 100000
_MAX_CONTRACT_BYTES = 32768
_MAX_RESULT_BYTES = 5242880
_MAX_PROBLEMS = 50

class _FunctionCallError(Exception):
    pass

# JSON turns 3.0 into 3 and True into true, so number types are checked while Python still knows them.
def _output_type_problems(field, value, path, problems):
    if len(problems) > _MAX_PROBLEMS or not isinstance(field, dict):
        return
    kind = field.get('type')
    if kind in ('number', 'integer'):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            problems.append({'path': path, 'message': 'must be a number'})
        elif kind == 'integer' and not isinstance(value, int):
            problems.append({'path': path, 'message': 'must be a whole number'})
    elif kind == 'array' and isinstance(value, (list, tuple)):
        for index, item in enumerate(value):
            _output_type_problems(field.get('items'), item, path + '.' + str(index) if path else str(index), problems)
    elif kind == 'object' and isinstance(value, dict) and isinstance(field.get('properties'), dict):
        for name, item in value.items():
            if isinstance(name, str) and name in field['properties']:
                _output_type_problems(field['properties'][name], item, path + '.' + name if path else name, problems)

# The class name as traceback prints it, taken from the exception's type so a message cannot change it.
def _error_class(e):
    try:
        kind = type(e)
        name = kind.__qualname__ if kind.__module__ in ('builtins', '__main__') else kind.__module__ + '.' + kind.__qualname__
        return str(name)[:100]
    except Exception:
        return 'Exception'

def _b4m_call_function(code, params_json):
    stdout = StringIO()
    stderr = StringIO()
    original_stdout = sys.stdout
    original_stderr = sys.stderr
    sys.stdout = stdout
    sys.stderr = stderr
    contract_json = None
    value_json = None
    output_problems = []
    error = None
    error_class = None
    try:
        namespace = {'__name__': 'b4m_function'}
        exec(compile(code, 'function.py', 'exec'), namespace)
        contract = namespace.get('FUNCTION')
        if contract is None:
            raise _FunctionCallError('FUNCTION is not defined')
        try:
            contract_text = json.dumps(contract, allow_nan=False)
        except (TypeError, ValueError) as e:
            raise _FunctionCallError('FUNCTION is not valid JSON: ' + str(e))
        if len(contract_text) > _MAX_CONTRACT_BYTES:
            raise _FunctionCallError('The function contract is larger than 32 KB.')
        contract_json = contract_text
        if params_json is not None:
            run = namespace.get('run')
            if not callable(run):
                raise _FunctionCallError('run is not defined as a function')
            if inspect.iscoroutinefunction(run):
                raise _FunctionCallError('run must be defined with def, not async def')
            value = run(**json.loads(params_json))
            if not isinstance(value, dict):
                raise _FunctionCallError('run must return a dict')
            try:
                value_text = json.dumps(value, allow_nan=False)
            except (TypeError, ValueError) as e:
                raise _FunctionCallError('run returned a value that is not valid JSON: ' + str(e))
            if len(value_text) > _MAX_RESULT_BYTES:
                raise _FunctionCallError('The function returned a result larger than 5 MB.')
            value_json = value_text
            _output_type_problems(contract.get('outputs'), value, '', output_problems)
    except _FunctionCallError as e:
        error = str(e)
    except BaseException as e:
        error = traceback.format_exc()
        error_class = _error_class(e)
    finally:
        sys.stdout = original_stdout
        sys.stderr = original_stderr
    return {
        'contract_json': contract_json,
        'value_json': value_json,
        'output_problems_json': json.dumps(output_problems) if output_problems else None,
        'stdout': stdout.getvalue()[:_MAX_OUTPUT_CHARS],
        'stderr': stderr.getvalue()[:_MAX_OUTPUT_CHARS],
        'error': None if error is None else error[:_MAX_OUTPUT_CHARS],
        'error_class': error_class,
    }

_b4m_call_function(_fn_code, _fn_params_json)
`;

      const result = await pyodide.runPythonAsync(wrapper);
      const resultObj = result.toJs({ dict_converter: Object.fromEntries });
      const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
      const error = text(resultObj.error);
      post({
        type: 'call-result',
        nonce,
        result: {
          success: !error,
          contractJson: text(resultObj.contract_json),
          valueJson: text(resultObj.value_json),
          outputProblemsJson: text(resultObj.output_problems_json),
          output: (text(resultObj.stdout) || '') + (text(resultObj.stderr) || ''),
          error,
          executionTime: performance.now() - startTime,
        },
      });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    } finally {
      if (pyodide && globalsSet) {
        pyodide.globals.delete('_fn_code');
        pyodide.globals.delete('_fn_params_json');
      }
    }
  }

  self.onmessage = async (event: MessageEvent<PyodideWorkerMessage>): Promise<void> => {
    const msg = event.data;

    switch (msg.type) {
      case 'initialize':
        // A configured mirror overrides the default CDN. Normalize the trailing slash so
        // both `${base}pyodide.js` and the loadPyodide indexURL resolve correctly.
        if (msg.baseUrl) {
          pyodideBaseUrl = msg.baseUrl.endsWith('/') ? msg.baseUrl : `${msg.baseUrl}/`;
        }
        await initializePyodide();
        break;

      case 'execute':
        await executePython(msg.code, msg.packages);
        break;

      case 'call':
        await callFunction(msg.code, msg.packages, msg.paramsJson, msg.nonce, msg.files ?? []);
        break;

      case 'cancel':
        cancelled = true;
        break;
    }
  };
}
