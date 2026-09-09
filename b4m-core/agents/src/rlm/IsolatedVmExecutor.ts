import { createRequire } from 'node:module';
import { Logger } from '@bike4mind/observability';
import type * as IVM from 'isolated-vm';
import { ReplSandboxRetiredError, type ReplExecutor } from './replExecutor';
import type { ReplToolFn, ReplToolMap, ReplRunResult } from './ReplContext';

/**
 * In-isolate globals the bootstrap owns. A tool registered under one of these
 * names would shadow `console` capture or the codegen/clone helpers, so
 * `setTools` rejects them. (`_callTool` / `_captureLine` / `__registerTools`
 * are deleted from the global after bootstrap, but are listed so a tool can't
 * re-create a name that looks like a host hook.)
 */
const RESERVED_GLOBAL_NAMES = new Set([
  'console',
  'structuredClone',
  'eval',
  'Function',
  '__registerTools',
  '_callTool',
  '_captureLine',
]);

/**
 * `isolated-vm` is a native addon. Load it LAZILY (a synchronous CJS require
 * deferred to first construction), NOT via a top-level `import` - so merely
 * importing this module, or `@bike4mind/agents` transitively, does not pull
 * the native binary into a Lambda's module graph.
 *
 * A static `import` made every consumer of the agents package eagerly load
 * the addon, which broke functions that never touch the REPL (e.g. the
 * DatabaseMigrator / DatabaseSeeder cron Lambdas) at cold start with
 * `No native build was found ... loaded from: /var/task`: esbuild bundles
 * the JS loader into `bundle.mjs` but the `.node` binary is not shipped
 * beside it. Deferring the require means only a function that actually
 * constructs an `IsolatedVmExecutor` ever touches the binary.
 *
 * The flip side is that a bundler cannot see this require, so every deploy
 * target that activates the isolated backend must name the addon itself or
 * the prebuild never ships beside the handler:
 * - SST `nodejs` functions: `esbuild: { external: ['isolated-vm'] }` +
 *   `install: ['isolated-vm']` (the pattern in `infra/mcp.ts`).
 * - The Next.js app (rlm-answer, deep-agent): `serverExternalPackages` plus an
 *   `outputFileTracingIncludes` entry naming the `.node` prebuild, both in
 *   `apps/client/next.config.mjs`.
 * Callers fail closed when the addon is missing, so the symptom of getting
 * this wrong is a route that refuses every request, not one that runs guest
 * code unsandboxed.
 */
let _ivm: typeof import('isolated-vm') | undefined;
function loadIvm(): typeof import('isolated-vm') {
  if (!_ivm) {
    const req = createRequire(import.meta.url);
    _ivm = req('isolated-vm') as typeof import('isolated-vm');
  }
  return _ivm;
}

/**
 * Run REPL code inside an `isolated-vm` V8 isolate - a *separate* V8 heap
 * with no shared object graph with the host. Quest 3c in the architecture
 * doc, the graduation path from `WorkerReplExecutor`.
 *
 * Why this exists beyond the worker backend: `WorkerReplExecutor` runs
 * `vm.runInContext` inside a worker_thread. `vm` is NOT a security
 * boundary - it shares the worker's V8 heap, so adversarial code can reach
 * host internals via prototype walks / `constructor` chains. The worker
 * gives memory + CPU isolation but not a *trust* boundary. `isolated-vm`
 * gives a real V8-isolate boundary: the only things crossing in or out are
 * the explicit `ivm.Reference` host hooks we inject, and values are copied
 * (never shared by reference). This is the level required before exposing
 * `code_execute` to a customer-facing / multi-tenant / third-party-LLM
 * surface.
 *
 * Boundary model (mirrors the worker's RPC shape so the two backends are
 * behaviourally interchangeable):
 * - `console.*` inside the isolate calls a host `Reference` synchronously
 *   with an already-formatted line; the host appends it to a stdout buffer.
 * - Tools inside the isolate are async stubs. Each call hands `(name,
 *   argsJson)` to a single host dispatcher `Reference` and awaits the
 *   result as a native promise. The dispatcher ALWAYS resolves with an
 *   `{ ok, value | error }` JSON envelope - never rejects. A host
 *   `Reference` that returns a *rejected* promise surfaces as an
 *   unhandled rejection on the host (isolated-vm does not tie it back to
 *   the in-isolate awaiter), so we encode tool failures in the envelope
 *   and re-throw them inside the isolate instead.
 *
 * Args and return values cross as JSON strings - the existing tool surface
 * (`wrapAgentToolsForRepl`) already deals only in JSON-serialisable params
 * and JSON / string results, so nothing richer needs to be Transferable.
 *
 * Trade-offs vs. the worker backend:
 * - Pro: real trust boundary (not just resource isolation); per-call CPU
 *   timeout interrupts the script while keeping the isolate reusable; a
 *   hard `memoryLimit` the isolate enforces itself.
 * - Con: `isolated-vm` is a native addon (build/bundle cost); tool calls
 *   pay a JSON round-trip across the boundary.
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MEMORY_LIMIT_MB = 256;
/**
 * Grace added to `timeoutMs` before the HOST gives up on a run.
 *
 * The isolate's own `timeout` preempts guest code that is BURNING CPU,
 * including inside an async continuation, and produces the precise
 * "Script execution timed out." error while leaving the isolate reusable.
 * It does not fire for a run that is merely PENDING - `await new Promise(() =>
 * {})`, or a tool call that never settles - because nothing is executing to
 * interrupt. The host deadline covers that case, and the grace keeps it from
 * racing the isolate on the CPU-bound path where the isolate's own answer is
 * the better one.
 */
