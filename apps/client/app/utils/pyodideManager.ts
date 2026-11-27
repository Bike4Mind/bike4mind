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

import {
  SANDBOX_RUNNING_MESSAGE,
  type PyodideWorkerMessage,
  type PyodideWorkerResponse,
  type ExecutionResult,
} from '@client/app/workers/pyodide/types';
import {
  FUNCTION_CONTRACT_LIMITS,
  FUNCTION_RESULT_TOO_LARGE_MESSAGE,
  capFunctionProblems,
  functionJsonBytes,
  type FunctionContractProblem,
  randomUuid,
} from '@bike4mind/common';
import {
  SUPPORTED_PYTHON_PACKAGES,
  describePythonImportError,
  detectPythonPackages,
} from '@client/app/utils/pythonPackages';

/** The sandbox route. Framed with `allow-scripts` ONLY - never `allow-same-origin`. */
export const PYODIDE_SANDBOX_SRC = '/api/pyodide-sandbox';

/**
 * `data` reaches the admin-listed data origins and is where scripts execute; `none` reaches only the Pyodide
 * distribution and is where functions are read and called. One frame at a time: switching reloads Pyodide.
 */
export type PyodideSandboxNetwork = 'data' | 'none';

export const pyodideSandboxSrc = (network: PyodideSandboxNetwork): string =>
  network === 'none' ? `${PYODIDE_SANDBOX_SRC}?network=none` : PYODIDE_SANDBOX_SRC;

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
 * How long the sandbox may go silent DURING initialization before we give up.
 *
 * Idle rather than total, because Pyodide is a multi-megabyte download and a slow link is not a
 * failure - every `initializing` message re-arms this. What it catches is the runtime dying
 * inside third-party code: a CSP that starves Pyodide, for instance, fails in
 * `WebAssembly.instantiateStreaming` deep in pyodide.js, which logs a console warning and never
 * rejects, so the worker has nothing to report and the Run button spins forever.
 */
const PYODIDE_INIT_IDLE_TIMEOUT_MS = 60000;

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
/** Reading FUNCTION runs the module's top level, which should only define things (ms). */
export const FUNCTION_READ_TIMEOUT_MS = 10000;

/** Timed from the worker's Running status, so package loading is not counted. */
export const runTimeLimitMessage = (timeoutMs: number): string =>
  `Stopped at the time limit of ${Math.round(timeoutMs / 1000)} s.`;

/**
 * JSON for `run`'s keyword arguments. A whole number of 1e21 or more is written out in digits, since
 * JSON.stringify writes `1e+21`, which Python reads as a float.
 */
