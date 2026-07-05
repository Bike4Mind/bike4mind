import { Worker, type ResourceLimits } from 'node:worker_threads';
import type { ReplExecutor } from './replExecutor';
import type { ReplToolFn, ReplToolMap, ReplRunResult } from './ReplContext';

/**
 * Run REPL code in a worker_thread with `resourceLimits` for memory caps
 * and CPU isolation. Quest 3b in the architecture doc.
 *
 * The worker has its own V8 instance - closures from the main thread
 * don't exist there. Tool calls cross the boundary as RPC: the worker
 * posts a `toolCall` message, the main thread handles it, posts a
 * `toolResult` message back, the worker's awaiting promise resolves.
 *
 * The worker script is an inlined string (not a separate file) so this
 * works the same in vitest, in `tsdown`-bundled output, and in Lambda
 * runtime - no file-path coordination across deploy targets. The worker
 * uses only built-in Node modules (`vm`, `worker_threads`); nothing in
 * the inline script imports from `@bike4mind/agents` or anywhere else.
 *
 * Trade-offs:
 * - Pro: real memory cap (LLM can't OOM the main process), CPU isolation
 *   (busy loop in the worker doesn't block the main event loop), worker
 *   can be force-terminated
 * - Con: ~50-100ms per-worker startup cost; tool calls cost a postMessage
 *   round-trip (~ms) instead of a direct function call
 *
 * For internal/tavern use this is the right level of isolation. Customer-
 * facing surfaces should graduate to `isolated-vm` (Quest 3c).
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MEMORY_LIMIT_MB = 256;
const STDOUT_HEAD_BYTES = 5000;
const STDOUT_TAIL_BYTES = 2000;
const HARD_PER_LINE_BYTES = 50_000;

export interface WorkerReplExecutorOptions {
  /** Per-call wall-clock cap. Default 30s. Mirrored by an inner vm.runInContext timeout. */
  timeoutMs?: number;
  /**
   * Resource limits passed to the Worker constructor. Defaults to
   * `{ maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, codeRangeSizeMb: 32 }`.
   * Override for tighter caps in production multi-tenant or for higher
   * caps in heavy-compute workloads.
   */
  resourceLimits?: ResourceLimits;
  /** Optional label for log prefixes. */
  label?: string;
}

// --- Wire protocol between main and worker -------------------------------
// Kept simple: single-channel parentPort, no MessageChannel pairs. Each
// runCode and toolCall has a numeric id so concurrent in-flight calls
// can't collide.

interface MsgInit {
  type: 'init';
  toolNames: string[];
  timeoutMs: number;
}
interface MsgSetTools {
  type: 'setTools';
  toolNames: string[];
}
interface MsgRunCode {
  type: 'runCode';
  id: number;
  code: string;
  timeoutMs: number;
}
interface MsgToolResult {
  type: 'toolResult';
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}
// Union retained for documentation; main-thread sends concrete subtypes only.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type MainToWorker = MsgInit | MsgSetTools | MsgRunCode | MsgToolResult;

interface MsgReady {
  type: 'ready';
}
interface MsgRunResult {
  type: 'runResult';
  id: number;
  stdout: string;
  error: string | null;
  truncated: boolean;
  durationMs: number;
}
interface MsgToolCall {
  type: 'toolCall';
  id: number;
  name: string;
  args: unknown[];
}
type WorkerToMain = MsgReady | MsgRunResult | MsgToolCall;

// --- Worker script (inlined as a string) ---------------------------------
// IMPORTANT: lives entirely on built-in Node modules. Do NOT add imports
// or references to anything outside `node:worker_threads` and `node:vm`.