export const HOST_DEADLINE_GRACE_MS = 500;
/**
 * Fraction of `timeoutMs` a single host tool call may take before the
 * dispatcher gives up on it. Strictly below 1 so the guest sees a per-tool
 * error - and keeps its isolate - instead of the run reaching the host
 * deadline, which can only preempt a pending run by killing the isolate and
 * with it every later `code_execute` in the session.
 *
 * Exported so the ordering it exists to maintain is pinned by a test rather
 * than only by this comment: a value at or above 1 inverts the whole ladder
 * and nothing else in the code would notice.
 */
export const TOOL_CALL_TIMEOUT_FRACTION = 0.8;
const STDOUT_HEAD_BYTES = 5000;
const STDOUT_TAIL_BYTES = 2000;
const HARD_PER_LINE_BYTES = 50_000;

export interface IsolatedVmExecutorOptions {
  /** Per-call wall-clock cap. Default 30s. Enforced by the isolate's CPU timeout. */
  timeoutMs?: number;
  /**
   * Wall-clock cap on a single host tool call made from inside the isolate.
   * Defaults to `TOOL_CALL_TIMEOUT_FRACTION` of `timeoutMs`, floored at 1ms -
   * strictly proportional, so the ordering holds at every `timeoutMs`.
   *
   * Must stay below `timeoutMs`: a tool that outlives this is reported to the
   * guest as a failed tool call, which leaves the isolate alive, whereas
   * letting the run reach the host deadline retires the sandbox for the rest
   * of the session. This is a cap on ONE call; the run's remaining time caps
   * them cumulatively - see `runDeadlineAt`.
   */
  toolTimeoutMs?: number;
  /**
   * Hard memory cap for the isolate, in MB. Default 256 (matches the
   * worker backend's `maxOldGenerationSizeMb`). When the isolate exceeds
   * this it is disposed by V8; the executor marks itself disposed so
   * subsequent calls fail fast rather than throwing opaque errors.
   */
  memoryLimitMb?: number;
  /**
   * Per tool name, the shortest dispatch bound that tool may be given, in ms.
   * A call whose remaining run budget falls below its floor is REFUSED rather
   * than dispatched.
   *
   * The bound a tool actually gets is `min(toolTimeoutMs, run time left)`, so
   * it shrinks as the run proceeds. Once it drops under a deadline the tool
   * enforces internally, the ordering the caller's timeout ladder is built on
   * inverts: the dispatcher stops awaiting first, and the tool's own abort -
   * the thing that produces an attributable error, releases a budget
   * reservation, or books a spend - lands after nobody is listening. For a
   * tool that only reads, an abandoned request is merely wasted; for one that
   * spends money or holds a reservation it is an accounting hole, because the
   * settle arrives after the caller has already snapshotted usage.
   *
   * So the floor is per tool and set by the caller, which is the only layer
   * that knows what each tool bounds itself by. Tools absent from this map
   * keep the old behaviour (dispatch with whatever is left).
   */
  toolMinBudgetMs?: Record<string, number>;
  /** Optional label for log prefixes. */
  label?: string;
}

