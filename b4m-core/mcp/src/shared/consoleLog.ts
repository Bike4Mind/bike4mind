import { redactLogText, redactLogValue } from '@bike4mind/observability';
import type { StderrLogger } from './stderrLog.js';

function emit(level: 'warn' | 'error', scope: string, message: string, fields?: Record<string, unknown>): void {
  const redacted = fields ? redactLogValue(fields) : undefined;
  // eslint-disable-next-line no-console -- host-side logger: the CLI's Ink patches console.*, and a raw stderr write would tear its frame
  console[level](`[${scope}] ${redactLogText(message)}`, ...(redacted ? [redacted] : []));
}

/**
 * Redacting logger for code that runs inside a host process (the CLI's Ink TUI, desktop main, servers),
 * as opposed to a stdio server. Redaction happens here in `emit`; writing through `console` lets the
 * host's console patching apply. debug/info are no-ops: host-side callers do not use them.
 */
export function createConsoleLogger(scope: string): StderrLogger {
  return {
    debug: () => {},
    info: () => {},
    warn: (message, fields) => emit('warn', scope, message, fields),
    error: (message, fields) => emit('error', scope, message, fields),
  };
}
