import { Worker, type ResourceLimits } from 'node:worker_threads';
import { ReplSandboxRetiredError, type ReplExecutor } from './replExecutor';
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
/**
 * Grace on top of `timeoutMs` before the MAIN THREAD stops waiting on a run.
 *
 * The worker's inner `vm.runInContext` timeout only bounds the synchronous
 * part of the guest code: the run is wrapped in an async IIFE, so anything
 * after the first `await` - a busy loop, a pending promise, a tool call that
 * never settles - runs with no cap and the worker never posts `runResult`.
 * Before this deadline existed the main thread awaited that forever. The
 * grace lets the worker's own (better-worded) timeout win the ordinary
 * synchronous case.
 */
const MAIN_THREAD_DEADLINE_GRACE_MS = 500;
const STDOUT_HEAD_BYTES = 5000;
const STDOUT_TAIL_BYTES = 2000;
const HARD_PER_LINE_BYTES = 50_000;
/**
 * How often the worker may post its rolling stdout tail once the head budget
 * is spent. Decouples the mirror's message rate from the guest's line rate:
 * past the head, a chatty loop costs at most 10 messages a second no matter
 * how much it prints. The window it gives up is only the output produced in
 * the last flush interval, and a HANG - the case the mirror exists for -
 * gives that back for free, because output has stopped and the next tick
 * carries the final line.
 */
const MIRROR_TAIL_FLUSH_MS = 100;

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
/**
 * One head line, mirrored to the main thread AS IT IS PRODUCED, so a run that
 * is later preempted can still report what it printed. `runResult` is the
 * authoritative stdout for a run that completes; the mirror exists only
 * because a terminated worker never gets to send one.
 */
interface MsgStdout {
  type: 'stdout';
  id: number;
  chunk: string;
}
/**
 * The rolling tail of a run whose mirrored head is full, plus how much fell
 * between the two. Replaces (does not append to) whatever tail the main
 * thread is holding for this run.
 *
 * The mirror carries a tail at all because the last line before a hang is the
 * most diagnostic thing a killed run printed, and it is exactly what a
 * head-only mirror drops. Keeping the same head + marker + tail shape as
 * `collectStdout()` also means a retired run and a completed one report
 * truncation by the same rule rather than by two that quietly disagree.
 */
interface MsgStdoutTail {
  type: 'stdoutTail';
  id: number;
  tail: string;
  elidedBytes: number;
}
type WorkerToMain = MsgReady | MsgRunResult | MsgStdout | MsgStdoutTail | MsgToolCall;

// --- Worker script (inlined as a string) ---------------------------------
// IMPORTANT: lives entirely on built-in Node modules. Do NOT add imports
// or references to anything outside `node:worker_threads` and `node:vm`.

