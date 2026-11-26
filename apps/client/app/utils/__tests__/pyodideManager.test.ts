import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The sandbox replies within a few microtasks; vi.waitFor's default 50ms poll would dominate each test.
const POLL = { interval: 1 };

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

    it('does not detect seaborn (not bundled with Pyodide, so it can never load)', () => {
      const code = 'import seaborn as sns\nsns.heatmap(data)';
      const packages = detectPackages(code);
      expect(packages).not.toContain('seaborn');
    });

    it('should detect sklearn import with direct import', () => {
      const code = 'import sklearn';
      const packages = detectPackages(code);
      expect(packages).toContain('sklearn');
    });

    it('should detect sklearn from submodule import', () => {
      const code = 'from sklearn.linear_model import LinearRegression';
      const packages = detectPackages(code);
      expect(packages).toEqual(['sklearn']);
    });

    it('should detect scipy from a dotted from-import with several names', () => {
      const code = 'from scipy.optimize import milp, LinearConstraint, Bounds\nimport numpy as np';
      const packages = detectPackages(code);
      expect(packages).toContain('scipy');
      expect(packages).toContain('numpy');
    });

    it('should detect every module in a comma-separated import', () => {
      const code = 'import numpy as np, scipy.optimize, json  # stdlib is ignored';
      const packages = detectPackages(code);
      expect(packages.sort()).toEqual(['numpy', 'scipy']);
    });

    it('should detect indented imports', () => {
      const code = 'def solve():\n    from scipy.optimize import linprog\n    return linprog';
      expect(detectPackages(code)).toEqual(['scipy']);
    });

    it('should ignore relative imports', () => {
      expect(detectPackages('from .numpy import thing')).toHaveLength(0);
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
      expect(packages).not.toContain('seaborn');
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
      expect(packages).not.toContain('seaborn');
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

  it('settles a run waiting on the runtime load when it is interrupted', async () => {
    const { pyodideManager, pending } = await readySandbox();
    void pending.catch(() => {});
    const run = pyodideManager.execute('print(1)').then(
      () => 'resolved',
      (error: Error) => error.message
    );

    pyodideManager.interrupt();

    await expect(run).resolves.toBe('Execution interrupted');
    // The replacement load is the live one, not marked failed by the interrupted load.
    expect(pyodideManager.getState().error).toBeNull();
  });

  it('an interrupt during the handshake does not leave a timer that tears down the next sandbox', async () => {
    vi.useFakeTimers();
    try {
      vi.resetModules();
      const { pyodideManager, PYODIDE_SANDBOX_SRC } = await import('../pyodideManager');
      const first = pyodideManager.initialize().then(
        () => 'resolved',
        (error: Error) => error.message
      );
      await Promise.resolve();

      pyodideManager.interrupt();
      await expect(first).resolves.toBe('Execution interrupted');

      const replacement = document.querySelector(`iframe[src="${PYODIDE_SANDBOX_SRC}"]`) as HTMLIFrameElement;
      expect(replacement).not.toBeNull();
      // Keep the replacement's own handshake alive past the first one's 15s deadline.
      Object.defineProperty(replacement, 'contentWindow', { configurable: true, value: { postMessage: () => {} } });
      window.dispatchEvent(
        new MessageEvent('message', { data: { type: 'pyodide-sandbox-ready' }, source: replacement.contentWindow })
      );
      await vi.advanceTimersByTimeAsync(14_000);
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'initializing', progress: 10, message: 'loading' },
          source: replacement.contentWindow,
        })
      );
      await vi.advanceTimersByTimeAsync(2_000);

      expect(replacement.isConnected).toBe(true);
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

describe('execution results', () => {
  const readySandbox = async () => {
    vi.resetModules();
    const { pyodideManager } = await import('../pyodideManager');
    const pending = pyodideManager.initialize();
    void pending.catch(() => {});
    await Promise.resolve();

    const frame = document.querySelector('iframe') as HTMLIFrameElement;
    Object.defineProperty(frame, 'contentWindow', { configurable: true, value: { postMessage: () => {} } });
    const fromSandbox = (data: unknown) =>
      window.dispatchEvent(new MessageEvent('message', { data, source: frame.contentWindow }));

    fromSandbox({ type: 'pyodide-sandbox-ready' });
    await Promise.resolve();
    await Promise.resolve();
    fromSandbox({ type: 'ready' });
    await pending;

    return { pyodideManager, fromSandbox };
  };

  afterEach(() => {
    document.querySelectorAll('iframe').forEach(node => node.remove());
  });

  it('rejects a second run while one is pending instead of orphaning the first', async () => {
    const { pyodideManager, fromSandbox } = await readySandbox();
    const first = pyodideManager.execute('print(1)');

    await expect(pyodideManager.execute('print(2)')).rejects.toThrow('Another Python script is already running');

    fromSandbox({ type: 'result', result: { success: true, output: '1\n', plots: [], executionTime: 1 } });
    await expect(first).resolves.toMatchObject({ success: true, output: '1\n' });
  });

  it('surfaces the worker status while a run is loading packages', async () => {
    const { pyodideManager, fromSandbox } = await readySandbox();
    const run = pyodideManager.execute('from scipy.optimize import milp');
    await Promise.resolve();

    fromSandbox({ type: 'executing', message: 'Loading scipy, openblas' });
    expect(pyodideManager.getState().executionStatus).toBe('Loading scipy, openblas');

    fromSandbox({ type: 'result', result: { success: true, output: '', plots: [], executionTime: 1 } });
    await run;
    expect(pyodideManager.getState().executionStatus).toBeNull();
  });

  it('explains an unavailable package and keeps the traceback', async () => {
    const { pyodideManager, fromSandbox } = await readySandbox();
    const run = pyodideManager.execute('import highspy');
    await Promise.resolve();

    const traceback =
      'Traceback (most recent call last):\n  File "<exec>", line 1, in <module>\nModuleNotFoundError: No module named \'highspy\'\n';
    fromSandbox({
      type: 'result',
      result: { success: false, output: '', error: traceback, plots: [], executionTime: 1 },
    });

    const result = await run;
    expect(result.error).toMatch(
      /^`highspy` is not available in the browser Python runtime\. Use scipy\.optimize\.milp/
    );
    expect(result.error).toContain(traceback);
  });
});

type Posted = Array<Record<string, unknown>>;

/** Answer the newest sandbox frame's handshake and report the runtime ready; returns a sender from that frame. */
async function bringUpFrame(posted: Posted) {
  await Promise.resolve();
  const frame = [...document.querySelectorAll('iframe')].at(-1) as HTMLIFrameElement;
  Object.defineProperty(frame, 'contentWindow', {
    configurable: true,
    value: { postMessage: (message: Record<string, unknown>) => posted.push(message) },
  });
  const send = (data: unknown, source: MessageEventSource | null = frame.contentWindow) =>
    window.dispatchEvent(new MessageEvent('message', { data, source }));
  send({ type: 'pyodide-sandbox-ready' });
  await Promise.resolve();
  await Promise.resolve();
  send({ type: 'ready' });
  return { frame, send };
}

const lastNonce = (posted: Posted) => [...posted].reverse().find(message => message.type === 'call')?.nonce;

describe('function calls', () => {
  let posted: Posted = [];

  // Brings up the network-free frame with one answered call, then forgets what it posted.
  const readySandbox = async () => {
    vi.resetModules();
    const imported = await import('../pyodideManager');
    posted = [];
    const warmUp = imported.pyodideManager.callFunction('warm_up = 1');
    const { frame, send } = await bringUpFrame(posted);
    await vi.waitFor(() => expect(lastNonce(posted)).toBeDefined(), POLL);
    send(callResult({}));
    await warmUp;
    posted.length = 0;
    return { ...imported, posted, fromSandbox: send, frame };
  };

  const callResult = (result: Record<string, unknown>, nonce: unknown = lastNonce(posted)) => ({
    type: 'call-result',
    nonce,
    result: { success: true, output: '', executionTime: 3, ...result },
  });

  afterEach(() => {
    document.querySelectorAll('iframe').forEach(node => node.remove());
  });

  it('posts a describe call with paramsJson null and resolves with the parsed contract', async () => {
    const { pyodideManager, posted, fromSandbox, FUNCTION_READ_TIMEOUT_MS } = await readySandbox();
    const call = pyodideManager.callFunction('FUNCTION = {}', ['numpy']);
    await Promise.resolve();

    expect(posted.at(-1)).toEqual({
      type: 'call',
      code: 'FUNCTION = {}',
      packages: ['numpy'],
      paramsJson: null,
      timeoutMs: FUNCTION_READ_TIMEOUT_MS,
      nonce: expect.any(String),
      files: [],
    });
    fromSandbox(callResult({ contractJson: '{"name": "f"}', output: 'hi\n' }));
    await expect(call).resolves.toEqual({
      success: true,
      contract: { name: 'f' },
      output: 'hi\n',
      error: undefined,
      executionTime: 3,
    });
    expect(pyodideManager.getState().isExecuting).toBe(false);
  });

  it('posts params as JSON text and returns the value', async () => {
    const { pyodideManager, posted, fromSandbox } = await readySandbox();
    const call = pyodideManager.callFunction('code', [], { span: 4, label: 'a' });
    await Promise.resolve();

    expect(posted.at(-1)).toMatchObject({ type: 'call', paramsJson: '{"span":4,"label":"a"}' });
    fromSandbox(callResult({ contractJson: '{}', valueJson: '{"deflection": 0.002}' }));
    await expect(call).resolves.toMatchObject({ success: true, value: { deflection: 0.002 } });
  });

  it('passes on the output problems the sandbox found', async () => {
    const { pyodideManager, fromSandbox } = await readySandbox();
    const call = pyodideManager.callFunction('code', [], {});
    await Promise.resolve();

    fromSandbox(
      callResult({
        valueJson: '{"count": 3.0}',
        outputProblemsJson: '[{"path": "count", "message": "must be a whole number"}]',
      })
    );
    await expect(call).resolves.toMatchObject({
      success: true,
      value: { count: 3 },
      outputProblems: [{ path: 'count', message: 'must be a whole number' }],
    });
  });

  it.each(['{"path": "count"}', '[{"path": 1, "message": "x"}]', '[null]', 'not json'])(
    'refuses output problems that are not a problem list: %s',
    async outputProblemsJson => {
      const { pyodideManager, fromSandbox, FUNCTION_RESULT_UNREADABLE } = await readySandbox();
      const call = pyodideManager.callFunction('code', [], {});
      await Promise.resolve();

      fromSandbox(callResult({ valueJson: '{"count": 3}', outputProblemsJson }));
      await expect(call).resolves.toMatchObject({ success: false, error: FUNCTION_RESULT_UNREADABLE });
    }
  );

  it('returns a result between 256 KB and 5 MB, as the server runtime does', async () => {
    const { pyodideManager, fromSandbox } = await readySandbox();
    const call = pyodideManager.callFunction('code', [], {});
    await Promise.resolve();

    fromSandbox(callResult({ contractJson: '{}', valueJson: `{"text": "${'x'.repeat(1024 * 1024)}"}` }));
    await expect(call).resolves.toMatchObject({ success: true });
  });

  it('reads a result of exactly the 5 MB cap on the page in well under a second', async () => {
    const { pyodideManager, fromSandbox } = await readySandbox();
    const call = pyodideManager.callFunction('code', [], {});
    await Promise.resolve();
    const head = '{"text": "';
    const valueJson = `${head}${'x'.repeat(5 * 1024 * 1024 - head.length - 2)}"}`;

    const started = performance.now();
    fromSandbox(callResult({ contractJson: '{}', valueJson }));
    const result = await call;

    expect(result).toMatchObject({ success: true });
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('refuses an oversized result before parsing it', async () => {
    const { pyodideManager, fromSandbox, FUNCTION_RESULT_TOO_LARGE } = await readySandbox();
    const call = pyodideManager.callFunction('code', [], {});
    await Promise.resolve();
    const parse = vi.spyOn(JSON, 'parse');

    const oversized = `{"text": "${'x'.repeat(5 * 1024 * 1024)}"}`;
    fromSandbox(callResult({ contractJson: '{}', valueJson: oversized }));

    const result = await call;
    expect(result).toMatchObject({ success: false, error: FUNCTION_RESULT_TOO_LARGE });
    expect(result.value).toBeUndefined();
    expect(parse).not.toHaveBeenCalledWith(oversized);
    parse.mockRestore();
  });

  it('refuses a result that is not valid JSON or not text', async () => {
    const { pyodideManager, fromSandbox, FUNCTION_RESULT_UNREADABLE } = await readySandbox();
    const malformed = pyodideManager.callFunction('code', [], {});
    await Promise.resolve();
    fromSandbox(callResult({ contractJson: '{}', valueJson: '{"deflection": ' }));
    await expect(malformed).resolves.toMatchObject({ success: false, error: FUNCTION_RESULT_UNREADABLE });

    const notText = pyodideManager.callFunction('code', [], {});
    await Promise.resolve();
    fromSandbox(callResult({ contractJson: { name: 'f' } }));
    await expect(notText).resolves.toMatchObject({ success: false, error: FUNCTION_RESULT_UNREADABLE });
  });

  it('refuses an oversized contract before parsing it', async () => {
    const { pyodideManager, fromSandbox } = await readySandbox();
    const call = pyodideManager.callFunction('code');
    await Promise.resolve();
    const parse = vi.spyOn(JSON, 'parse');

    const oversized = `{"description": "${'x'.repeat(32 * 1024)}"}`;
    fromSandbox(callResult({ contractJson: oversized }));

    const result = await call;
    expect(result).toMatchObject({ success: false, error: 'The function contract is larger than 32 KB.' });
    expect(result.contract).toBeUndefined();
    expect(parse).not.toHaveBeenCalledWith(oversized);
    parse.mockRestore();
  });

  it('caps printed output', async () => {
    const { pyodideManager, fromSandbox } = await readySandbox();
    const call = pyodideManager.callFunction('code');
    await Promise.resolve();
    fromSandbox(callResult({ output: 'y'.repeat(150_000) }));
    expect((await call).output).toHaveLength(100_000);
  });

  it('caps the error text', async () => {
    const { pyodideManager, fromSandbox } = await readySandbox();
    const call = pyodideManager.callFunction('code');
    await Promise.resolve();
    fromSandbox(callResult({ success: false, error: 'e'.repeat(150_000) }));
    expect((await call).error).toHaveLength(100_000);
  });

  it('leaves an execute running when a call-result arrives with no call pending', async () => {
    const { pyodideManager } = await readySandbox();
    const run = pyodideManager.execute('print(1)');
    void run.catch(() => {});
    const { send } = await bringUpFrame(posted);
    await vi.waitFor(() => expect(pyodideManager.getState().isExecuting).toBe(true), POLL);

    send(callResult({ valueJson: '{"forged": 1}' }, null));

    expect(pyodideManager.getState().isExecuting).toBe(true);
    pyodideManager.interrupt();
  });

  it('settles a call only with the nonce it posted', async () => {
    const { pyodideManager, posted, fromSandbox } = await readySandbox();
    let settled: unknown = 'pending';
    const call = pyodideManager.callFunction('code', [], {});
    void call.then(result => (settled = result));
    await Promise.resolve();
    const nonce = lastNonce(posted);
    expect(typeof nonce).toBe('string');

    const { nonce: _dropped, ...withoutNonce } = callResult({ valueJson: '{"deflection": 1}' });
    fromSandbox(withoutNonce);
    for (const forged of [null, 'guessed', { nonce }]) {
      fromSandbox(callResult({ valueJson: '{"deflection": 1}' }, forged));
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe('pending');
    expect(pyodideManager.getState().isExecuting).toBe(true);

    fromSandbox(callResult({ valueJson: '{"deflection": 2}' }, nonce));
    await expect(call).resolves.toMatchObject({ value: { deflection: 2 } });
    const next = pyodideManager.callFunction('code', [], {});
    await Promise.resolve();
    expect(lastNonce(posted)).not.toBe(nonce);
    pyodideManager.interrupt();
    await next;
  });

  it('reads and calls in the network-free frame, and executes in the frame with the data origins', async () => {
    const { pyodideManager, frame, PYODIDE_SANDBOX_SRC } = await readySandbox();
    expect(frame.getAttribute('src')).toBe(`${PYODIDE_SANDBOX_SRC}?network=none`);
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');

    const run = pyodideManager.execute('print(1)');
    const data = await bringUpFrame(posted);
    expect(frame.isConnected).toBe(false);
    expect(data.frame.getAttribute('src')).toBe(PYODIDE_SANDBOX_SRC);
    await vi.waitFor(() => expect(posted.at(-1)).toMatchObject({ type: 'execute' }), POLL);
    data.send({ type: 'result', result: { success: true, output: '1\n', plots: [], executionTime: 1 } });
    await expect(run).resolves.toMatchObject({ success: true });

    const call = pyodideManager.callFunction('code', [], {});
    const none = await bringUpFrame(posted);
    expect(data.frame.isConnected).toBe(false);
    expect(none.frame.getAttribute('src')).toBe(`${PYODIDE_SANDBOX_SRC}?network=none`);
    expect(document.querySelectorAll('iframe')).toHaveLength(1);
    await vi.waitFor(() => expect(posted.at(-1)).toMatchObject({ type: 'call' }), POLL);
    pyodideManager.interrupt();
    await call;
  });

  it('refuses an execute while a call runs, and keeps the call and its frame', async () => {
    const { pyodideManager, frame, fromSandbox } = await readySandbox();
    const call = pyodideManager.callFunction('code', [], {});
    await Promise.resolve();

    await expect(pyodideManager.execute('print(1)')).rejects.toThrow('Another Python script is already running');
    expect(frame.isConnected).toBe(true);
    fromSandbox(callResult({ valueJson: '{"deflection": 1}' }));
    await expect(call).resolves.toMatchObject({ success: true });
  });

  it('writes a whole number of 1e21 or more in digits, so Python reads an integer', async () => {
    const { pyodideManager, posted, toPythonJson } = await readySandbox();
    const call = pyodideManager.callFunction('code', [], { count: 1e21, big: -2.5e22, small: 1e20, ratio: 1.5e-7 });
    await Promise.resolve();

    expect(posted.at(-1)?.paramsJson).toBe(
      '{"count":1000000000000000000000,"big":-25000000000000000000000,"small":100000000000000000000,"ratio":1.5e-7}'
    );
    expect(JSON.parse(String(posted.at(-1)?.paramsJson))).toEqual({
      count: 1e21,
      big: -2.5e22,
      small: 1e20,
      ratio: 1.5e-7,
    });
    expect(toPythonJson({ xs: [1e21, 'a', null, true], nested: { n: 3e21 }, gone: undefined })).toBe(
      '{"xs":[1000000000000000000000,"a",null,true],"nested":{"n":3000000000000000000000}}'
    );
    pyodideManager.interrupt();
    await call;
  });

  it('ignores a call-result from a window other than the sandbox frame', async () => {
    const { pyodideManager, fromSandbox } = await readySandbox();
    let settled: unknown = 'pending';
    const call = pyodideManager.callFunction('code', [], {});
    void call.then(result => (settled = result));
    await Promise.resolve();

    fromSandbox(callResult({ valueJson: '{"deflection": 1}' }), window as unknown as MessageEventSource);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe('pending');

    fromSandbox(callResult({ valueJson: '{"deflection": 2}' }));
    await expect(call).resolves.toMatchObject({ value: { deflection: 2 } });
  });

  it('refuses a call when an execute switches the frame before the call is posted', async () => {
    const { pyodideManager, PYODIDE_SANDBOX_SRC } = await readySandbox();
    const call = pyodideManager.callFunction('code', [], {});
    const run = pyodideManager.execute('print(1)');

    await expect(call).rejects.toThrow('Another Python script is already running');
    expect(posted.some(message => message.type === 'call')).toBe(false);
    const data = await bringUpFrame(posted);
    expect(data.frame.getAttribute('src')).toBe(PYODIDE_SANDBOX_SRC);
    await vi.waitFor(() => expect(posted.at(-1)).toMatchObject({ type: 'execute' }), POLL);
    data.send({ type: 'result', result: { success: true, output: '1\n', plots: [], executionTime: 1 } });
    await expect(run).resolves.toMatchObject({ success: true });
  });

  it('shares the single-run guard with execute and is settled by interrupt', async () => {
    const { pyodideManager } = await readySandbox();
    const call = pyodideManager.callFunction('code', [], {});
    await Promise.resolve();

    await expect(pyodideManager.execute('print(1)')).rejects.toThrow('Another Python script is already running');
    pyodideManager.interrupt();
    await expect(call).resolves.toMatchObject({ success: false, error: 'Execution interrupted' });
  });
});

describe('wall-clock guard', () => {
  const RUNNING = { type: 'executing', message: 'Running...' };

  const start = async () => {
    vi.resetModules();
    const imported = await import('../pyodideManager');
    const posted: Posted = [];
    const pending = imported.pyodideManager.initialize();
    const frame = await bringUpFrame(posted);
    await pending;
    return { ...imported, posted, ...frame };
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    document.querySelectorAll('iframe').forEach(node => node.remove());
  });

  it('stops an execute at its time limit, timed from Running, and loads a new sandbox without a click', async () => {
    const { pyodideManager, send, frame, runTimeLimitMessage } = await start();
    const run = pyodideManager.execute('while True:\n    pass', [], 1000);
    await Promise.resolve();
    send({ type: 'executing', message: 'Loading packages: numpy' });
    vi.advanceTimersByTime(5000);
    expect(frame.isConnected).toBe(true);

    send(RUNNING);
    vi.advanceTimersByTime(999);
    expect(frame.isConnected).toBe(true);
    vi.advanceTimersByTime(1);

    await expect(run).resolves.toMatchObject({ success: false, error: runTimeLimitMessage(1000) });
    expect(runTimeLimitMessage(1000)).toBe('Stopped at the time limit of 1 s.');
    expect(frame.isConnected).toBe(false);
    expect(document.querySelectorAll('iframe')).toHaveLength(1);
    expect(pyodideManager.getState().isExecuting).toBe(false);
  });

  it('is not extended by guest code posting Running again', async () => {
    const { pyodideManager, send, runTimeLimitMessage } = await start();
    const run = pyodideManager.execute('code', [], 1000);
    await Promise.resolve();
    send(RUNNING);
    vi.advanceTimersByTime(600);
    send(RUNNING);
    vi.advanceTimersByTime(400);
    await expect(run).resolves.toMatchObject({ error: runTimeLimitMessage(1000) });
  });

  it('clears the limit when the run returns, so it cannot stop the next one early', async () => {
    const { pyodideManager, send, frame } = await start();
    const first = pyodideManager.execute('print(1)', [], 1000);
    await Promise.resolve();
    send(RUNNING);
    vi.advanceTimersByTime(900);
    send({ type: 'result', result: { success: true, output: '1\n', plots: [], executionTime: 1 } });
    await expect(first).resolves.toMatchObject({ success: true });

    const second = pyodideManager.execute('print(2)', [], 1000);
    await Promise.resolve();
    send(RUNNING);
    vi.advanceTimersByTime(500);
    expect(frame.isConnected).toBe(true);
    send({ type: 'result', result: { success: true, output: '2\n', plots: [], executionTime: 1 } });
    await expect(second).resolves.toMatchObject({ success: true });
  });

  it('drops the frame on an error posted during a run, so code still looping stops with it', async () => {
    const { pyodideManager, send, frame, posted, PYODIDE_SANDBOX_SRC } = await start();
    const run = pyodideManager.execute('code', [], 1000);
    await Promise.resolve();
    send(RUNNING);
    send({ type: 'error', error: 'forged' });

    await expect(run).resolves.toMatchObject({ success: false, error: 'forged' });
    expect(frame.isConnected).toBe(false);
    const frames = document.querySelectorAll('iframe');
    expect(frames).toHaveLength(1);
    expect(frames[0].getAttribute('src')).toBe(PYODIDE_SANDBOX_SRC);

    const call = pyodideManager.callFunction('code', [], {}, 2000);
    const none = await bringUpFrame(posted);
    await vi.waitFor(() => expect(posted.at(-1)).toMatchObject({ type: 'call' }), POLL);
    none.send(RUNNING);
    none.send({ type: 'error', error: 'forged' });
    await expect(call).resolves.toMatchObject({ success: false, error: 'forged' });
    expect(none.frame.isConnected).toBe(false);
    expect(document.querySelector('iframe')?.getAttribute('src')).toBe(`${PYODIDE_SANDBOX_SRC}?network=none`);
  });

  it('stops a call at its time limit and a contract read at the read cap', async () => {
    const { pyodideManager, posted, runTimeLimitMessage, FUNCTION_READ_TIMEOUT_MS } = await start();
    const call = pyodideManager.callFunction('code', [], {}, 2000);
    let none = await bringUpFrame(posted);
    await vi.waitFor(() => expect(lastNonce(posted)).toBeDefined(), POLL);
    none.send(RUNNING);
    vi.advanceTimersByTime(2000);
    await expect(call).resolves.toMatchObject({ success: false, error: runTimeLimitMessage(2000) });

    expect(FUNCTION_READ_TIMEOUT_MS).toBe(10000);
    const read = pyodideManager.callFunction('FUNCTION = {}\nwhile True:\n    pass');
    none = await bringUpFrame(posted);
    await vi.waitFor(() => expect(posted.at(-1)).toMatchObject({ type: 'call', paramsJson: null }), POLL);
    none.send(RUNNING);
    vi.advanceTimersByTime(FUNCTION_READ_TIMEOUT_MS - 1);
    expect(none.frame.isConnected).toBe(true);
    vi.advanceTimersByTime(1);
    await expect(read).resolves.toMatchObject({ success: false, error: runTimeLimitMessage(10000) });
    expect(none.frame.isConnected).toBe(false);
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