// --- In-isolate bootstrap -------------------------------------------------
// Runs ONCE at context creation. Sets up console capture, a structuredClone
// polyfill (absent from a bare isolate), neuters string codegen for parity
// with the worker/in-process backends, and defines the tool-stub registry.
//
// `_captureLine` and `_callTool` are host `ivm.Reference`s set as globals
// before this runs. We capture them into the IIFE's closure and delete the
// globals so LLM-generated code can't reach the raw host hooks (and so they
// don't show up in listGlobals()).
const BOOTSTRAP = String.raw`
// Wrapped in an IIFE deliberately. A script's top-level const/let bind into the
// context's SHARED global lexical scope (and its function declarations become
// globalThis properties), so without this wrapper every bootstrap-local name is
// directly referenceable by LLM-authored code run later in the same context:
// __RealFunction('...')() walks straight around the codegen block below, and
// __cap.applySync(...) / __cap.release() forges or permanently kills stdout
// capture. Function scope keeps them unreachable. Note the leak is invisible to
// listGlobals(), which reads Object.getOwnPropertyNames(globalThis) and never
// saw the lexical bindings - so RESERVED_GLOBAL_NAMES cannot backstop it either.
// Anything guest code IS meant to see is assigned onto globalThis explicitly.
(function () {
const __cap = _captureLine;
const __callTool = _callTool;
delete globalThis._captureLine;
delete globalThis._callTool;

const HARD_PER_LINE_BYTES = ${HARD_PER_LINE_BYTES};

// Every intrinsic the formatter below reaches for is captured HERE, while the
// context is still pristine. Resolving \`args.map\` / \`.join\` / \`line.slice\`
// at CALL time walks a prototype chain the guest owns, so one
// \`Array.prototype.join = () => 'X'\` - deliberate, or an innocent polyfill -
// forges every stdout line for the rest of the session, and the run still
// reports error=null / truncated=false. That is the same integrity failure the
// frozen \`console\` below exists to prevent, one level down: freezing the
// binding is worthless if the formatter behind it is guest-reachable.
const __stringify = JSON.stringify;
const __String = String;
const __apply = Reflect.apply;
const __strSlice = String.prototype.slice;

function __jsonReplacer(_k, v) {
  if (v instanceof Error) return { name: v.name, message: v.message };
  if (typeof v === 'bigint') return v.toString() + 'n';
  return v;
}
// Indexed loop and \`+=\` rather than map/join: string concatenation is an
// operator, not a lookup, so there is nothing here for the guest to replace.
// What a guest CAN still steer is how its own values render - a \`toJSON\` or
// \`toString\` on the object it passed - which is content it already owns, not
// the channel.
function __formatLine(args) {
  let line = '';
  for (let i = 0; i < args.length; i++) {
    if (i > 0) line += ' ';
    const a = args[i];
    if (typeof a === 'string') { line += a; continue; }
    if (a === undefined) { line += 'undefined'; continue; }
    if (a === null) { line += 'null'; continue; }
    try { line += __stringify(a, __jsonReplacer, 2); } catch { line += __String(a); }
  }
  return line.length > HARD_PER_LINE_BYTES
    ? __apply(__strSlice, line, [0, HARD_PER_LINE_BYTES]) + ' [...line truncated]'
    : line;
}
// stdout is the channel the HOST reports back as the run's observation, so its
// integrity is ours, not the guest's. A plain assignment left \`console\`
// writable and configurable: guest code could set globalThis.console = {log(){}}
// (or just reassign console.log) and every later run in the session would come
// back with stdout="" or forged lines, error=null, and a clean listGlobals().
// Frozen object + non-writable, non-configurable property: the guest's
// assignment is a silent no-op in sloppy mode and a TypeError under 'use
// strict', and either way capture keeps working.
//
// The BINDING is what this protects, and the binding is only half of it: a
// frozen console whose formatter resolved its intrinsics at call time would
// still hand the guest every line. That half is closed above, where
// __formatLine captures what it needs.
const __console = Object.freeze({
  log: (...a) => __cap.applySync(undefined, [__formatLine(a)], { arguments: { copy: true } }),
  warn: (...a) => __cap.applySync(undefined, [__formatLine(a)], { arguments: { copy: true } }),
  error: (...a) => __cap.applySync(undefined, [__formatLine(a)], { arguments: { copy: true } }),
  info: (...a) => __cap.applySync(undefined, [__formatLine(a)], { arguments: { copy: true } }),
});
Object.defineProperty(globalThis, 'console', {
  value: __console,
  writable: false,
  configurable: false,
  enumerable: true,
});

// A bare isolate has no structuredClone (it's a host/web API, not a V8
// intrinsic). The in-process + worker backends expose the *host's* real
// structuredClone — which we can't reach across the isolate boundary — so
// polyfill the structured-clone algorithm in-isolate for the common cloneable
// types (Date, RegExp, Map, Set, ArrayBuffer / typed arrays / DataView,
// arrays, plain objects) WITH circular-reference support. This is real
// parity for those types; a JSON round-trip would silently drop
// Date -> string, Map/Set -> {}, RegExp -> {}, TypedArray -> index map.
// Genuinely uncloneable inputs (functions, etc.) throw, as the real API does.
if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = function structuredClone(input) {
    const seen = new WeakMap();
    function clone(v) {
      if (v === null || typeof v !== 'object') {
        if (typeof v === 'function') throw new Error('structuredClone: a function could not be cloned');
        return v;
      }
      if (seen.has(v)) return seen.get(v);
      // Every cloneable type records its clone in the seen-map BEFORE returning,
      // so the same object appearing at multiple paths yields one shared clone
      // (reference identity), matching the real structured-clone algorithm —
      // not just the recursive containers.
      if (v instanceof Date) { const out = new Date(v.getTime()); seen.set(v, out); return out; }
      if (v instanceof RegExp) { const out = new RegExp(v.source, v.flags); seen.set(v, out); return out; }
      if (v instanceof ArrayBuffer) { const out = v.slice(0); seen.set(v, out); return out; }
      if (typeof DataView !== 'undefined' && v instanceof DataView) {
        const out = new DataView(clone(v.buffer), v.byteOffset, v.byteLength); seen.set(v, out); return out;
      }
      if (ArrayBuffer.isView(v)) { const out = new v.constructor(v); seen.set(v, out); return out; } // typed array — fresh buffer
      if (v instanceof Map) {
        const out = new Map(); seen.set(v, out);
        for (const [k, val] of v) out.set(clone(k), clone(val));
        return out;
      }
      if (v instanceof Set) {
        const out = new Set(); seen.set(v, out);
        for (const val of v) out.add(clone(val));
        return out;
      }
      if (Array.isArray(v)) {
        const out = []; seen.set(v, out);
        for (let i = 0; i < v.length; i++) out[i] = clone(v[i]);
        return out;
      }
      const out = {}; seen.set(v, out);
      for (const k of Object.keys(v)) out[k] = clone(v[k]);
      return out;
    }
    return clone(input);
  };
}

// Neuter string-based code generation. Same posture as the worker /
// in-process backends' codeGeneration:{strings:false} (Ken's P2 #2): the
// LLM has no legitimate reason to generate second-order code that's
// invisible in the logged 'code' parameter. isolated-vm exposes no V8-level
// codegen toggle, so we block every reachable path to the intrinsic
// Function constructors — not just the global bindings. The well-known
// vm-escape vector \`(function(){}).constructor("…")()\` reaches the
// intrinsic via the prototype chain, around \`globalThis.Function\`, so we
// capture each function-type intrinsic BEFORE overriding the globals and
// replace its \`prototype.constructor\` too. (Generated code would stay
// trapped in the isolate regardless — this is auditability + worker parity,
// not the core isolation guarantee, which the isolate itself provides.)
const __RealFunction = (function () {}).constructor;
const __AsyncFunction = (async function () {}).constructor;
const __GeneratorFunction = (function* () {}).constructor;
const __AsyncGeneratorFunction = (async function* () {}).constructor;
const __blockCodegen = function () {
  throw new Error('code generation from strings (eval / Function) is disabled in the REPL sandbox');
};
for (const __Ctor of [__RealFunction, __AsyncFunction, __GeneratorFunction, __AsyncGeneratorFunction]) {
  try {
    Object.defineProperty(__Ctor.prototype, 'constructor', {
      value: __blockCodegen,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  } catch (_e) {
    // best-effort; the global overrides below still cover the common paths
  }
}
globalThis.eval = __blockCodegen;
globalThis.Function = __blockCodegen;

// WebAssembly is removed, not stubbed. Its compile/instantiate promises never
// settle inside an isolated-vm isolate (there is no host task runner to drive
// them), so \`await WebAssembly.instantiate(...)\` is a one-line way for guest
// code to park a run until the host deadline fires - and that deadline kills
// the isolate, costing the whole session its sandbox. Deleting it turns that
// into an immediate ReferenceError. It is also codegen-from-bytes, so it
// belongs on the same side of the line as eval / Function anyway.
delete globalThis.WebAssembly;

// Tool-stub registry. Each registered tool becomes a top-level async
// function that round-trips through the host dispatcher and re-throws on
// the { ok:false } envelope.
//
// Assigned to globalThis only so the constructor can lift a Reference to it;
// the constructor deletes the global immediately afterwards and calls it
// through that Reference forever after. It must NOT stay guest-reachable: a
// guest could call __registerTools(['console']) to overwrite the frozen
// console binding with a tool stub, or \`delete\` it and make the host's next
// setTools() throw.
//
// Indexed loop, not for..of, deliberately: the host calls this with a copied
// array whose iterator comes from the GUEST's Array.prototype, so an
// overridden Symbol.iterator would let guest code hang or hijack a host-side
// setTools() call. Indexing touches only the copy's own properties.
globalThis.__registerTools = function (names) {
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    globalThis[name] = async (...args) => {
      const envJson = await __callTool.apply(
        undefined,
        [name, JSON.stringify(args)],
        { arguments: { copy: true }, result: { promise: true, copy: true } }
      );
      const env = JSON.parse(envJson);
      if (!env.ok) throw new Error(env.error);
      return env.value;
    };
  }
};
})();
`;