const WORKER_SCRIPT = String.raw`
const { parentPort } = require('node:worker_threads');
const vm = require('node:vm');

const STDOUT_HEAD_BYTES = ${STDOUT_HEAD_BYTES};
const STDOUT_TAIL_BYTES = ${STDOUT_TAIL_BYTES};
const HARD_PER_LINE_BYTES = ${HARD_PER_LINE_BYTES};

let stdoutChunks = [];
let stdoutBytes = 0;
let truncated = false;
function captureLine(args) {
  const line = args.map(a => {
    if (typeof a === 'string') return a;
    if (a === undefined) return 'undefined';
    if (a === null) return 'null';
    try { return JSON.stringify(a, jsonReplacer, 2); } catch { return String(a); }
  }).join(' ');
  const capped = line.length > HARD_PER_LINE_BYTES
    ? line.slice(0, HARD_PER_LINE_BYTES) + ' [...line truncated]'
    : line;
  stdoutChunks.push(capped);
  stdoutBytes += capped.length + 1;
}
function jsonReplacer(_k, v) {
  if (v instanceof Error) return { name: v.name, message: v.message };
  if (typeof v === 'bigint') return v.toString() + 'n';
  return v;
}
function collectStdout() {
  const joined = stdoutChunks.join('\n');
  if (joined.length <= STDOUT_HEAD_BYTES + STDOUT_TAIL_BYTES) return joined;
  truncated = true;
  const head = joined.slice(0, STDOUT_HEAD_BYTES);
  const tail = joined.slice(joined.length - STDOUT_TAIL_BYTES);
  const elidedBytes = joined.length - STDOUT_HEAD_BYTES - STDOUT_TAIL_BYTES;
  return head + '\n[...' + elidedBytes + ' bytes truncated...]\n' + tail;
}

const sandbox = {
  console: {
    log: (...a) => captureLine(a),
    warn: (...a) => captureLine(a),
    error: (...a) => captureLine(a),
    info: (...a) => captureLine(a),
  },
  Math, JSON, Date, RegExp, Error, TypeError, RangeError, Promise,
  Array, Object, String, Number, Boolean, Map, Set, WeakMap, WeakSet, Symbol,
  // Number coercion / validation builtins — kept in sync with ReplContext
  // sandbox so worker and in-process backends behave identically.
  parseInt, parseFloat, isNaN, isFinite,
  structuredClone: globalThis.structuredClone,
};
// strings: false disables eval / new Function inside the worker context.
// Same posture as the in-process ReplContext (Ken's P2 #2).
const ctx = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });

// Tool stubs: each in-REPL call posts a toolCall and awaits matching toolResult.
let nextToolCallId = 0;
const pendingToolCalls = new Map();
function makeToolStub(name) {
  return (...args) => {
    const id = nextToolCallId++;
    return new Promise((resolve, reject) => {
      pendingToolCalls.set(id, { resolve, reject });
      // Args go through structured cloning. Functions, classes, etc. don't
      // survive the boundary — that's fine for our tool surface.
      try {
        parentPort.postMessage({ type: 'toolCall', id, name, args });
      } catch (e) {
        pendingToolCalls.delete(id);
        reject(new Error('postMessage failed for tool ' + name + ': ' + (e && e.message)));
      }
    });
  };
}
function setToolStubs(toolNames) {
  for (const name of toolNames) {
    sandbox[name] = makeToolStub(name);
  }
}

function serializeError(e) {
  if (e instanceof Error) {
    const stack = e.stack ? '\n' + e.stack.split('\n').slice(0, 6).join('\n') : '';
    return e.name + ': ' + e.message + stack;
  }
  const t = typeof e;
  if (t === 'object' && e !== null) {
    let s = '';
    try { s = JSON.stringify(e); } catch { s = '[unserializable]'; }
    if (s === '{}' || s === '[]') {
      const ctor = (e && e.constructor && e.constructor.name) || 'Object';
      return '[non-Error throw: empty ' + ctor + ' — likely \`throw {}\` or thrown DOM exception]';
    }
    return '[non-Error throw: ' + s.slice(0, 500) + ']';
  }
  return '[' + t + ' throw: ' + String(e).slice(0, 200) + ']';
}

let timeoutMsDefault = 30000;

parentPort.on('message', async (msg) => {
  if (msg.type === 'init') {
    timeoutMsDefault = msg.timeoutMs || 30000;
    setToolStubs(msg.toolNames || []);
    parentPort.postMessage({ type: 'ready' });
    return;
  }
  if (msg.type === 'setTools') {
    setToolStubs(msg.toolNames || []);
    return;
  }
  if (msg.type === 'toolResult') {
    const pending = pendingToolCalls.get(msg.id);
    if (!pending) return;
    pendingToolCalls.delete(msg.id);
    if (msg.ok) pending.resolve(msg.value);
    else pending.reject(new Error(msg.error || 'tool call failed'));
    return;
  }
  if (msg.type === 'runCode') {
    const t0 = Date.now();
    stdoutChunks = []; stdoutBytes = 0; truncated = false;
    let error = null;
    const wrapped = '(async () => {\n' + msg.code + '\n})()';
    try {
      const promise = vm.runInContext(wrapped, ctx, {
        timeout: msg.timeoutMs || timeoutMsDefault,
        displayErrors: true,
      });
      await promise;
    } catch (e) {
      error = serializeError(e);
    }
    parentPort.postMessage({
      type: 'runResult',
      id: msg.id,
      stdout: collectStdout(),
      error,
      truncated,
      durationMs: Date.now() - t0,
    });
    return;
  }
});
`;

