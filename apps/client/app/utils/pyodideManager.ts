/**
 * Pyodide Manager - singleton driving browser-based Python execution.
 *
 * Python artifact code is authored by a model or a collaborator, so it does not run on the app
 * origin. It runs in a Worker inside the /api/pyodide-sandbox iframe, which is framed WITHOUT
 * `allow-same-origin` and therefore has an opaque origin: guest code cannot make a credentialed
 * same-origin fetch, and the sandbox's own CSP allows `connect-src` to the Pyodide distribution
 * and nothing else. See the route for why that is two independent controls rather than one.
 *
 * This class owns the transport and nothing else. The message protocol is unchanged
 * (`PyodideWorkerMessage` / `PyodideWorkerResponse`) - the iframe relays it verbatim to and from
 * the Worker, so the surface facing usePyodide is identical to when the Worker was same-origin.
 *
 * Handles:
 * 1. Sandbox lifecycle (iframe + the Worker inside it)
 * 2. Package installation via micropip
 * 3. Code execution with stdout/stderr capture
 * 4. Matplotlib plot generation as base64 PNG
 * 5. Execution interruption by dropping the sandbox
 */

import type { PyodideWorkerMessage, PyodideWorkerResponse, ExecutionResult } from '@client/app/workers/pyodide/types';

/** The sandbox route. Framed with `allow-scripts` ONLY - never `allow-same-origin`. */
export const PYODIDE_SANDBOX_SRC = '/api/pyodide-sandbox';

/**
 * How long to wait for the sandbox handshake before giving up.
 *
 * An iframe does NOT fire `onerror` for an HTTP error - it renders the error body and sits
 * there - so a route that 500s, or a CSP that refuses the frame, produces silence rather than a
 * failure. Without this the Run button would spin forever. Generous, because the frame is only
 * fetching a small static shell; Pyodide's own multi-megabyte load happens after `ready`.
 */
const SANDBOX_HANDSHAKE_TIMEOUT_MS = 15000;

/**
 * The sandbox shell's handshake. It posts this once the Worker is constructed; until then the
 * frame cannot accept an `initialize`.
 */
const SANDBOX_READY = 'pyodide-sandbox-ready';

/**
 * The sandbox token list, as a const so a regression guard can assert on it directly.
 * `allow-same-origin` would hand the app's origin back to guest Python and undo the whole fix.
 */
export const PYODIDE_SANDBOX_TOKENS = 'allow-scripts';

// Re-export ExecutionResult for backwards compatibility
export type { ExecutionResult } from '@client/app/workers/pyodide/types';

/** Default execution timeout in milliseconds (30 seconds) */
const EXECUTION_TIMEOUT_MS = 30000;

export interface PyodideManagerState {
  isLoading: boolean;
  loadProgress: number;
  loadedPackages: Set<string>;
  error: string | null;
  isReady: boolean;
  isExecuting: boolean;
  streamingOutput: string;
}

// Supported packages (pre-built in Pyodide)
const SUPPORTED_PACKAGES = ['numpy', 'pandas', 'matplotlib', 'scipy', 'seaborn', 'scikit-learn'];

// Package name mapping (npm name -> Pyodide package name)
const PACKAGE_NAME_MAP: Record<string, string> = {
  'scikit-learn': 'sklearn',
  sklearn: 'sklearn',
};

class PyodideManager {
  private state: PyodideManagerState = {
    isLoading: false,
    loadProgress: 0,
    loadedPackages: new Set(),
    error: null,
    isReady: false,
    isExecuting: false,
    streamingOutput: '',
  };

  private frame: HTMLIFrameElement | null = null;
  private frameReady: Promise<void> | null = null;
  private messageListener: ((event: MessageEvent) => void) | null = null;
  private initPromise: Promise<void> | null = null;
  // Optional Pyodide mirror (PYODIDE_BASE_URL), forwarded to the sandbox at initialize.
  // Undefined keeps the pinned public CDN.
  private baseUrl?: string;
  private executeResolver: ((result: ExecutionResult) => void) | null = null;
  private executeRejecter: ((error: Error) => void) | null = null;
  private initResolver: (() => void) | null = null;
  private initRejecter: ((error: Error) => void) | null = null;
  private listeners: Set<(state: PyodideManagerState) => void> = new Set();