interface ToolEnvelope {
  ok: boolean;
  value?: unknown;
  error?: string;
}

export class IsolatedVmExecutor implements ReplExecutor {
  private readonly isolate: IVM.Isolate;
  private readonly context: IVM.Context;
  private readonly captureRef: IVM.Reference;
  private readonly callToolRef: IVM.Reference;
  /** In-isolate tool registrar, held host-side because the guest must not
   *  reach it - see the BOOTSTRAP comment above `__registerTools`. */
  private readonly registerToolsRef: IVM.Reference;
  private readonly timeoutMs: number;
  private readonly toolTimeoutMs: number;
  private readonly toolMinBudgetMs: Record<string, number>;
  private readonly label: string;
  /** Global names present immediately after bootstrap - the "builtin"
   * baseline listGlobals() subtracts so callers see only user-defined
   * globals + registered tools. */
  private readonly baselineGlobals: Set<string>;

  private tools: ReplToolMap = {};
  private disposed = false;
  private hostRefsReleased = false;
  /**
   * Wall-clock instant the in-flight run must be done by, or null between
   * runs. Every tool call in a run draws down the SAME budget: capping each
   * call individually bounds one stalled tool but not a loop of them, and a
   * loop is exactly the shape `code_execute`'s own guidance asks the model to
   * write ("iterate over many items without spawning an LLM call per item").
   * Two sequential calls each comfortably inside `toolTimeoutMs` could still
   * sum past the host deadline and dispose the isolate mid-loop.
   *
   * Derived from the deadline rather than by subtracting each call's measured
   * time, so guest CPU burned BETWEEN tool calls counts against it too.
   */
  private runDeadlineAt: number | null = null;