// --- Main-thread executor ------------------------------------------------

interface PendingRun {
  resolve: (r: ReplRunResult) => void;
  reject: (e: unknown) => void;
}

export class WorkerReplExecutor implements ReplExecutor {
  private worker: Worker;
  private tools: ReplToolMap = {};
  private nextRunId = 0;
  private pendingRuns = new Map<number, PendingRun>();
  private readyPromise: Promise<void>;
  private disposed = false;
  private readonly timeoutMs: number;
  private readonly label: string;

  constructor(opts: WorkerReplExecutorOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.label = opts.label ?? 'worker-repl';
    const limits: ResourceLimits = opts.resourceLimits ?? {
      maxOldGenerationSizeMb: DEFAULT_MEMORY_LIMIT_MB,
      maxYoungGenerationSizeMb: 32,
      codeRangeSizeMb: 32,
    };

    this.worker = new Worker(WORKER_SCRIPT, {
      eval: true,
      resourceLimits: limits,
      name: this.label,
    });

    this.worker.on('message', this.handleMessage);
    this.worker.on('error', this.handleWorkerError);
    this.worker.on('exit', this.handleWorkerExit);

    // Initialize the worker - tells it the timeout default and (empty) tool list.
    // Resolves once the worker emits 'ready'.
    this.readyPromise = new Promise((resolve, reject) => {
      const onMessage = (msg: WorkerToMain) => {
        if (msg.type === 'ready') {
          this.worker.off('message', onMessage);
          resolve();
        }
      };
      this.worker.on('message', onMessage);
      // Belt-and-suspenders: if the worker errors before ready, reject this
      this.worker.once('error', e => reject(e));
      const initMsg: MsgInit = {
        type: 'init',
        toolNames: [],
        timeoutMs: this.timeoutMs,
      };
      this.worker.postMessage(initMsg);
    });
  }

  setTools(tools: ReplToolMap): void {
    this.tools = tools;
    if (this.disposed) return;
    const setMsg: MsgSetTools = { type: 'setTools', toolNames: Object.keys(tools) };
    this.worker.postMessage(setMsg);
  }

