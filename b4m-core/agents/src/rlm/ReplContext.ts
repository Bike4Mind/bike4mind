import vm from 'node:vm';

/**
 * ReplContext wraps a Node `vm.Context` so an LLM can run JavaScript across
 * multiple turns and have variables, classified buffers, and computed state
 * persist between calls.
 *
 * The execution context is constructed once and reused for the lifetime of
 * a session. Each `runCode(code)` call:
 *   1. Wraps `code` in an async IIFE so top-level `await` works
 *   2. Routes `console.log` / `console.error` into a captured stdout buffer
 *   3. Truncates the buffer to ~7K chars (5K head + 2K tail) before returning
 *   4. Catches any thrown error and serializes it
 *
 * Tools are exposed by passing a `tools` map to `setTools()` - they become
 * top-level async functions inside the REPL. The agent's natural-language
 * tool calls and these in-REPL function calls are functionally equivalent;
 * the difference is that in-REPL calls happen inside a single `runCode()`
 * invocation and don't burn a full LLM turn each.
 *
 * SECURITY NOTE: `vm.runInContext` is *not* a security sandbox. It provides
 * a fresh global scope but the same V8 process. Acceptable for trusted
 * tavern-internal agent code; pre-production rollout to user-facing
 * surfaces should swap this for `isolated-vm` or a worker-thread pool.
 *
 * See: apps/client/server/tavern/docs/07-PERSISTENT-REPL-TOOL.md
 */

const STDOUT_HEAD_BYTES = 5000;
const STDOUT_TAIL_BYTES = 2000;
const DEFAULT_TIMEOUT_MS = 30_000;

export type ReplToolFn = (...args: unknown[]) => Promise<unknown> | unknown;
export type ReplToolMap = Record<string, ReplToolFn>;

export interface ReplRunResult {
  stdout: string;
  error: string | null;
  truncated: boolean;
  durationMs: number;
}

export interface ReplContextOptions {
  /** Hard wall-clock cap for a single runCode call. Default 30s. */
  timeoutMs?: number;
  /** Initial set of tools to expose. Can also be set later via setTools(). */
  tools?: ReplToolMap;
  /** Optional label for log prefixes (e.g. agent name). */
  label?: string;
}

export class ReplContext {
  private ctx: vm.Context;
  private stdoutChunks: string[] = [];
  private stdoutBytes = 0;
  private truncated = false;
  private readonly timeoutMs: number;
  private readonly label: string;
  /** Names of builtins injected at construction. Captured from the sandbox
   * keys so it can't drift from the actual sandbox shape. listGlobals()
   * filters these out so callers see only user-defined globals + tools. */
  private readonly injectedBuiltinNames: Set<string>;

  constructor(opts: ReplContextOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.label = opts.label ?? 'repl';

    const sandbox: Record<string, unknown> = {
      console: {
        log: (...args: unknown[]) => this.captureLine(args),
        warn: (...args: unknown[]) => this.captureLine(args),
        error: (...args: unknown[]) => this.captureLine(args),
        info: (...args: unknown[]) => this.captureLine(args),
      },
      // Standard JS stdlib safe to expose
      Math,
      JSON,
      Date,
      RegExp,
      Error,
      TypeError,
      RangeError,
      Promise,
      Array,
      Object,
      String,
      Number,
      Boolean,
      Map,
      Set,
      WeakMap,
      WeakSet,
      Symbol,
      // Number coercion / validation builtins. LLM-generated code uses
      // these freely; without them parseInt('10') hits ReferenceError
      // instead of returning 10.
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      // Useful tiny utilities
      structuredClone: globalThis.structuredClone,
      // No filesystem, no network, no process - all intentionally absent.
    };

    // Snapshot the builtin names BEFORE merging caller-supplied tools so
    // listGlobals() correctly identifies tools as user-defined.
    this.injectedBuiltinNames = new Set(Object.keys(sandbox));

    if (opts.tools) {
      for (const [name, fn] of Object.entries(opts.tools)) {
        sandbox[name] = fn;
      }
    }

    this.ctx = vm.createContext(sandbox, {
      name: this.label,
      // strings: false disables `eval()` and `new Function()` inside the
      // context. The LLM has no legitimate reason to generate second-order
      // code that's invisible in the logged `code` parameter.
      codeGeneration: { strings: false, wasm: false },
    });
  }