  /**
   * stdout capture state, bounded AT PUSH TIME - head, then a rolling tail,
   * with what fell between them counted rather than kept.
   *
   * This array lives on the HOST heap, which the isolate's `memoryLimit` does
   * not cover: it bounds the guest's own heap and says nothing about a buffer
   * the host grows on the guest's behalf. Collecting everything and slicing
   * afterwards therefore let `while (true) console.log(x)` grow the Lambda's
   * heap one line at a time, inside a run that is otherwise correctly capped.
   * The per-line cap in the bootstrap bounds one iteration, not their sum.
   *
   * The head/tail rule is the same one `collectStdout()` reports and the same
   * one the worker backend mirrors with, so what is kept is exactly what would
   * have been printed, in print order. `stdoutHeadFull` is what keeps the
   * order half of that true - see `captureLine()`. Must stay in sync with
   * `WorkerReplExecutor`'s `headMirrorFull`.
   */
  private stdoutHead: string[] = [];
  private stdoutHeadBytes = 0;
  /** Latched once a line has gone to the tail: the head never reopens. */
  private stdoutHeadFull = false;
  private stdoutTail: string[] = [];
  private stdoutTailBytes = 0;
  private stdoutElidedBytes = 0;
  private truncated = false;

  constructor(opts: IsolatedVmExecutorOptions = {}) {
    // Reject a non-positive or non-finite cap rather than adopting it: a
    // `timeoutMs` of 0 or NaN makes every bound derived from it meaningless
    // (NaN loses every comparison), which disables the ladder silently.
    if (opts.timeoutMs !== undefined && (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0)) {
      throw new Error(`[IsolatedVmExecutor] timeoutMs must be a positive finite number (got ${opts.timeoutMs})`);
    }
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Strictly proportional, with no absolute floor: a floor above
    // `timeoutMs` would put the tool timeout AFTER the host deadline and
    // silently restore the behaviour this bound exists to prevent. An explicit
    // override is clamped for the same reason.
    const derivedToolTimeout = Math.max(1, Math.floor(this.timeoutMs * TOOL_CALL_TIMEOUT_FRACTION));
    // A degenerate override (0, negative, NaN) used to pass the `< timeoutMs`
    // test and become the cap, so every tool call failed instantly - or, for
    // NaN, never timed out at all, since `setTimeout(NaN)` fires immediately
    // but NaN also fails the comparison that would have rejected it.
    const requestedToolTimeout = opts.toolTimeoutMs;
    const usableToolTimeout =
      requestedToolTimeout !== undefined &&
      Number.isFinite(requestedToolTimeout) &&
      requestedToolTimeout > 0 &&
      requestedToolTimeout < this.timeoutMs
        ? requestedToolTimeout
        : undefined;
    if (requestedToolTimeout !== undefined && usableToolTimeout === undefined) {
      Logger.globalInstance.warn(
        `[IsolatedVmExecutor] toolTimeoutMs (${requestedToolTimeout}ms) must be a positive finite number below ` +
          `timeoutMs (${this.timeoutMs}ms), or a stalled tool reaches the host deadline, which retires the ` +
          `isolate. Using ${derivedToolTimeout}ms instead.`
      );
    }
    this.toolTimeoutMs = usableToolTimeout ?? derivedToolTimeout;
    // Non-finite or non-positive floors are dropped rather than adopted: a NaN
    // floor loses every comparison, so it would silently disable the refusal
    // it was passed in to enforce - the same failure mode the timeout
    // validation above exists for.
    this.toolMinBudgetMs = {};
    for (const [name, floor] of Object.entries(opts.toolMinBudgetMs ?? {})) {
      if (Number.isFinite(floor) && floor > 0) {
        this.toolMinBudgetMs[name] = floor;
        continue;
      }
      Logger.globalInstance.warn(
        `[IsolatedVmExecutor] toolMinBudgetMs.${name} (${floor}) must be a positive finite number; ignoring it. ` +
          `That tool will be dispatched with whatever the run has left.`
      );
    }
    this.label = opts.label ?? 'isolated-vm-repl';
    const ivm = loadIvm();
    this.isolate = new ivm.Isolate({ memoryLimit: opts.memoryLimitMb ?? DEFAULT_MEMORY_LIMIT_MB });
    this.context = this.isolate.createContextSync();

    const jail = this.context.global;
    // Host hooks. Held as instance fields so the host-side Reference wrappers
    // stay alive for the isolate's lifetime and are released on dispose().
    this.captureRef = new ivm.Reference((line: string) => this.captureLine(line));
    this.callToolRef = new ivm.Reference((name: string, argsJson: string) => this.dispatchTool(name, argsJson));
    jail.setSync('_captureLine', this.captureRef);
    jail.setSync('_callTool', this.callToolRef);

    this.context.evalSync(BOOTSTRAP);

    // Lift the registrar out of the guest global and delete it there. Done
    // BEFORE the baseline snapshot so it is absent from both the isolate and
    // listGlobals()'s notion of "builtin".
    this.registerToolsRef = this.context.evalSync('globalThis.__registerTools', {
      reference: true,
    }) as IVM.Reference;
    this.context.evalSync('delete globalThis.__registerTools');

    this.baselineGlobals = new Set(this.readGlobalNames());
  }