  async runCode(code: string): Promise<ReplRunResult> {
    if (this.disposed) {
      throw new Error('WorkerReplExecutor has been disposed');
    }
    await this.readyPromise;
    // Re-check after the await - the worker can crash while we wait on
    // readyPromise, which sets disposed=true via the error/exit handler.
    if (this.disposed) {
      throw new Error('WorkerReplExecutor was disposed (worker crashed) before runCode could be sent');
    }
    const id = this.nextRunId++;
    return new Promise<ReplRunResult>((resolve, reject) => {
      this.pendingRuns.set(id, { resolve, reject });
      const msg: MsgRunCode = { type: 'runCode', id, code, timeoutMs: this.timeoutMs };
      // Synchronous postMessage failures (e.g., ERR_WORKER_NOT_RUNNING if
      // the worker exited between our checks and now) must clean up the
      // pendingRuns entry - otherwise the promise never resolves.
      try {
        this.worker.postMessage(msg);
      } catch (e) {
        this.pendingRuns.delete(id);
        reject(e);
      }
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // Reject pending runs so callers don't hang forever
    for (const [id, pending] of this.pendingRuns) {
      pending.reject(new Error(`WorkerReplExecutor disposed before runCode #${id} returned`));
    }
    this.pendingRuns.clear();
    await this.worker.terminate();
  }

  private handleMessage = (msg: WorkerToMain): void => {
    if (msg.type === 'runResult') {
      const pending = this.pendingRuns.get(msg.id);
      if (!pending) return;
      this.pendingRuns.delete(msg.id);
      pending.resolve({
        stdout: msg.stdout,
        error: msg.error,
        truncated: msg.truncated,
        durationMs: msg.durationMs,
      });
      return;
    }
    if (msg.type === 'toolCall') {
      void this.handleToolCall(msg);
      return;
    }
    // 'ready' is consumed by the readyPromise listener; ignore others
  };

  private handleToolCall = async (msg: MsgToolCall): Promise<void> => {
    const tool: ReplToolFn | undefined = this.tools[msg.name];
    if (!tool) {
      this.safePostMessage({
        type: 'toolResult',
        id: msg.id,
        ok: false,
        error: `tool "${msg.name}" not registered with WorkerReplExecutor`,
      });
      return;
    }
    try {
      const value = await tool(...msg.args);
      this.safePostMessage({ type: 'toolResult', id: msg.id, ok: true, value });
    } catch (e) {
      this.safePostMessage({
        type: 'toolResult',
        id: msg.id,
        ok: false,
        error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      });
    }
  };

  // handleToolCall runs as a fire-and-forget `void this.handleToolCall(msg)`
  // from handleMessage, so any throw here surfaces as `unhandledRejection`.
  // If dispose() terminates the worker mid tool-call, postMessage throws
  // ERR_WORKER_NOT_RUNNING - swallow it. The pending run was already rejected
  // by dispose / handleWorkerExit / handleWorkerError, so the caller won't hang.
  private safePostMessage(reply: MsgToolResult): void {
    try {
      this.worker.postMessage(reply);
    } catch {
      // worker terminated; pending run already rejected elsewhere
    }
  }

  private handleWorkerError = (err: Error): void => {
    // Worker crashed. Mark disposed so subsequent runCode/setTools calls
    // fail fast rather than enqueueing against a dead worker (which
    // throws ERR_WORKER_NOT_RUNNING and leaks pending entries). Reject
    // all in-flight runs so awaiting callers don't hang forever.
    this.disposed = true;
    for (const [, pending] of this.pendingRuns) {
      pending.reject(new Error(`worker crashed: ${err.message}`));
    }
    this.pendingRuns.clear();
  };

  private handleWorkerExit = (code: number): void => {
    if (code === 0 || this.disposed) return;
    // Non-zero exit, not user-initiated - likely OOM or crash. Same
    // disposed treatment as handleWorkerError so the executor isn't
    // half-alive (rejected pending but accepting new runs).
    this.disposed = true;
    for (const [, pending] of this.pendingRuns) {
      pending.reject(new Error(`worker exited unexpectedly with code ${code} (likely memory limit)`));
    }
    this.pendingRuns.clear();
  };
}