const WORKER_SCRIPT = String.raw`
const { parentPort } = require('node:worker_threads');
const vm = require('node:vm');

const STDOUT_HEAD_BYTES = ${STDOUT_HEAD_BYTES};
const STDOUT_TAIL_BYTES = ${STDOUT_TAIL_BYTES};
const HARD_PER_LINE_BYTES = ${HARD_PER_LINE_BYTES};
const MIRROR_TAIL_FLUSH_MS = ${MIRROR_TAIL_FLUSH_MS};

let stdoutChunks = [];
let truncated = false;
// --- Mirror state --------------------------------------------------------
// Mirrors this run's stdout to the main thread as it is produced, in the same
// head + marker + tail shape collectStdout() produces, so a retired run and a
// completed one report the same thing by the same rule.
//
// The two halves are cost-bounded differently. The head is mirrored line by
// line, so a chatty loop stops paying per line once the head is full. Past
// that the tail is kept locally in a rolling window and posted on a timer, so
// the message rate stops tracking the line rate entirely.
let currentRunId = null;
let mirroredHeadBytes = 0;
let headMirrorFull = false;
let tailChunks = [];
let tailBytes = 0;
let elidedBytes = 0;
let tailFlushTimer = null;

/**
 * What the rolling tail may hold: whatever the head did not use of the same
 * HEAD + TAIL total collectStdout() reports within. A fixed TAIL budget made
 * the two disagree whenever the head came up short - a single 6KB first line
 * does not fit the head, so the mirror would have kept 2KB of a run that
 * collectStdout() reports whole, and called it truncated. mirroredHeadBytes
 * is frozen once the head is full, so this is stable for the rest of the run.
 */
function tailBudget() {
  return STDOUT_HEAD_BYTES + STDOUT_TAIL_BYTES - mirroredHeadBytes;
}

function postToMain(msg) {
  try { parentPort.postMessage(msg); } catch { /* worker being torn down; nothing to preserve */ }
}
function cancelTailFlush() {
  if (tailFlushTimer === null) return;
  clearTimeout(tailFlushTimer);
  tailFlushTimer = null;
}
function flushTail() {
  if (currentRunId === null || !headMirrorFull) return;
  const joined = tailChunks.join('\n');
  // The rolling window is trimmed line by line, so it can only exceed the
  // budget by holding ONE line longer than the whole budget. Slice to the
  // same last-N-chars rule collectStdout() uses, which both matches that
  // path and keeps the flush payload bounded - a guest printing 50KB lines
  // would otherwise re-send 50KB on every tick.
  const overflow = Math.max(0, joined.length - tailBudget());
  postToMain({
    type: 'stdoutTail',
    id: currentRunId,
    tail: overflow > 0 ? joined.slice(overflow) : joined,
    // Counted from what was actually DROPPED - lines the rolling window
    // evicted, plus whatever this payload's own slice cuts - rather than
    // derived from the byte totals. The derived form read zero on the first
    // flush by construction (every line was still in the head, so the
    // subtraction cancelled), which made "truncated" unreportable on exactly
    // the run the mirror exists for.
    elidedBytes: elidedBytes + overflow,
  });
}
function scheduleTailFlush() {
  if (tailFlushTimer !== null) return;
  tailFlushTimer = setTimeout(() => {
    tailFlushTimer = null;
    flushTail();
  }, MIRROR_TAIL_FLUSH_MS);
}
function mirrorLine(capped) {
  if (currentRunId === null) return;
  if (!headMirrorFull) {
    // Does THIS line fit, rather than "is the running total already over".
    // Both of the orderings tried before this were wrong in one direction
    // each: gating on the running total let one line of up to
    // HARD_PER_LINE_BYTES past a 5KB budget (mirrored head ~55KB, disagreeing
    // with collectStdout's head and with the "~7K chars" codeExecuteTool
    // advertises to the model), while adding first and checking after moved
    // the boundary but kept the crossing line in the head - so the tail was
    // still empty at the immediate flush below and a run killed right there
    // dropped the last line before the hang and reported itself complete.
    //
    // A fit check does both: the head stops at STDOUT_HEAD_BYTES exactly, and
    // the line that did not fit STARTS the tail, so the flush that fires on
    // this same call carries it.
    if (mirroredHeadBytes + capped.length + 1 <= STDOUT_HEAD_BYTES) {
      mirroredHeadBytes += capped.length + 1;
      postToMain({ type: 'stdout', id: currentRunId, chunk: capped });
      return;
    }
    headMirrorFull = true;
    tailChunks.push(capped);
    tailBytes += capped.length + 1;
    // Post once immediately: a run killed before the first timed flush would
    // otherwise report a short mirror as if it were complete.
    flushTail();
    return;
  }
  tailChunks.push(capped);
  tailBytes += capped.length + 1;
  // Never evict the only line held: a line larger than the whole budget is
  // still the last thing the run printed, which is what the mirror is for.
  const budget = tailBudget();
  while (tailBytes > budget && tailChunks.length > 1) {
    const dropped = tailChunks.shift();
    tailBytes -= dropped.length + 1;
    elidedBytes += dropped.length + 1;
  }
  scheduleTailFlush();
}
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
  mirrorLine(capped);
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
    stdoutChunks = []; truncated = false;
    cancelTailFlush();
    currentRunId = msg.id;
    mirroredHeadBytes = 0; headMirrorFull = false;
    tailChunks = []; tailBytes = 0; elidedBytes = 0;
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
    // Stop mirroring before the authoritative result goes out, so a late
    // console.log from an abandoned continuation cannot attach to this run,
    // and a pending tail flush cannot land after it.
    currentRunId = null;
    cancelTailFlush();
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
  /** Main-thread deadline for this run. Cleared whenever the run settles. */
  timer?: ReturnType<typeof setTimeout>;
  /** Head lines mirrored from the worker - the only copy that survives a
   *  terminate(), since the worker's own buffer dies with the thread. */
  stdoutChunks: string[];
  /** Latest rolling tail the worker mirrored after its head budget filled. */
  stdoutTail: string;
  /** Bytes the worker dropped between the mirrored head and the tail. */
  stdoutElidedBytes: number;
  startedAt: number;
}

/**
 * Reassemble a mirrored run's stdout in the same shape the worker's own
 * `collectStdout()` produces - head, an in-band elision marker, then the
 * tail - and report `truncated` by the same rule (only when bytes were
 * actually dropped). The two buffers used to disagree in both directions: the
 * mirror kept head only while `collectStdout` kept head + marker + tail, and
 * the two decided "truncated" on different tests.
 */
function assembleMirroredStdout(pending: PendingRun): { stdout: string; truncated: boolean } {
  // An empty head is ordinary now that the head takes only lines that FIT it:
  // a first line larger than the head budget starts the tail instead. Skipping
  // the empty part keeps that run from being reported with a leading newline.
  const head = pending.stdoutChunks.join('\n');
  const parts = head.length > 0 ? [head] : [];
  const truncated = pending.stdoutElidedBytes > 0;
  if (truncated) parts.push(`[...${pending.stdoutElidedBytes} bytes truncated...]`);
  if (pending.stdoutTail) parts.push(pending.stdoutTail);
  return { stdout: parts.join('\n'), truncated };
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
      throw new ReplSandboxRetiredError('WorkerReplExecutor has been disposed');
    }
    await this.readyPromise;
    // Re-check after the await - the worker can crash while we wait on
    // readyPromise, which sets disposed=true via the error/exit handler.
    if (this.disposed) {
      throw new ReplSandboxRetiredError(
        'WorkerReplExecutor was disposed (worker crashed) before runCode could be sent'
      );
    }
    const id = this.nextRunId++;
    return new Promise<ReplRunResult>((resolve, reject) => {
      // A worker that blew its deadline is not recoverable - the runaway
      // continuation still owns the thread - so terminating it is the
      // preemption. dispose() rejects every other in-flight run for us.
      const timer = setTimeout(() => {
        const pending = this.pendingRuns.get(id);
        if (!pending) return;
        this.pendingRuns.delete(id);
        // Flagged on the breaching run itself, not left to the next call:
        // this path TERMINATES the worker, so this run is the last one this
        // executor can serve. Reported as a result rather than a throw so the
        // stdout mirrored before the kill reaches the agent.
        this.settleRetired(
          pending,
          `REPL run exceeded the ${this.timeoutMs}ms cap (async continuation or unresolved tool ` +
            `call); worker [${this.label}] was terminated`
        );
        void this.dispose().catch(() => {
          // terminate() failing changes nothing for this caller
        });
      }, this.timeoutMs + MAIN_THREAD_DEADLINE_GRACE_MS);

      this.pendingRuns.set(id, {
        resolve,
        timer,
        stdoutChunks: [],
        stdoutTail: '',
        stdoutElidedBytes: 0,
        startedAt: Date.now(),
      });
      const msg: MsgRunCode = { type: 'runCode', id, code, timeoutMs: this.timeoutMs };
      // Defensive only, and deliberately kept: `Worker.postMessage` is a
      // silent no-op once the thread is gone (`kPublicPort === null`), so the
      // "worker exited between our checks and now" case this used to name
      // never throws here - `ERR_WORKER_NOT_RUNNING` comes from the
      // heap-snapshot APIs, not from postMessage. That path is covered by the
      // main-thread deadline instead. What CAN throw is a payload that is not
      // structured-cloneable, and this one is all strings and numbers - so if
      // it ever does throw, the pendingRuns entry still has to go, or the
      // promise never resolves.
      try {
        this.worker.postMessage(msg);
      } catch (e) {
        clearTimeout(timer);
        this.pendingRuns.delete(id);
        reject(e);
      }
    });
  }

  /**
   * Settle a run whose sandbox died underneath it, mirroring the isolate
   * path's protocol (`ReplRunResult.sandboxRetired`, see ReplContext.ts):
   * report the retirement on the breaching run itself, and RESOLVE rather
   * than throw so stdout captured before the kill survives. A throw carries
   * only a message, which discarded exactly the material the agent needs to
   * answer now that the REPL is gone.
   */
  private settleRetired(pending: PendingRun, error: string): void {
    if (pending.timer) clearTimeout(pending.timer);
    const { stdout, truncated } = assembleMirroredStdout(pending);
    pending.resolve({
      stdout,
      error,
      truncated,
      durationMs: Date.now() - pending.startedAt,
      sandboxRetired: true,
    });
  }

  /** Retire every in-flight run with the same cause. */
  private retireAllPending(cause: (id: number) => string): void {
    for (const [id, pending] of this.pendingRuns) {
      this.settleRetired(pending, cause(id));
    }
    this.pendingRuns.clear();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // Settle pending runs so callers don't hang forever.
    this.retireAllPending(id => `WorkerReplExecutor disposed before runCode #${id} returned`);
    await this.worker.terminate();
  }

  private handleMessage = (msg: WorkerToMain): void => {
    if (msg.type === 'runResult') {
      const pending = this.pendingRuns.get(msg.id);
      if (!pending) return;
      this.pendingRuns.delete(msg.id);
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve({
        stdout: msg.stdout,
        error: msg.error,
        truncated: msg.truncated,
        durationMs: msg.durationMs,
      });
      return;
    }
    if (msg.type === 'stdout') {
      const pending = this.pendingRuns.get(msg.id);
      if (!pending) return;
      pending.stdoutChunks.push(msg.chunk);
      return;
    }
    if (msg.type === 'stdoutTail') {
      const pending = this.pendingRuns.get(msg.id);
      if (!pending) return;
      // A replacement, not an append: the worker keeps the tail as a rolling
      // window and re-sends the whole window each flush.
      pending.stdoutTail = msg.tail;
      pending.stdoutElidedBytes = msg.elidedBytes;
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
  //
  // Terminating the worker mid tool-call is NOT the case to guard: postMessage
  // is a silent no-op once the thread is gone, and those pending runs are
  // already retired by dispose / handleWorkerExit / handleWorkerError. The
  // reachable throw is a `DataCloneError` on a tool result structured cloning
  // cannot carry - a function, a class instance holding one, a Proxy. That was
  // swallowed, which left the guest's awaiting promise unsettled: the run
  // stalled to the main-thread deadline and cost the entire sandbox for one
  // bad return value. The isolate backend reports the same condition as an
  // ordinary tool error (see `dispatchTool`'s serialize-in-its-own-try), so
  // this backend does too.
  private safePostMessage(reply: MsgToolResult): void {
    try {
      this.worker.postMessage(reply);
    } catch (e) {
      // An `ok: false` envelope is strings and numbers only, so it cannot be
      // the clone failure - and re-posting it would recurse.
      if (!reply.ok) return;
      const detail = e instanceof Error ? e.message : String(e);
      this.safePostMessage({
        type: 'toolResult',
        id: reply.id,
        ok: false,
        error:
          `tool returned a value that is not structured-cloneable across the worker boundary ` +
          `(e.g. a function, class instance, or Proxy): ${detail}`,
      });
    }
  }

  private handleWorkerError = (err: Error): void => {
    // Worker crashed. Mark disposed so subsequent runCode/setTools calls
    // fail fast rather than enqueueing against a dead worker (which
    // throws ERR_WORKER_NOT_RUNNING and leaks pending entries). Reject
    // all in-flight runs so awaiting callers don't hang forever.
    this.disposed = true;
    this.retireAllPending(() => `worker crashed: ${err.message}`);
  };

  private handleWorkerExit = (code: number): void => {
    if (code === 0 || this.disposed) return;
    // Non-zero exit, not user-initiated - likely OOM or crash. Same
    // disposed treatment as handleWorkerError so the executor isn't
    // half-alive (rejected pending but accepting new runs).
    this.disposed = true;
    this.retireAllPending(() => `worker exited unexpectedly with code ${code} (likely memory limit)`);
  };
}