  setTools(tools: ReplToolMap): void {
    // Skip any tool whose name would shadow a bootstrap-owned global
    // (console capture, the structuredClone/codegen helpers, or a host-hook
    // name). Warn rather than silently drop so a misnamed tool is visible.
    const filtered: ReplToolMap = {};
    for (const [name, fn] of Object.entries(tools)) {
      if (RESERVED_GLOBAL_NAMES.has(name)) {
        Logger.globalInstance.warn(
          `[IsolatedVmExecutor] skipping tool "${name}" — it would shadow a reserved in-isolate global ` +
            `(console / structuredClone / eval / Function / internal bridge hooks). Rename the tool.`
        );
        continue;
      }
      filtered[name] = fn;
    }
    // Merge (add-or-replace), matching ReplContext's setTools semantics:
    // repeated calls accumulate rather than wholesale-replace, so a caller
    // can layer tools on without dropping earlier registrations.
    const merged = { ...this.tools, ...filtered };
    if (this.disposed) {
      this.tools = merged;
      return;
    }
    // Bind the in-isolate stubs BEFORE committing the host-side dispatch
    // table, so a failed registration leaves the two halves consistent
    // rather than advertising tools the isolate cannot call.
    this.registerToolsRef.applySync(undefined, [Object.keys(merged)], {
      arguments: { copy: true },
      timeout: this.timeoutMs,
    });
    this.tools = merged;
  }

  async runCode(code: string): Promise<ReplRunResult> {
    if (this.disposed) {
      throw new ReplSandboxRetiredError(`IsolatedVmExecutor [${this.label}] has been disposed`);
    }
    this.resetStdout();
    const t0 = Date.now();
    // Opened here and closed in the `finally`, so tool calls can see how much
    // of the run is left. Deliberately the script cap, not the host deadline:
    // the tool bound must fire BEFORE the deadline that disposes the isolate.
    this.runDeadlineAt = t0 + this.timeoutMs;

    // Wrap in async IIFE so top-level `await` works. The IIFE expression is
    // the script's completion value; `promise: true` makes run() await it.
    const wrapped = `(async () => {\n${code}\n})()`;

    let error: string | null = null;
    let script: IVM.Script | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      script = await this.isolate.compileScript(wrapped);
      const run = script.run(this.context, { timeout: this.timeoutMs, promise: true });
      // isolated-vm offers no way to abandon a pending in-isolate promise, so
      // the only preemption available is killing the isolate. That ends the
      // session - deliberately: the alternative is leaving a continuation
      // parked in a live sandbox that could resume, and run guest code, after
      // we already told the caller the run was over.
      const deadline = new Promise<never>((_, reject) => {
        deadlineTimer = setTimeout(() => {
          try {
            if (!this.isolate.isDisposed) this.isolate.dispose();
          } catch {
            // already gone; the rejection below is what the caller sees
          }
          reject(
            new Error(
              `REPL run exceeded the ${this.timeoutMs}ms cap without executing (pending promise or ` +
                `unresolved tool call); isolate [${this.label}] was terminated`
            )
          );
        }, this.timeoutMs + HOST_DEADLINE_GRACE_MS);
      });
      await Promise.race([run, deadline]);
    } catch (e) {
      error = serializeError(e);
    } finally {
      this.runDeadlineAt = null;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      try {
        script?.release();
      } catch {
        // releasing a script whose isolate is already disposed throws
      }
    }

    // A memory-limit breach - or the host deadline above - disposes the isolate
    // out from under us. Mark ourselves disposed so the next runCode/setTools
    // fails fast instead of throwing opaque "isolate is disposed" errors deep in
    // isolated-vm, and release the host-side References here: dispose() gates on
    // the `disposed` flag, so once it is set a later dispose() would early-return
    // and strand them.
    const sandboxRetired = this.isolate.isDisposed;
    if (sandboxRetired) {
      this.disposed = true;
      this.releaseHostRefs();
      if (!error) error = `Error: isolate [${this.label}] disposed (likely exceeded memory limit)`;
    }

