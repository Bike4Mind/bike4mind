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
  const SUPPORTED_PACKAGES = ['numpy', 'pandas', 'matplotlib', 'scipy', 'seaborn', 'scikit-learn'];
  const PACKAGE_NAME_MAP: Record<string, string> = {
    'scikit-learn': 'sklearn',
    sklearn: 'sklearn',
  };

  interface PyodideInterface {
    loadPackage: (packages: string | string[]) => Promise<void>;
    pyimport: (name: string) => { install: (pkg: string) => Promise<void> };
    runPythonAsync: (
      code: string
    ) => Promise<{ toJs: (options: { dict_converter: typeof Object.fromEntries }) => Record<string, unknown> }>;
    globals: {
      set: (name: string, value: unknown) => void;
      delete: (name: string) => void;
    };
  }

  let pyodideBaseUrl = DEFAULT_PYODIDE_BASE_URL;
  let pyodide: PyodideInterface | null = null;
  const loadedPackages = new Set<string>();
  let cancelled = false;

  const post = (response: PyodideWorkerResponse): void => self.postMessage(response);

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

  async function loadPackages(packages: string[]): Promise<void> {
    if (!pyodide) return;

    const micropip = pyodide.pyimport('micropip');

    const packagesToLoad = packages.filter(pkg => {
      const normalizedPkg = PACKAGE_NAME_MAP[pkg] || pkg;
      return (
        SUPPORTED_PACKAGES.some(supported => supported === pkg || PACKAGE_NAME_MAP[supported] === normalizedPkg) &&
        !loadedPackages.has(normalizedPkg)
      );
    });

    for (const pkg of packagesToLoad) {
      const pyodidePkgName = PACKAGE_NAME_MAP[pkg] || pkg;
      try {
        await micropip.install(pyodidePkgName);
        loadedPackages.add(pyodidePkgName);
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
        message: packages.length > 0 ? `Loading packages: ${packages.join(', ')}` : 'Executing...',
      });

      await loadPackages(packages);

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

      const hasError = resultObj.error || resultObj.stderr;
      const executionResult: ExecutionResult = {
        success: !hasError,
        output: resultObj.stdout || '',
        error: resultObj.error || resultObj.stderr || undefined,
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

      case 'cancel':
        cancelled = true;
        break;
    }
  };
}
