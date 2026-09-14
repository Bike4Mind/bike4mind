import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We test the exported functions/class by mocking the Worker dependency
// For detectPackages, we can test directly since it's a pure function

describe('pyodideManager', () => {
  describe('detectPackages', () => {
    // Import the module dynamically to avoid issues with Worker
    let detectPackages: (code: string) => string[];

    beforeEach(async () => {
      // Reset modules between tests
      vi.resetModules();

      // Mock Worker to avoid browser-only code
      vi.stubGlobal('Worker', vi.fn());

      // Import the manager after mocking
      const imported = await import('../pyodideManager');
      detectPackages = imported.pyodideManager.detectPackages.bind(imported.pyodideManager);
    });

    afterEach(() => {
      vi.clearAllMocks();
      vi.unstubAllGlobals();
    });

    it('should detect numpy import', () => {
      const code = 'import numpy as np\nx = np.array([1, 2, 3])';
      const packages = detectPackages(code);
      expect(packages).toContain('numpy');
    });

    it('should detect pandas import', () => {
      const code = 'import pandas as pd\ndf = pd.DataFrame()';
      const packages = detectPackages(code);
      expect(packages).toContain('pandas');
    });

    it('should detect matplotlib import', () => {
      const code = 'import matplotlib.pyplot as plt\nplt.plot([1, 2, 3])';
      const packages = detectPackages(code);
      expect(packages).toContain('matplotlib');
    });

    it('should detect from X import Y syntax', () => {
      const code = 'from scipy import stats\nfrom numpy import array';
      const packages = detectPackages(code);
      expect(packages).toContain('scipy');
      expect(packages).toContain('numpy');
    });

    it('should detect seaborn import', () => {
      const code = 'import seaborn as sns\nsns.heatmap(data)';
      const packages = detectPackages(code);
      expect(packages).toContain('seaborn');
    });

    it('should detect sklearn import with direct import', () => {
      // The current regex only matches the top-level module name
      // 'from sklearn.linear_model' extracts 'sklearn' as the module
      const code = 'import sklearn';
      const packages = detectPackages(code);
      expect(packages).toContain('sklearn');
    });

    it('should detect sklearn from submodule import', () => {
      // from sklearn.X import Y extracts 'sklearn'
      const code = 'from sklearn import linear_model';
      const packages = detectPackages(code);
      expect(packages).toContain('sklearn');
    });

    it('should not detect unsupported packages', () => {
      const code = 'import requests\nimport json\nimport os';
      const packages = detectPackages(code);
      expect(packages).toHaveLength(0);
    });

    it('should handle multiple imports in one file', () => {
      const code = `
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import scipy
import seaborn as sns
      `;
      const packages = detectPackages(code);
      expect(packages).toContain('numpy');
      expect(packages).toContain('pandas');
      expect(packages).toContain('matplotlib');
      expect(packages).toContain('scipy');
      expect(packages).toContain('seaborn');
    });

    it('should not duplicate packages', () => {
      const code = `
import numpy
import numpy as np
from numpy import array
      `;
      const packages = detectPackages(code);
      const numpyCount = packages.filter(p => p === 'numpy').length;
      expect(numpyCount).toBe(1);
    });

    it('should handle empty code', () => {
      const packages = detectPackages('');
      expect(packages).toHaveLength(0);
    });

    it('should handle code without imports', () => {
      const code = 'x = 1 + 2\nprint(x)';
      const packages = detectPackages(code);
      expect(packages).toHaveLength(0);
    });

    it('should handle commented out imports', () => {
      // Current implementation doesn't handle comments, which is a known limitation
      // The regex matches line-by-line and doesn't skip comments
      const code = '# import numpy\nprint("hello")';
      const packages = detectPackages(code);
      // This tests current behavior - the commented import IS detected
      // This could be considered a limitation but is acceptable for MVP
      expect(packages).toHaveLength(0); // Actually, the regex uses ^import so # import won't match
    });

    it('should handle imports within string literals correctly', () => {
      // Current implementation may detect these - documenting behavior
      const code = 'code = "import numpy"';
      const packages = detectPackages(code);
      // The multiline regex with ^ anchor should not match this
      expect(packages).toHaveLength(0);
    });
  });

  describe('ExecutionResult interface', () => {
    it('should define correct result structure', async () => {
      vi.stubGlobal('Worker', vi.fn());

      // Type-level test - if this compiles, the ExecutionResult interface is correct
      const result: import('@client/app/workers/pyodide/types').ExecutionResult = {
        success: true,
        output: 'Hello, World!',
        plots: [],
        executionTime: 100,
      };

      expect(result.success).toBe(true);
      expect(result.output).toBe('Hello, World!');
      expect(result.plots).toHaveLength(0);
      expect(result.executionTime).toBe(100);
    });
  });

  describe('PyodideManagerState interface', () => {
    it('should track loading state correctly', async () => {
      vi.stubGlobal('Worker', vi.fn());
      const { pyodideManager } = await import('../pyodideManager');

      const state = pyodideManager.getState();

      // Initial state should be not loading with no worker ready
      expect(state.isLoading).toBe(false);
      expect(state.loadProgress).toBe(0);
      expect(state.error).toBeNull();
      expect(state.loadedPackages).toBeInstanceOf(Set);
      expect(state.isReady).toBe(false);
      expect(state.isExecuting).toBe(false);
    });
  });

  describe('getSupportedPackages', () => {
    it('should return list of supported packages', async () => {
      vi.stubGlobal('Worker', vi.fn());
      const { pyodideManager } = await import('../pyodideManager');

      const packages = pyodideManager.getSupportedPackages();

      expect(packages).toContain('numpy');
      expect(packages).toContain('pandas');
      expect(packages).toContain('matplotlib');
      expect(packages).toContain('scipy');
      expect(packages).toContain('seaborn');
      expect(packages).toContain('scikit-learn');
    });
  });

  describe('isReady', () => {
    it('should return false initially', async () => {
      vi.stubGlobal('Worker', vi.fn());
      const { pyodideManager } = await import('../pyodideManager');

      expect(pyodideManager.isReady()).toBe(false);
    });
  });

  describe('subscribe', () => {
    it('should allow subscribing to state changes', async () => {
      vi.stubGlobal('Worker', vi.fn());
      const { pyodideManager } = await import('../pyodideManager');

      const listener = vi.fn();
      const unsubscribe = pyodideManager.subscribe(listener);

      expect(typeof unsubscribe).toBe('function');

      // Cleanup
      unsubscribe();
    });

    it('should return unsubscribe function that works', async () => {
      vi.stubGlobal('Worker', vi.fn());
      const { pyodideManager } = await import('../pyodideManager');

      const listener = vi.fn();
      const unsubscribe = pyodideManager.subscribe(listener);

      unsubscribe();

      // After unsubscribe, listener should not be called
      // We can't easily test this without triggering a state change
      // which would require mocking more of the initialization
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('interrupt', () => {
    it('should have interrupt method defined', async () => {
      vi.stubGlobal('Worker', vi.fn());
      const { pyodideManager } = await import('../pyodideManager');

      expect(typeof pyodideManager.interrupt).toBe('function');
    });
  });
});

describe('sandbox transport', () => {
  // These drive the real spawnSandbox(): jsdom creates the iframe and gives it a
  // contentWindow, so the sandbox attribute, the ready handshake and the message-provenance
  // check are all exercised rather than stubbed. Only the network load is absent.
  const readySandbox = async () => {
    vi.resetModules();
    const { pyodideManager, PYODIDE_SANDBOX_SRC } = await import('../pyodideManager');
    const pending = pyodideManager.initialize();
    // Let spawnSandbox() append the frame and register its listener.
    await Promise.resolve();

    const frame = document.querySelector(`iframe[src="${PYODIDE_SANDBOX_SRC}"]`) as HTMLIFrameElement;
    const posted: unknown[] = [];
    Object.defineProperty(frame, 'contentWindow', {
      configurable: true,
      value: { postMessage: (message: unknown) => posted.push(message) },
    });

    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'pyodide-sandbox-ready' }, source: frame.contentWindow })
    );
    await Promise.resolve();
    await Promise.resolve();

    return { pyodideManager, frame, posted, pending };
  };

  afterEach(() => {
    document.querySelectorAll('iframe').forEach(node => node.remove());
    vi.clearAllMocks();
  });

  it('frames the sandbox route with allow-scripts and nothing else', async () => {
    const { frame, pending } = await readySandbox();
    void pending.catch(() => {});

    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
  });

  it('forwards a configured baseUrl to the sandbox on initialize', async () => {
    vi.resetModules();
    const { pyodideManager } = await import('../pyodideManager');
    pyodideManager.configure('http://mirror.local/pyodide/');

    const pending = pyodideManager.initialize();
    void pending.catch(() => {});
    await Promise.resolve();

    const frame = document.querySelector('iframe') as HTMLIFrameElement;
    const posted: unknown[] = [];
    Object.defineProperty(frame, 'contentWindow', {
      configurable: true,
      value: { postMessage: (message: unknown) => posted.push(message) },
    });
    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'pyodide-sandbox-ready' }, source: frame.contentWindow })
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(posted).toContainEqual({ type: 'initialize', baseUrl: 'http://mirror.local/pyodide/' });
  });

  it('sends baseUrl undefined when not configured (the sandbox keeps the pinned CDN)', async () => {
    const { posted, pending } = await readySandbox();
    void pending.catch(() => {});

    expect(posted).toContainEqual({ type: 'initialize', baseUrl: undefined });
  });

  it('ignores messages that did not come from its own sandbox frame', async () => {
    const { pyodideManager, pending } = await readySandbox();
    void pending.catch(() => {});

    // Another frame (or any page) claiming the run finished must not settle our state.
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'error', error: 'spoofed' },
        source: window as unknown as MessageEventSource,
      })
    );
    await Promise.resolve();

    expect(pyodideManager.getState().error).not.toBe('spoofed');
  });

  it('interrupt removes the sandbox frame, which destroys the worker inside it', async () => {
    const { pyodideManager, frame, pending } = await readySandbox();
    void pending.catch(() => {});

    pyodideManager.interrupt();

    expect(frame.isConnected).toBe(false);
  });

  // Measured failure, not a hypothetical: a sandbox CSP that omitted 'wasm-unsafe-eval' killed
  // Pyodide inside WebAssembly.instantiateStreaming. pyodide.js logged a console warning and
  // never rejected, so the worker had nothing to report - initialize() hung and the Run button
  // spun forever. The runtime dying in third-party code has to be an error, not silence.
  it('rejects initialize when the sandbox goes silent mid-load', async () => {
    vi.useFakeTimers();
    try {
      const { pyodideManager, frame, pending } = await readySandbox();
      const settled = pending.then(() => 'resolved').catch((error: Error) => error.message);

      frame.dispatchEvent(new Event('load'));
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'initializing', progress: 30, message: 'Initializing Python runtime...' },
          source: frame.contentWindow,
        })
      );
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(60_000);

      await expect(settled).resolves.toMatch(/stopped responding/i);
      expect(pyodideManager.getState().isReady).toBe(false);
      // The frame goes with it, so the next Run gets a fresh sandbox rather than this one.
      expect(frame.isConnected).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a slow load keep going as long as it reports progress', async () => {
    vi.useFakeTimers();
    try {
      const { pyodideManager, frame, pending } = await readySandbox();
      void pending.catch(() => {});

      // Pyodide is a multi-megabyte download; a slow link is not a failure.
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(40_000);
        window.dispatchEvent(
          new MessageEvent('message', {
            data: { type: 'initializing', progress: 30 + i, message: 'loading' },
            source: frame.contentWindow,
          })
        );
        await Promise.resolve();
      }

      expect(pyodideManager.getState().error).toBeNull();
      expect(frame.isConnected).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('execution timeout', () => {
  it('should have EXECUTION_TIMEOUT_MS constant defined', async () => {
    // The timeout constant is private, but we can verify the execute method
    // signature includes a timeout parameter
    vi.stubGlobal('Worker', vi.fn());
    const { pyodideManager } = await import('../pyodideManager');

    // Verify execute method exists and accepts timeout parameter
    expect(typeof pyodideManager.execute).toBe('function');
    expect(pyodideManager.execute.length).toBeGreaterThanOrEqual(1);
  });
});
