/**
 * Pyodide Web Worker: runs Python off the main thread via Pyodide WebAssembly.
 * Terminating the worker immediately stops infinite loops.
 *
 * Protocol:
 *   Main -> Worker:  PyodideWorkerMessage  (initialize | execute | cancel)
 *   Worker -> Main:  PyodideWorkerResponse (initializing | ready | executing | result | error)
 */

import type { PyodideWorkerMessage, PyodideWorkerResponse, ExecutionResult } from './types';

// Default Pyodide distribution (public CDN). The initialize message may override this with a
// self-hosted mirror (PYODIDE_BASE_URL) so Python artifacts work offline / air-gapped.
const DEFAULT_PYODIDE_BASE_URL = 'https://cdn.jsdelivr.net/pyodide/v0.25.1/full/';

let pyodideBaseUrl = DEFAULT_PYODIDE_BASE_URL;

// Supported packages (pre-built in Pyodide)
const SUPPORTED_PACKAGES = ['numpy', 'pandas', 'matplotlib', 'scipy', 'seaborn', 'scikit-learn'];

// Package name mapping (npm name -> Pyodide package name)
const PACKAGE_NAME_MAP: Record<string, string> = {
  'scikit-learn': 'sklearn',
  sklearn: 'sklearn',
};

let pyodide: PyodideInterface | null = null;
const loadedPackages: Set<string> = new Set();
let cancelled = false;

// Pyodide type (minimal interface for worker context)
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

async function loadPyodideScript(): Promise<void> {
  const scriptUrl = `${pyodideBaseUrl}pyodide.js`;

  const response: PyodideWorkerResponse = {
    type: 'initializing',
    progress: 10,
    message: 'Loading Pyodide script...',
  };
  self.postMessage(response);

  // Use importScripts for synchronous script loading in worker
  importScripts(scriptUrl);
}

async function initializePyodide(): Promise<void> {
  if (pyodide) {
    const response: PyodideWorkerResponse = { type: 'ready' };
    self.postMessage(response);
    return;
  }

  try {
    await loadPyodideScript();

    const progressResponse: PyodideWorkerResponse = {
      type: 'initializing',
      progress: 30,
      message: 'Initializing Python runtime...',
    };
    self.postMessage(progressResponse);

    // loadPyodide is now available globally after importScripts
    // Type assertion needed since this is loaded dynamically
    const loadPyodide = (
      self as unknown as { loadPyodide: (config: { indexURL: string }) => Promise<PyodideInterface> }
    ).loadPyodide;

    pyodide = await loadPyodide({
      indexURL: pyodideBaseUrl,
    });

    const micropipResponse: PyodideWorkerResponse = {
      type: 'initializing',
      progress: 60,
      message: 'Loading package manager...',
    };
    self.postMessage(micropipResponse);

    // Pre-load micropip for package management
    await pyodide.loadPackage('micropip');
    loadedPackages.add('micropip');

    const matplotlibResponse: PyodideWorkerResponse = {
      type: 'initializing',
      progress: 80,
      message: 'Configuring matplotlib...',
    };
    self.postMessage(matplotlibResponse);

    // Set up matplotlib for headless rendering
    await setupMatplotlib();

    const readyResponse: PyodideWorkerResponse = { type: 'ready' };
    self.postMessage(readyResponse);
  } catch (error) {
    const errorResponse: PyodideWorkerResponse = {
      type: 'error',
      error: error instanceof Error ? error.message : 'Failed to initialize Pyodide',
    };
    self.postMessage(errorResponse);
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

async function executePython(code: string, packages: string[], timeoutMs: number): Promise<void> {
  if (!pyodide) {
    const errorResponse: PyodideWorkerResponse = {
      type: 'error',
      error: 'Pyodide not initialized',
    };
    self.postMessage(errorResponse);
    return;
  }

  cancelled = false;
  const startTime = performance.now();

  try {
    // Load required packages
    const loadingResponse: PyodideWorkerResponse = {
      type: 'executing',
      message: packages.length > 0 ? `Loading packages: ${packages.join(', ')}` : 'Executing...',
    };
    self.postMessage(loadingResponse);

    await loadPackages(packages);

    if (cancelled) {
      const cancelResult: ExecutionResult = {
        success: false,
        output: '',
        error: 'Execution cancelled',
        plots: [],
        executionTime: performance.now() - startTime,
      };
      const cancelResponse: PyodideWorkerResponse = { type: 'result', result: cancelResult };
      self.postMessage(cancelResponse);
      return;
    }

    // Set up streaming output callback
    const streamOutput = (text: string) => {
      if (text && text.trim()) {
        const outputResponse: PyodideWorkerResponse = { type: 'output', output: text };
        self.postMessage(outputResponse);
      }
    };
    pyodide.globals.set('_stream_output', streamOutput);

    // Indent user code for wrapping
    const indentedCode = code
      .split('\n')
      .map(line => '    ' + line)
      .join('\n');

    // Wrap code to capture output and plots with streaming stdout
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

    const executionTime = performance.now() - startTime;
    const hasError = resultObj.error || resultObj.stderr;

    const executionResult: ExecutionResult = {
      success: !hasError,
      output: resultObj.stdout || '',
      error: resultObj.error || resultObj.stderr || undefined,
      plots: resultObj.plots || [],
      executionTime,
    };

    const resultResponse: PyodideWorkerResponse = { type: 'result', result: executionResult };
    self.postMessage(resultResponse);
  } catch (error) {
    const executionTime = performance.now() - startTime;
    const errorResult: ExecutionResult = {
      success: false,
      output: '',
      error: error instanceof Error ? error.message : String(error),
      plots: [],
      executionTime,
    };
    const errorResponse: PyodideWorkerResponse = { type: 'result', result: errorResult };
    self.postMessage(errorResponse);
  } finally {
    // Clean up the streaming callback from globals
    if (pyodide) {
      pyodide.globals.delete('_stream_output');
    }
  }
}

self.onmessage = async (e: MessageEvent<PyodideWorkerMessage>) => {
  const msg = e.data;

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
      await executePython(msg.code, msg.packages, msg.timeoutMs);
      break;

    case 'cancel':
      cancelled = true;
      break;
  }
};