    // Report the retirement on the run that CAUSED it. Returning a bare result
    // here made the breaching run look like an ordinary failure and deferred
    // the terminal signal to the next call, so an agent saw "step failed" -
    // which reads as retryable - at the one moment it most needed to stop.
    // Flagged rather than thrown so stdout captured before the kill survives.
    return {
      stdout: this.collectStdout(),
      error,
      truncated: this.truncated,
      durationMs: Date.now() - t0,
      ...(sandboxRetired ? { sandboxRetired: true } : {}),
    };
  }

  listGlobals(): string[] {
    if (this.disposed) return [];
    return this.readGlobalNames().filter(n => !this.baselineGlobals.has(n));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseHostRefs();
    try {
      if (!this.isolate.isDisposed) this.isolate.dispose();
    } catch {
      // isolate already disposed (e.g. memory-limit breach)
    }
  }

  /**
   * Release the host-side `ivm.Reference` wrappers. `new ivm.Reference(fn)`
   * allocates its persistent handle in the HOST isolate, so disposing the guest
   * isolate does not reclaim it - only `release()` does. Idempotent, and called
   * from every path that retires this executor (`dispose()` and the
   * isolate-died-under-us branch in `runCode`), because a stranded handle plus
   * its closure lives for the life of the process - which on a warm Lambda
   * container means it accumulates per timed-out run.
   */
  private releaseHostRefs(): void {
    if (this.hostRefsReleased) return;
    this.hostRefsReleased = true;
    try {
      this.captureRef.release();
    } catch {
      // already released / isolate gone
    }
    try {
      this.callToolRef.release();
    } catch {
      // already released / isolate gone
    }
    try {
      this.registerToolsRef.release();
    } catch {
      // already released / isolate gone
    }
  }

  // -- private helpers --

  /**
   * Host-side tool dispatcher. Invoked from inside the isolate via the
   * `_callTool` Reference. ALWAYS resolves with a JSON `{ ok, value|error }`
   * envelope - never rejects - because an `ivm.Reference` that returns a
   * rejected promise surfaces as an unhandled rejection on the host rather
   * than propagating to the in-isolate awaiter. The in-isolate stub
   * re-throws on `ok:false`.
   */
  private dispatchTool = async (name: string, argsJson: string): Promise<string> => {
    const tool: ReplToolFn | undefined = this.tools[name];
    if (!tool) {
      return JSON.stringify({ ok: false, error: `tool "${name}" not registered with IsolatedVmExecutor` });
    }
    let value: unknown;
    try {
      const args = JSON.parse(argsJson) as unknown[];
      // Bound the tool call here, on the host, rather than letting a tool that
      // never settles ride the run all the way to the host deadline in
      // runCode(). That deadline's only means of preemption is disposing the
      // isolate, which costs the session every later code_execute while the
      // agent loop keeps spending iterations on a tool that can no longer
      // work. A per-tool timeout instead surfaces as an ordinary failed tool
      // call the agent can route around, isolate intact.
      //
      // The abandoned promise is left running: we stop awaiting it, we cannot
      // cancel it. Tools own their own cancellation (the data-lake tools pass
      // an AbortSignal to every fetch); this is the backstop for one that
      // does not.
      //
      // Bounded by whichever is tighter: this call's own cap, or what is left
      // of the run. The per-call cap alone bounds one stalled tool, not a
      // sequence of merely slow ones - and the run's budget is what the host
      // deadline actually enforces.
      const budgetMs = this.remainingToolBudgetMs();
      if (budgetMs <= 0) {
        return JSON.stringify({
          ok: false,
          error:
            `tool "${name}" was not dispatched: this code_execute run has no time left of its ` +
            `${this.timeoutMs}ms budget. Do less work per run, or split it across calls.`,
        });
      }
      // Refuse rather than dispatch under the tool's own floor. Dispatching a
      // tool with less time than it bounds itself by inverts the ladder: we
      // stop awaiting first, and its abort - which is what settles a spend or
      // produces the attributable error - fires into a run nobody is reading
      // any more. Refusing costs the agent one observation it can see and
      // route around, which is strictly the cheaper failure. See
      // `toolMinBudgetMs`.
      const floorMs = this.toolMinBudgetMs[name];
      if (floorMs !== undefined && budgetMs < floorMs) {
        return JSON.stringify({
          ok: false,
          error:
            `tool "${name}" was not dispatched: it needs at least ${floorMs}ms and only ${budgetMs}ms of this ` +
            `code_execute run's ${this.timeoutMs}ms budget remains. Call it earlier in the run, or in a run of ` +
            `its own.`,
        });
      }
      value = await withTimeout(
        tool(...args),
        budgetMs,
        `tool "${name}" did not settle within ${budgetMs}ms (of this run's ${this.timeoutMs}ms budget) ` +
          `and was abandoned`
      );
    } catch (e) {
      const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      return JSON.stringify({ ok: false, error: message });
    }
    // Serialize the result in its OWN try, separate from the tool invocation:
    // a non-JSON-serializable return (BigInt, circular reference) must surface
    // as a clear "non-serializable value" error, NOT masquerade as a thrown
    // tool error (`TypeError: Do not know how to serialize a BigInt`). The
    // worker backend's structured-clone IPC is BigInt-safe; this backend's
    // JSON bridge is not, so we make the failure mode explicit.
    // `value === undefined` would drop the key under JSON.stringify and
    // surface as the string "undefined"; normalise to null so the envelope
    // always parses cleanly inside the isolate.
    try {
      const env: ToolEnvelope = { ok: true, value: value === undefined ? null : value };
      return JSON.stringify(env);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      return JSON.stringify({
        ok: false,
        error: `tool "${name}" returned a value that is not JSON-serializable across the isolate boundary (e.g. BigInt, circular reference): ${detail}`,
      });
    }
  };

  /**
   * How long the next tool call may take: its own cap, capped again by what
   * remains of the run. `runDeadlineAt` is null outside a run (a tool invoked
   * from a stray host-side reference), where the per-call cap is the only
   * bound that makes sense.
   */
  private remainingToolBudgetMs(): number {
    if (this.runDeadlineAt === null) return this.toolTimeoutMs;
    return Math.min(this.toolTimeoutMs, this.runDeadlineAt - Date.now());
  }

  private readGlobalNames(): string[] {
    const json = this.context.evalSync('JSON.stringify(Object.getOwnPropertyNames(globalThis))') as string;
    try {
      return JSON.parse(json) as string[];
    } catch {
      return [];
    }
  }

  private captureLine(line: string): void {
    // `+ 1` throughout: the newline collectStdout() will join with, so the
    // budgets are counted in the units they are spent in.
    const cost = line.length + 1;
    // A fit check, not "is the head already over" - the latter admits one line
    // of up to HARD_PER_LINE_BYTES past the budget, so the line that crosses
    // starts the tail instead. Latched, because the fit check ALONE is not
    // enough: once a long line has opened the tail, a shorter line printed
    // after it still fits the head and would render above lines that are
    // actually older, with elidedBytes still 0 so nothing reports it.
    if (!this.stdoutHeadFull && this.stdoutHeadBytes + cost <= STDOUT_HEAD_BYTES) {
      this.stdoutHead.push(line);
      this.stdoutHeadBytes += cost;
      return;
    }
    this.stdoutHeadFull = true;
    this.stdoutTail.push(line);
    this.stdoutTailBytes += cost;
    // The tail gets whatever the head did not use of the same HEAD + TAIL
    // total, so a run whose first line is too big for the head is still kept
    // whole up to that total rather than clipped to the tail budget alone.
    const tailBudget = STDOUT_HEAD_BYTES + STDOUT_TAIL_BYTES - this.stdoutHeadBytes;
    // Keep at least one line even when a single line is larger than the whole
    // budget, or a chatty run's last line - the most diagnostic one - would be
    // evicted by its own arrival.
    while (this.stdoutTailBytes > tailBudget && this.stdoutTail.length > 1) {
      const dropped = this.stdoutTail.shift() as string;
      this.stdoutTailBytes -= dropped.length + 1;
      this.stdoutElidedBytes += dropped.length + 1;
    }
  }

  private resetStdout(): void {
    this.stdoutHead = [];
    this.stdoutHeadBytes = 0;
    this.stdoutHeadFull = false;
    this.stdoutTail = [];
    this.stdoutTailBytes = 0;
    this.stdoutElidedBytes = 0;
    this.truncated = false;
  }

  private collectStdout(): string {
    const head = this.stdoutHead.join('\n');
    if (this.stdoutTail.length === 0) return head;
    const joinedTail = this.stdoutTail.join('\n');
    // The rolling window never evicts its only entry, so it can still hold ONE
    // line longer than the whole budget (up to HARD_PER_LINE_BYTES). Report
    // the last N chars of it, which is both the rule the worker mirror uses
    // and the end of the line a reader actually wants.
    const budget = STDOUT_HEAD_BYTES + STDOUT_TAIL_BYTES - this.stdoutHeadBytes;
    const overflow = Math.max(0, joinedTail.length - budget);
    const tail = overflow > 0 ? joinedTail.slice(overflow) : joinedTail;
    const elidedBytes = this.stdoutElidedBytes + overflow;
    if (elidedBytes === 0) return head.length === 0 ? tail : `${head}\n${tail}`;
    this.truncated = true;
    // An empty head is ordinary now that the head takes only lines that FIT
    // it: a first line larger than the head budget starts the tail instead.
    const marker = `[...${elidedBytes} bytes truncated...]`;
    return head.length === 0 ? `${marker}\n${tail}` : `${head}\n${marker}\n${tail}`;
  }
}

/**
 * Resolve `p`, or reject with `message` after `ms`. The loser is abandoned,
 * not cancelled - callers must be able to tolerate the work continuing.
 */
async function withTimeout<T>(p: Promise<T> | T, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function serializeError(e: unknown): string {
  if (e instanceof Error) {
    const stack = e.stack ? `\n${e.stack.split('\n').slice(0, 6).join('\n')}` : '';
    return `${e.name}: ${e.message}${stack}`;
  }
  const t = typeof e;
  if (t === 'object' && e !== null) {
    let serialized = '';
    try {
      serialized = JSON.stringify(e);
    } catch {
      serialized = '[unserializable]';
    }
    if (serialized === '{}' || serialized === '[]') {
      const ctor = (e as object).constructor?.name ?? 'Object';
      return `[non-Error throw: empty ${ctor} — likely \`throw {}\` or thrown DOM exception]`;
    }
    return `[non-Error throw: ${serialized.slice(0, 500)}]`;
  }
  return `[${t} throw: ${String(e).slice(0, 200)}]`;
}
