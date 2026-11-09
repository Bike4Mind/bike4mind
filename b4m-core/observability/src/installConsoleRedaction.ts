import { redactLogValue } from './redactLogValue';

const REDACTED_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

type ConsoleMethod = (typeof REDACTED_METHODS)[number];
type ConsoleLike = Pick<Console, ConsoleMethod>;

/**
 * Global registry symbol, so the ESM and CJS builds (or a second bundled copy of this package)
 * see the same install marker and never wrap one console twice.
 */
const INSTALLED = Symbol.for('@bike4mind/observability/consoleRedaction');

/**
 * Route every `console.log/info/warn/error/debug` argument through {@link redactLogValue}, so raw
 * calls and third-party libraries get the same scrubbing as the Logger. Call once at process
 * bootstrap; later calls on the same console are no-ops.
 *
 * The Logger writes through `console` too. Its output is already redacted and the scrubbers are
 * idempotent, so a line with nothing to redact passes through unchanged.
 */
export function installConsoleRedaction(target: ConsoleLike = console): void {
  const marked = target as ConsoleLike & { [INSTALLED]?: true };
  if (marked[INSTALLED]) return;
  Object.defineProperty(marked, INSTALLED, { value: true, enumerable: false, configurable: true });

  for (const method of REDACTED_METHODS) {
    const original = target[method].bind(target);
    // A getter or toJSON that logs while being redacted would otherwise recurse; the nested call
    // still gets the string scrubbers but its objects are not walked again.
    let redacting = false;
    target[method] = (...args: unknown[]) => {
      if (redacting) {
        original(...args.map(arg => (typeof arg === 'string' ? redactLogValue(arg) : '[Unserializable]')));
        return;
      }
      redacting = true;
      let redacted: unknown[];
      try {
        redacted = args.map(arg => redactLogValue(arg));
      } finally {
        redacting = false;
      }
      original(...redacted);
    };
  }
}