  /**
   * Mount the sandbox iframe and resolve once its shell reports ready.
   *
   * Rejects rather than falling back to a same-origin Worker: no sandbox must mean no Python
   * execution, never Python execution next to the session cookie.
   */
  private spawnSandbox(): Promise<void> {
    if (this.frameReady) {
      return this.frameReady;
    }

    this.frameReady = new Promise<void>((resolve, reject) => {
      if (typeof document === 'undefined') {
        reject(new Error('Python execution requires a browser document'));
        return;
      }

      const frame = document.createElement('iframe');
      frame.src = PYODIDE_SANDBOX_SRC;
      frame.setAttribute('sandbox', PYODIDE_SANDBOX_TOKENS);
      frame.setAttribute('aria-hidden', 'true');
      frame.setAttribute('title', 'Python execution sandbox');
      frame.style.display = 'none';

      let settled = false;
      const settle = (outcome: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(handshakeTimer);
        outcome();
      };

      const handshakeTimer = setTimeout(() => {
        settle(() => {
          this.teardownSandbox();
          reject(new Error('Python sandbox did not start. Reload the page and try again.'));
        });
      }, SANDBOX_HANDSHAKE_TIMEOUT_MS);

      this.messageListener = (event: MessageEvent) => {
        // Provenance is the source window: an opaque origin reports "null", so the event's
        // origin cannot identify this frame, and any page could otherwise post to us.
        if (event.source !== frame.contentWindow) return;
        const data = event.data;
        if (!data || typeof data !== 'object') return;

        if (data.type === SANDBOX_READY) {
          settle(resolve);
          return;
        }

        this.handleWorkerMessage(data as PyodideWorkerResponse);
      };
      window.addEventListener('message', this.messageListener);

      // Fires for a genuine load failure; the timeout above covers the quieter cases it misses.
      frame.onerror = () => {
        settle(() => {
          this.teardownSandbox();
          reject(new Error('Python sandbox failed to load'));
        });
      };

      document.body.appendChild(frame);
      this.frame = frame;
    });

    return this.frameReady;
  }

  /** Drop the sandbox, which takes the Worker inside it with it. */
  private teardownSandbox(): void {
    if (this.messageListener) {
      window.removeEventListener('message', this.messageListener);
      this.messageListener = null;
    }
    this.frame?.remove();
    this.frame = null;
    this.frameReady = null;
  }

  private postToSandbox(message: PyodideWorkerMessage): void {
    this.frame?.contentWindow?.postMessage(message, '*');
  }

  private handleWorkerMessage(msg: PyodideWorkerResponse): void {
    switch (msg.type) {
      case 'initializing':
        this.updateState({
          isLoading: true,
          loadProgress: msg.progress,
          error: null,
        });
        break;

      case 'ready':
        this.updateState({
          isLoading: false,
          loadProgress: 100,
          isReady: true,
          error: null,
        });
        if (this.initResolver) {
          this.initResolver();
          this.initResolver = null;
          this.initRejecter = null;
        }
        break;

      case 'executing':
        this.updateState({ isExecuting: true, streamingOutput: '' });
        break;

      case 'output':
        this.updateState({
          streamingOutput: this.state.streamingOutput + msg.output,
        });
        break;

      case 'result':
        this.updateState({ isExecuting: false });
        if (this.executeResolver) {
          this.executeResolver(msg.result);
          this.executeResolver = null;
          this.executeRejecter = null;
        }
        break;

      case 'error':
        this.updateState({
          isLoading: false,
          isExecuting: false,
          error: msg.error,
        });
        if (this.initRejecter) {
          // A failed initialize must not stay memoized - see initialize().
          this.initPromise = null;
          this.initRejecter(new Error(msg.error));
          this.initResolver = null;
          this.initRejecter = null;
        }
        if (this.executeRejecter) {
          this.executeRejecter(new Error(msg.error));
          this.executeResolver = null;
          this.executeRejecter = null;
        }
        break;
    }
  }