export function toPythonJson(value: unknown): string {
  if (typeof value === 'number' && Number.isInteger(value) && Math.abs(value) >= 1e21) {
    // The shortest form, `2.5e+22`, spelled out: the number as written, not the binary value's every digit.
    const [mantissa, exponent] = String(value).split('e');
    const [whole, fraction = ''] = mantissa.split('.');
    return `${whole}${fraction}${'0'.repeat(Number(exponent) - fraction.length)}`;
  }
  if (Array.isArray(value)) return `[${value.map(item => toPythonJson(item ?? null)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${toPythonJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** A function call read back from the sandbox. `contract` and `value` are parsed but not yet validated. */
export interface PythonFunctionCall {
  success: boolean;
  contract?: unknown;
  value?: unknown;
  /** Output problems only Python could see, such as 3.0 for an integer; in the shape the contract validator uses. */
  outputProblems?: FunctionContractProblem[];
  output: string;
  error?: string;
  executionTime: number;
}

export const PYTHON_SCRIPT_BUSY = 'Another Python script is already running';

// The sandbox wrapper in sandboxWorkerBody.ts applies the same caps before posting; these checks stay the authority.
const MAX_FUNCTION_OUTPUT_CHARS = 100_000;
const FUNCTION_CONTRACT_TOO_LARGE = `The function contract is larger than ${FUNCTION_CONTRACT_LIMITS.maxContractBytes / 1024} KB.`;
export const FUNCTION_RESULT_TOO_LARGE = FUNCTION_RESULT_TOO_LARGE_MESSAGE;
export const FUNCTION_RESULT_UNREADABLE = 'The function returned a result that could not be read.';

/**
 * Every field of a `call-result` is guest data: types are checked, and each JSON text is size-capped
 * before it is parsed.
 */
function readFunctionCallResult(raw: unknown): PythonFunctionCall {
  const result: Record<string, unknown> = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const output = typeof result.output === 'string' ? result.output.slice(0, MAX_FUNCTION_OUTPUT_CHARS) : '';
  const executionTime =
    typeof result.executionTime === 'number' && Number.isFinite(result.executionTime) ? result.executionTime : 0;
  const refuse = (error: string): PythonFunctionCall => ({ success: false, output, error, executionTime });

  const parsed: { contract?: unknown; value?: unknown; outputProblems?: unknown } = {};
  const fields = [
    {
      key: 'contract',
      field: 'contractJson',
      limit: FUNCTION_CONTRACT_LIMITS.maxContractBytes,
      tooLarge: FUNCTION_CONTRACT_TOO_LARGE,
    },
    {
      key: 'value',
      field: 'valueJson',
      limit: FUNCTION_CONTRACT_LIMITS.maxResultBytes,
      tooLarge: FUNCTION_RESULT_TOO_LARGE,
    },
    {
      key: 'outputProblems',
      field: 'outputProblemsJson',
      limit: FUNCTION_CONTRACT_LIMITS.maxResultBytes,
      tooLarge: FUNCTION_RESULT_TOO_LARGE,
    },
  ] as const;
  for (const { key, field, limit, tooLarge } of fields) {
    const text = result[field];
    if (text === undefined) continue;
    if (typeof text !== 'string') return refuse(FUNCTION_RESULT_UNREADABLE);
    // A UTF-8 encoding is never shorter than the UTF-16 length, so the cheap check runs first.
    if (text.length > limit || functionJsonBytes(text) > limit) return refuse(tooLarge);
    try {
      parsed[key] = JSON.parse(text);
    } catch {
      return refuse(FUNCTION_RESULT_UNREADABLE);
    }
  }
  const { outputProblems, ...values } = parsed;
  if (outputProblems !== undefined && !isProblemList(outputProblems)) return refuse(FUNCTION_RESULT_UNREADABLE);

  const error =
    typeof result.error === 'string'
      ? describePythonImportError(result.error.slice(0, MAX_FUNCTION_OUTPUT_CHARS))
      : undefined;
  return {
    success: result.success === true && error === undefined,
    ...values,
    ...(outputProblems ? { outputProblems: capFunctionProblems(outputProblems) } : {}),
    output,
    error,
    executionTime,
  };
}

function isProblemList(value: unknown): value is FunctionContractProblem[] {
  return (
    Array.isArray(value) &&
    value.every(
      entry =>
        entry !== null &&
        typeof entry === 'object' &&
        typeof (entry as Record<string, unknown>).path === 'string' &&
        typeof (entry as Record<string, unknown>).message === 'string'
    )
  );
}

export interface PyodideManagerState {
  isLoading: boolean;
  loadProgress: number;
  loadedPackages: Set<string>;
  error: string | null;
  isReady: boolean;
  isExecuting: boolean;
  // What the worker is doing during a run (e.g. loading packages), for the Run status line.
  executionStatus: string | null;
  streamingOutput: string;
}

class PyodideManager {
  private state: PyodideManagerState = {
    isLoading: false,
    loadProgress: 0,
    loadedPackages: new Set(),
    error: null,
    isReady: false,
    isExecuting: false,
    executionStatus: null,
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
  private callResolver: ((result: PythonFunctionCall) => void) | null = null;
  private callRejecter: ((error: Error) => void) | null = null;
  private callNonce: string | null = null;
  private network: PyodideSandboxNetwork = 'data';
  // Whose code has run in the current frame; null while no guest code has run in it. Code from two owners never
  // shares an interpreter or a Worker, so a different owner gets a fresh frame.
  private owner: string | null = null;
  // The pending run's time limit, armed once when the worker reports Running and never re-armed, so guest code that
  // posts the same status cannot extend it.
  private runLimitMs: number | null = null;
  private runTimer: ReturnType<typeof setTimeout> | null = null;
  private initResolver: (() => void) | null = null;
  private initRejecter: ((error: Error) => void) | null = null;
  private initIdleTimer: ReturnType<typeof setTimeout> | null = null;
  // Settles a still-pending handshake (and clears its timer) when the frame is torn down, so
  // a stale timer can never tear down the frame that replaced it.
  private abortHandshake: ((error: Error) => void) | null = null;
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
      frame.src = pyodideSandboxSrc(this.network);
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
      this.abortHandshake = error => settle(() => reject(error));

      this.messageListener = (event: MessageEvent) => {
        // Provenance is the source window: an opaque origin reports "null", so the event's
        // origin cannot identify this frame, and any page could otherwise post to us.
        if (event.source !== frame.contentWindow) return;
        const data = event.data;
        if (!data || typeof data !== 'object') return;

        if (data.type === SANDBOX_READY) {
          settle(() => {
            this.abortHandshake = null;
            resolve();
          });
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
    this.clearInitWatchdog();
    const abortHandshake = this.abortHandshake;
    this.abortHandshake = null;
    abortHandshake?.(new Error('Execution interrupted'));
    if (this.messageListener) {
      window.removeEventListener('message', this.messageListener);
      this.messageListener = null;
    }
    this.frame?.remove();
    this.frame = null;
    this.frameReady = null;
  }

  /**
   * (Re)start the initialization watchdog. Called when `initialize` is posted and on every
   * progress message, so it only fires when the sandbox has genuinely gone quiet.
   */
  private armInitWatchdog(): void {
    this.clearInitWatchdog();
    this.initIdleTimer = setTimeout(() => {
      this.initIdleTimer = null;
      const reject = this.initRejecter;
      this.initResolver = null;
      this.initRejecter = null;
      // Not memoized: the next Run gets a fresh sandbox rather than this failure forever.
      this.initPromise = null;
      this.teardownSandbox();
      const error = new Error('The Python runtime stopped responding while loading. Reload the page and try again.');
      this.updateState({ isLoading: false, isExecuting: false, isReady: false, error: error.message });
      reject?.(error);
    }, PYODIDE_INIT_IDLE_TIMEOUT_MS);
  }

  private clearInitWatchdog(): void {
    if (this.initIdleTimer) {
      clearTimeout(this.initIdleTimer);
      this.initIdleTimer = null;
    }
  }

  private postToSandbox(message: PyodideWorkerMessage, transfer: Transferable[] = []): void {
    this.frame?.contentWindow?.postMessage(message, '*', transfer);
  }

  private handleWorkerMessage(msg: PyodideWorkerResponse): void {
    switch (msg.type) {
      case 'initializing':
        // Proof of life: the runtime is still loading, so the watchdog starts over.
        if (this.initRejecter) this.armInitWatchdog();
        this.updateState({
          isLoading: true,
          loadProgress: msg.progress,
          error: null,
        });
        break;

      case 'ready':
        this.clearInitWatchdog();
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
        if (msg.message === SANDBOX_RUNNING_MESSAGE && this.runLimitMs !== null && !this.runTimer) {
          const limit = this.runLimitMs;
          this.runTimer = setTimeout(() => this.interrupt(runTimeLimitMessage(limit)), limit);
        }
        this.updateState({ isExecuting: true, executionStatus: msg.message, streamingOutput: '' });
        break;

      case 'output':
        this.updateState({
          streamingOutput: this.state.streamingOutput + msg.output,
        });
        break;

      case 'result':
        this.updateState({ isExecuting: false, executionStatus: null });
        if (this.executeResolver) {
          this.clearRunLimit();
          const { result } = msg;
          this.executeResolver(result.error ? { ...result, error: describePythonImportError(result.error) } : result);
          this.executeResolver = null;
          this.executeRejecter = null;
        }
        break;

      case 'call-result':
        // Guest code can post this during an execute or a call; only the pending call's own nonce ends it.
        if (this.callResolver && this.callNonce !== null && msg.nonce === this.callNonce) {
          this.clearRunLimit();
          this.updateState({ isExecuting: false, executionStatus: null });
          this.callResolver(readFunctionCallResult(msg.result));
          this.callResolver = null;
          this.callRejecter = null;
          this.callNonce = null;
        }
        break;

      case 'error':
        // Guest code can post this too, then keep looping; dropping the frame is what stops it.
        if (this.executeResolver || this.callResolver) {
          this.interrupt(msg.error);
          break;
        }
        this.clearInitWatchdog();
        this.clearRunLimit();
        this.updateState({
          isLoading: false,
          isExecuting: false,
          executionStatus: null,
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
        if (this.callRejecter) {
          this.callRejecter(new Error(msg.error));
          this.callResolver = null;
          this.callRejecter = null;
          this.callNonce = null;
        }
        break;
    }
  }

  private clearRunLimit(): void {
    if (this.runTimer) clearTimeout(this.runTimer);
    this.runTimer = null;
    this.runLimitMs = null;
  }

  /**
   * Load Pyodide in a frame with `network` reach, replacing a frame with the other reach. Refuses while a run is
   * pending, since replacing the frame would end it.
   */
  private async prepareSandbox(network: PyodideSandboxNetwork, owner: string): Promise<void> {
    this.refuseIfBusy();
    if (this.network !== network) {
      this.network = network;
      if (this.frame || this.initPromise) this.dropSandbox();
    }
    this.releaseForeignSandbox(owner);
    this.owner = owner;
    if (this.state.isReady && this.frame) return;
    await this.initialize();
    // An interrupt landed after the load settled; its replacement frame is not ready yet.
    if (!this.frame || !this.state.isReady) throw new Error('Execution interrupted');
    // Another caller switched the frame while this one waited for it to load.
    if (this.network !== network || this.owner !== owner) throw new Error(PYTHON_SCRIPT_BUSY);
  }

  private releaseForeignSandbox(owner: string): void {
    if (this.owner !== null && this.owner !== owner && (this.frame || this.initPromise)) this.dropSandbox();
  }

  // Called again after every await: a second caller would replace the first one's resolver and leave its promise
  // unsettled forever.
  private refuseIfBusy(): void {
    if (this.executeResolver || this.callResolver) throw new Error(PYTHON_SCRIPT_BUSY);
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
   * Load Pyodide. With `owner`, a frame another owner's code has run in is replaced first, so that owner's first run
   * finds a clean frame already loaded. Refuses while a run is pending rather than ending it.
   */
  async initialize(owner?: string): Promise<void> {
    if (owner !== undefined && this.owner !== null && this.owner !== owner) {
      this.refuseIfBusy();
      this.releaseForeignSandbox(owner);
    }
    if (this.state.isReady && this.frame) {
      return;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    const initPromise: Promise<void> = this.spawnSandbox()
      .then(
        () =>
          new Promise<void>((resolve, reject) => {
            this.initResolver = resolve;
            this.initRejecter = reject;
            this.armInitWatchdog();
            this.postToSandbox({ type: 'initialize', baseUrl: this.baseUrl });
          })
      )
      .catch(error => {
        // An interrupt has already started a replacement load; this failure is the old one's.
        if (this.initPromise !== initPromise) throw error;
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
    this.initPromise = initPromise;

    return initPromise;
  }

  /**
   * Execute Python code and capture output.
   * Runs in a Worker inside the opaque-origin sandbox frame, so it won't freeze the UI and
   * cannot reach the app origin. Use interrupt() to stop execution (e.g., for infinite loops).
   *
   * @param owner - Whose code this is, such as the artifact id; a different owner than the last run gets a new sandbox
   * @param code - Python code to execute
   * @param packages - Optional list of packages to load before execution
   * @param timeoutMs - Execution timeout in milliseconds (default: 30s)
   */
  async execute(
    owner: string,
    code: string,
    packages: string[] = [],
    timeoutMs = EXECUTION_TIMEOUT_MS
  ): Promise<ExecutionResult> {
    await this.prepareSandbox('data', owner);
    this.refuseIfBusy();
    if (this.network !== 'data' || this.owner !== owner) throw new Error(PYTHON_SCRIPT_BUSY);

    return new Promise<ExecutionResult>((resolve, reject) => {
      this.executeResolver = resolve;
      this.executeRejecter = reject;
      this.runLimitMs = timeoutMs;

      // Cleared here, not only on the worker's first message, so a run never shows the
      // previous run's output.
      this.updateState({ isExecuting: true, streamingOutput: '' });

      this.postToSandbox({ type: 'execute', code, packages, timeoutMs });
    });
  }

  /**
   * Read the code's FUNCTION contract and, unless `params` is null, call `run(**params)`, in the network-free
   * frame. Shares execute()'s single-run guard and is stopped the same way, by interrupt(). Reading the contract
   * alone is held to `FUNCTION_READ_TIMEOUT_MS` unless a limit is given. `owner` is as for execute().
   */
  async callFunction(
    owner: string,
    code: string,
    packages: string[] = [],
    params: Record<string, unknown> | null = null,
    timeoutMs = params === null ? FUNCTION_READ_TIMEOUT_MS : EXECUTION_TIMEOUT_MS,
    files: { name: string; bytes: ArrayBuffer }[] = []
  ): Promise<PythonFunctionCall> {
    await this.prepareSandbox('none', owner);
    this.refuseIfBusy();
    // An execute started while this await settled has already switched to the frame with data origins.
    if (this.network !== 'none' || this.owner !== owner) throw new Error(PYTHON_SCRIPT_BUSY);

    const paramsJson = params === null ? null : toPythonJson(params);
    const nonce = randomUuid();
    return new Promise<PythonFunctionCall>((resolve, reject) => {
      this.callResolver = resolve;
      this.callRejecter = reject;
      this.callNonce = nonce;
      this.runLimitMs = timeoutMs;
      this.updateState({ isExecuting: true, streamingOutput: '' });
      // Transferred, not cloned: the buffers move to the frame and are unusable here afterwards.
      this.postToSandbox(
        { type: 'call', code, packages, paramsJson, timeoutMs, nonce, files },
        files.map(file => file.bytes)
      );
    });
  }

  /**
   * Removing the frame destroys the Worker inside it, which is what actually stops a `while True:`; a 'cancel'
   * message would only be observed between steps. A load still in flight is settled (teardown settles a pending
   * handshake), so a caller awaiting initialize() hears about it instead of hanging on it.
   */
  private dropSandbox(): void {
    const rejectInit = this.initRejecter;
    this.teardownSandbox();
    this.owner = null;
    this.initPromise = null;
    this.initResolver = null;
    this.initRejecter = null;
    rejectInit?.(new Error('Execution interrupted'));

    this.updateState({
      isExecuting: false,
      executionStatus: null,
      isReady: false,
      loadProgress: 0,
      loadedPackages: new Set(),
    });
  }

  /**
   * Interrupt the current execution by tearing down the sandbox, then load a new one, so the next run needs no
   * click. `reason` is the error the pending run resolves with; the time limit passes its own.
   */
  interrupt(reason = 'Execution interrupted'): void {
    if (!this.frame) {
      return;
    }
    this.clearRunLimit();
    this.dropSandbox();

    // Resolve pending execution with cancellation (include any output captured before interrupt)
    if (this.executeResolver) {
      this.executeResolver({
        success: false,
        output: this.state.streamingOutput,
        error: reason,
        plots: [],
        executionTime: 0,
      });
      this.executeResolver = null;
      this.executeRejecter = null;
    }
    if (this.callResolver) {
      this.callResolver({
        success: false,
        output: this.state.streamingOutput,
        error: reason,
        executionTime: 0,
      });
      this.callResolver = null;
      this.callRejecter = null;
      this.callNonce = null;
    }

    // Re-initialize so the Run button becomes enabled again
    this.initialize().catch(console.error);
  }

  /** Detect required packages from import statements. */
  detectPackages(code: string): string[] {
    return detectPythonPackages(code);
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
    return [...SUPPORTED_PYTHON_PACKAGES];
  }
}

export const pyodideManager = new PyodideManager();