  /**
   * Add or replace tools available inside the REPL. Tools persist into the
   * context's globals and remain callable from subsequent runCode calls.
   * Replacing a tool name overwrites the prior binding.
   */
  setTools(tools: ReplToolMap): void {
    for (const [name, fn] of Object.entries(tools)) {
      // We assign onto the context object directly. vm.createContext returns
      // the sandbox object itself, so this writes into the V8 global scope.
      (this.ctx as unknown as Record<string, unknown>)[name] = fn;
    }
  }

  /**
   * Get a snapshot of current global names defined in the REPL - useful for
   * debugging "what variables does the LLM have access to" questions.
   * Filters out the built-in/injected names so the result is just the
   * user-defined globals (variables the LLM has assigned, plus any
   * tools wired via setTools that haven't been overwritten).
   */
  listGlobals(): string[] {
    const all = Object.keys(this.ctx as unknown as Record<string, unknown>);
    return all.filter(k => !this.injectedBuiltinNames.has(k));
  }

  /**
   * Execute a code block in the persistent context. Variables declared with
   * `let`/`const`/`var` at the top level of `code` are stored on the IIFE's
   * scope and DO NOT persist (this is JS semantics). To persist a value,
   * assign it to the context object directly:
   *
   *   ```js
   *   // turn 1
   *   results = await semanticSearch({ query: "pricing" });
   *   console.log(results.length);
   *
   *   // turn 2 (same session)
   *   console.log(results[0].file_name);  // works - `results` persisted
   *   ```
   *
   * Implicit-global assignment (no `let`/`const`/`var`) is the persistence
   * idiom, matching how Python REPLs work. The system prompt instructs the
   * LLM to use this pattern for cross-turn state.
   */
  async runCode(code: string): Promise<ReplRunResult> {
    this.resetStdout();
    const t0 = Date.now();

    // Wrap in async IIFE so `await` works at top level.
    const wrapped = `(async () => {\n${code}\n})()`;

    let error: string | null = null;
    try {
      const promise = vm.runInContext(wrapped, this.ctx, {
        timeout: this.timeoutMs,
        displayErrors: true,
        breakOnSigint: true,
      }) as Promise<unknown>;
      await promise;
    } catch (e) {
      error = serializeError(e);
    }

    const durationMs = Date.now() - t0;
    return {
      stdout: this.collectStdout(),
      error,
      truncated: this.truncated,
      durationMs,
    };
  }

  // -- private helpers --

  private captureLine(args: unknown[]): void {
    const line = args
      .map(a => {
        if (typeof a === 'string') return a;
        if (a === undefined) return 'undefined';
        if (a === null) return 'null';
        try {
          return JSON.stringify(a, jsonReplacer, 2);
        } catch {
          return String(a);
        }
      })
      .join(' ');

    // Defensive: cap any single line to 50K to prevent one runaway print
    // from consuming the whole budget.
    const capped = line.length > 50_000 ? line.slice(0, 50_000) + ' [...line truncated]' : line;
    this.stdoutChunks.push(capped);
    this.stdoutBytes += capped.length + 1; // +1 for newline
  }

  private resetStdout(): void {
    this.stdoutChunks = [];
    this.stdoutBytes = 0;
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

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (typeof value === 'bigint') {
    return value.toString() + 'n';
  }
  return value;
}

function serializeError(e: unknown): string {
  if (e instanceof Error) {
    const stack = e.stack ? `\n${e.stack.split('\n').slice(0, 6).join('\n')}` : '';
    return `${e.name}: ${e.message}${stack}`;
  }
  // Non-Error throws (e.g. `throw {}` or `throw "boom"`) - keep the shape
  // discoverable so the agent can fix the offending code.
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