  /**
   * Point Pyodide at a self-hosted mirror instead of the default public CDN.
   * Must be called before initialize() to take effect for that sandbox. The mirror must also
   * be allow-listed in the sandbox CSP - both read PYODIDE_BASE_URL via pyodideDistribution.ts.
   */
  configure(baseUrl?: string): void {
    this.baseUrl = baseUrl;
  }

  /**
   * Initialize Pyodide (lazy-loaded singleton)
   */
  async initialize(): Promise<void> {
    if (this.state.isReady && this.frame) {
      return;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.spawnSandbox()
      .then(
        () =>
          new Promise<void>((resolve, reject) => {
            this.initResolver = resolve;
            this.initRejecter = reject;
            this.postToSandbox({ type: 'initialize', baseUrl: this.baseUrl });
          })
      )
      .catch(error => {
        // A sandbox that never came up must not leave initialize() permanently memoized -
        // the next Run should try again rather than report a stale failure forever.
        this.initPromise = null;
        this.updateState({
          isLoading: false,
          isExecuting: false,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      });

    return this.initPromise;
  }

  /**
   * Execute Python code and capture output.
   * Runs in a Worker inside the opaque-origin sandbox frame, so it won't freeze the UI and
   * cannot reach the app origin. Use interrupt() to stop execution (e.g., for infinite loops).
   *
   * @param code - Python code to execute
   * @param packages - Optional list of packages to load before execution
   * @param timeoutMs - Execution timeout in milliseconds (default: 30s)
   */
  async execute(code: string, packages: string[] = [], timeoutMs = EXECUTION_TIMEOUT_MS): Promise<ExecutionResult> {
    await this.initialize();

    if (!this.frame) {
      throw new Error('Python sandbox not available');
    }

    return new Promise<ExecutionResult>((resolve, reject) => {
      this.executeResolver = resolve;
      this.executeRejecter = reject;

      this.updateState({ isExecuting: true });

      this.postToSandbox({ type: 'execute', code, packages, timeoutMs });
    });
  }

  /**
   * Interrupt the current execution by tearing down the sandbox.
   * This immediately stops infinite loops or long-running code.
   * A new sandbox is spawned on the next execution.
   */
  interrupt(): void {
    if (!this.frame) {
      return;
    }

    // Removing the frame destroys the Worker inside it, which is what actually stops a
    // `while True:`. A 'cancel' message would only be observed between steps.
    this.teardownSandbox();
    this.initPromise = null;
    this.initResolver = null;
    this.initRejecter = null;

    this.updateState({
      isExecuting: false,
      isReady: false,
      loadProgress: 0,
      loadedPackages: new Set(),
    });

    // Resolve pending execution with cancellation (include any output captured before interrupt)
    if (this.executeResolver) {
      this.executeResolver({
        success: false,
        output: this.state.streamingOutput,
        error: 'Execution interrupted',
        plots: [],
        executionTime: 0,
      });
      this.executeResolver = null;
      this.executeRejecter = null;
    }

    // Re-initialize so the Run button becomes enabled again
    this.initialize().catch(console.error);
  }

  /** Detect required packages from import statements. */
  detectPackages(code: string): string[] {
    const packages: Set<string> = new Set();

    const importPatterns = [/^import\s+(\w+)/gm, /^from\s+(\w+)\s+import/gm];

    for (const pattern of importPatterns) {
      let match;
      while ((match = pattern.exec(code)) !== null) {
        const pkg = match[1];
        if (
          SUPPORTED_PACKAGES.includes(pkg) ||
          Object.keys(PACKAGE_NAME_MAP).includes(pkg) ||
          Object.values(PACKAGE_NAME_MAP).includes(pkg)
        ) {
          packages.add(pkg);
        }
      }
    }

    return Array.from(packages);
  }

  private updateState(partial: Partial<PyodideManagerState>): void {
    this.state = { ...this.state, ...partial };
    this.listeners.forEach(listener => listener(this.state));
  }

  subscribe(listener: (state: PyodideManagerState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): PyodideManagerState {
    return this.state;
  }

  isReady(): boolean {
    return this.state.isReady && !this.state.isLoading;
  }

  getSupportedPackages(): string[] {
    return [...SUPPORTED_PACKAGES];
  }
}

export const pyodideManager = new PyodideManager();
