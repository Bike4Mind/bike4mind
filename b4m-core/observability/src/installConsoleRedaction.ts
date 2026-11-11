import { redactLogText, redactLogValue } from './redactLogValue';

const REDACTED_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table'] as const;
/** `dir(obj, options)` and `table(data, columns)`: only the first argument is data. */
const FIRST_ARG_ONLY: ReadonlySet<ConsoleMethod> = new Set(['dir', 'table']);
/** Bounds the cause/errors chain rebuilt as real Errors; deeper links keep the plain redacted shape. */
const MAX_ERROR_DEPTH = 5;

type ConsoleMethod = (typeof REDACTED_METHODS)[number];
type ConsoleLike = Pick<Console, ConsoleMethod>;

/**
 * Global registry symbol, so the ESM and CJS builds (or a second bundled copy of this package)
 * see the same install marker and never wrap one console twice.
 */
const INSTALLED = Symbol.for('@bike4mind/observability/consoleRedaction');

/**
 * A top-level Error is rebuilt as a real Error from its redacted fields, so `util.inspect` keeps
 * the native stack layout. A provider error's redacted shape drops the stack, so it is scrubbed
 * from the original. An Error `cause` and AggregateError `errors` are rebuilt the same way, so Node
 * still prints its `[cause]` and `[errors]` blocks. Never throws: on failure the plain redacted
 * shape is logged instead.
 */
function redactArg(arg: unknown, depth = 0): unknown {
  const redacted = redactLogValue(arg);
  try {
    if (!(arg instanceof Error) || typeof redacted !== 'object' || redacted === null) return redacted;
    if (depth >= MAX_ERROR_DEPTH) return redacted;
    const { name, message, stack, cause, ...rest } = redacted as Record<string, unknown>;
    const error = new Error(typeof message === 'string' ? message : '');
    error.name = typeof name === 'string' ? name : arg.name;
    error.stack = typeof stack === 'string' ? stack : redactLogText(arg.stack ?? '');
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) (error as unknown as Record<string, unknown>)[key] = value;
    }
    if (cause !== undefined) {
      const rebuilt = arg.cause instanceof Error ? redactArg(arg.cause, depth + 1) : cause;
      Object.defineProperty(error, 'cause', { value: rebuilt, configurable: true, writable: true });
    }
    if (arg instanceof AggregateError && Array.isArray(arg.errors)) {
      const errors = arg.errors.map(inner => redactArg(inner, depth + 1));
      Object.defineProperty(error, 'errors', { value: errors, configurable: true, writable: true });
    }
    return error;
  } catch {
    return redacted;
  }
}

/**
 * Route every `console.log/info/warn/error/debug/trace/dir/table` argument through
 * {@link redactLogValue}, so raw calls and third-party libraries get the same scrubbing as the
 * Logger. Call once at process bootstrap; later calls on the same console are no-ops. Direct
 * `process.stdout/stderr.write` is not covered.
 *
 * The Logger writes through `console` too. Its output is already redacted and the scrubbers are
 * idempotent, so a line with nothing to redact passes through unchanged.
 */
export function installConsoleRedaction(target: ConsoleLike = console): void {
  const marked = target as ConsoleLike & { [INSTALLED]?: true };
  if (marked[INSTALLED]) return;
  Object.defineProperty(marked, INSTALLED, { value: true, enumerable: false, configurable: true });

  for (const method of REDACTED_METHODS) {
    const original = (target[method] as (...args: unknown[]) => void).bind(target);
    const firstArgOnly = FIRST_ARG_ONLY.has(method);
    // A getter or toJSON that logs while being redacted would otherwise recurse; the nested call
    // still gets the string scrubbers but its objects are not walked again.
    let redacting = false;
    target[method] = (...args: unknown[]) => {
      if (redacting) {
        original(
          ...args.map(arg => (typeof arg === 'object' && arg !== null ? '[Unserializable]' : redactLogValue(arg)))
        );
        return;
      }
      redacting = true;
      let redacted: unknown[];
      try {
        redacted = args.map((arg, index) => (firstArgOnly && index > 0 ? arg : redactArg(arg)));
      } finally {
        redacting = false;
      }
      original(...redacted);
    };
  }
}
