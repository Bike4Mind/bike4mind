import { redactLogValue } from '@bike4mind/observability';
import type { StderrLogger } from './stderrLog.js';

function emit(level: 'warn' | 'error', scope: string, message: string, fields?: Record<string, unknown>): void {
  const redacted = fields ? redactLogValue(fields) : undefined;
  // eslint-disable-next-line no-console -- host-side logger: the CLI's Ink patches console.*, and a raw stderr write would tear its frame
  console[level](`[${scope}] ${message}`, ...(redacted ? [redacted] : []));
}

/**
 * Redacting logger for code that runs inside a host process (the CLI's Ink TUI, desktop main, servers),
 * as opposed to a stdio server. Goes through `console` so the host's patching and redaction apply.
 * debug/info are not used by host-side callers and map to warn-free no-ops.
 */
export function createConsoleLogger(scope: string): StderrLogger {
  return {
    debug: () => {},
    info: () => {},
    warn: (message, fields) => emit('warn', scope, message, fields),
    error: (message, fields) => emit('error', scope, message, fields),
  };
}
