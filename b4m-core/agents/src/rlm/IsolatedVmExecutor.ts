import { createRequire } from 'node:module';
import { Logger } from '@bike4mind/observability';
import type * as IVM from 'isolated-vm';
import type { ReplExecutor } from './replExecutor';
import type { ReplToolFn, ReplToolMap, ReplRunResult } from './ReplContext';

/**
 * In-isolate globals the bootstrap owns. A tool registered under one of these
 * names would shadow `console` capture or the codegen/clone helpers, so
 * `setTools` rejects them. (`_callTool` / `_captureLine` are deleted from the
 * global after bootstrap, but are listed so a tool can't re-create a name that
 * looks like a host hook.)
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
 * When the isolated backend IS activated on a Lambda, that function must
 * externalize + install isolated-vm in its SST `nodejs` config
 * (`esbuild: { external: ['isolated-vm'] }` + `install: ['isolated-vm']` -
 * the pattern in `infra/mcp.ts`) so the linux/x64 prebuild is packaged.
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
const STDOUT_HEAD_BYTES = 5000;
const STDOUT_TAIL_BYTES = 2000;
const HARD_PER_LINE_BYTES = 50_000;

export interface IsolatedVmExecutorOptions {
  /** Per-call wall-clock cap. Default 30s. Enforced by the isolate's CPU timeout. */
  timeoutMs?: number;
  /**
   * Hard memory cap for the isolate, in MB. Default 256 (matches the
   * worker backend's `maxOldGenerationSizeMb`). When the isolate exceeds
   * this it is disposed by V8; the executor marks itself disposed so
   * subsequent calls fail fast rather than throwing opaque errors.
   */
  memoryLimitMb?: number;
  /** Optional label for log prefixes. */
  label?: string;
}

// --- In-isolate bootstrap -------------------------------------------------
// Runs ONCE at context creation. Sets up console capture, a structuredClone
// polyfill (absent from a bare isolate), neuters string codegen for parity
// with the worker/in-process backends, and defines the tool-stub registry.
//
// `_captureLine` and `_callTool` are host `ivm.Reference`s set as globals
// before this runs. We capture them into module-closure consts and delete
// the globals so LLM-generated code can't reach the raw host hooks (and so
// they don't show up in listGlobals()).
const BOOTSTRAP = String.raw`
const __cap = _captureLine;
const __callTool = _callTool;
delete globalThis._captureLine;
delete globalThis._callTool;

const HARD_PER_LINE_BYTES = ${HARD_PER_LINE_BYTES};

function __jsonReplacer(_k, v) {
  if (v instanceof Error) return { name: v.name, message: v.message };
  if (typeof v === 'bigint') return v.toString() + 'n';
  return v;
}
function __formatLine(args) {
  const line = args.map(a => {
    if (typeof a === 'string') return a;
    if (a === undefined) return 'undefined';
    if (a === null) return 'null';
    try { return JSON.stringify(a, __jsonReplacer, 2); } catch { return String(a); }
  }).join(' ');
  return line.length > HARD_PER_LINE_BYTES
    ? line.slice(0, HARD_PER_LINE_BYTES) + ' [...line truncated]'
    : line;
}
globalThis.console = {
  log: (...a) => __cap.applySync(undefined, [__formatLine(a)], { arguments: { copy: true } }),
  warn: (...a) => __cap.applySync(undefined, [__formatLine(a)], { arguments: { copy: true } }),
  error: (...a) => __cap.applySync(undefined, [__formatLine(a)], { arguments: { copy: true } }),
  info: (...a) => __cap.applySync(undefined, [__formatLine(a)], { arguments: { copy: true } }),
};

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

// Tool-stub registry. Each registered tool becomes a top-level async
// function that round-trips through the host dispatcher and re-throws on
// the { ok:false } envelope.
globalThis.__registerTools = function (names) {
  for (const name of names) {
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
  private readonly timeoutMs: number;
  private readonly label: string;
  /** Global names present immediately after bootstrap - the "builtin"
   * baseline listGlobals() subtracts so callers see only user-defined
   * globals + registered tools. */
  private readonly baselineGlobals: Set<string>;

  private tools: ReplToolMap = {};
  private disposed = false;

  // stdout capture state (host side, same shape as ReplContext)
  private stdoutChunks: string[] = [];
  private truncated = false;

  constructor(opts: IsolatedVmExecutorOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
    this.tools = { ...this.tools, ...filtered };
    if (this.disposed) return;
    const names = Object.keys(this.tools);
    this.context.evalSync(`globalThis.__registerTools(${JSON.stringify(names)})`);
  }

  async runCode(code: string): Promise<ReplRunResult> {
    if (this.disposed) {
      throw new Error(`IsolatedVmExecutor [${this.label}] has been disposed`);
    }
    this.resetStdout();
    const t0 = Date.now();

    // Wrap in async IIFE so top-level `await` works. The IIFE expression is
    // the script's completion value; `promise: true` makes run() await it.
    const wrapped = `(async () => {\n${code}\n})()`;

    let error: string | null = null;
    let script: IVM.Script | undefined;
    try {
      script = await this.isolate.compileScript(wrapped);
      await script.run(this.context, { timeout: this.timeoutMs, promise: true });
    } catch (e) {
      error = serializeError(e);
    } finally {
      script?.release();
    }

    // A memory-limit breach disposes the isolate out from under us. Mark
    // ourselves disposed so the next runCode/setTools fails fast instead of
    // throwing opaque "isolate is disposed" errors deep in isolated-vm.
    if (this.isolate.isDisposed) {
      this.disposed = true;
      if (!error) error = `Error: isolate [${this.label}] disposed (likely exceeded memory limit)`;
    }

    return {
      stdout: this.collectStdout(),
      error,
      truncated: this.truncated,
      durationMs: Date.now() - t0,
    };
  }

  listGlobals(): string[] {
    if (this.disposed) return [];
    return this.readGlobalNames().filter(n => !this.baselineGlobals.has(n));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
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
      if (!this.isolate.isDisposed) this.isolate.dispose();
    } catch {
      // isolate already disposed (e.g. memory-limit breach)
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
      value = await tool(...args);
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

  private readGlobalNames(): string[] {
    const json = this.context.evalSync('JSON.stringify(Object.getOwnPropertyNames(globalThis))') as string;
    try {
      return JSON.parse(json) as string[];
    } catch {
      return [];
    }
  }

  private captureLine(line: string): void {
    this.stdoutChunks.push(line);
  }

  private resetStdout(): void {
    this.stdoutChunks = [];
    this.truncated = false;
  }

  private collectStdout(): string {
    const joined = this.stdoutChunks.join('\n');
    if (joined.length <= STDOUT_HEAD_BYTES + STDOUT_TAIL_BYTES) {
      return joined;
    }
    this.truncated = true;
    const head = joined.slice(0, STDOUT_HEAD_BYTES);
    const tail = joined.slice(joined.length - STDOUT_TAIL_BYTES);
    const elidedBytes = joined.length - STDOUT_HEAD_BYTES - STDOUT_TAIL_BYTES;
    return `${head}\n[...${elidedBytes} bytes truncated...]\n${tail}`;
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
