import { redactLogValue } from '@bike4mind/observability';

// Same as console: a closed host pipe (EPIPE) must not surface as an unhandled 'error' event.
let stderrErrorHandled = false;
if (!stderrErrorHandled) {
  stderrErrorHandled = true;
  process.stderr.on('error', () => {});
}

export type StderrLogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Redacting JSON-line logger for the stdio MCP servers.
 *
 * Not an observability `Logger`: that writes debug and info to stdout, which would corrupt the
 * JSON-RPC stream these servers speak. Everything here goes to stderr. Keys named like secrets
 * (token, data, message, ...) are redacted by `redactLogValue`, so put payloads under a neutral key.
 */
export function stderrLog(
  level: StderrLogLevel,
  scope: string,
  message: string,
  fields?: Record<string, unknown>
): void {
  let text: string;
  try {
    text = JSON.stringify(redactLogValue({ severity: level, scope, msg: message, ...fields }), (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value
    );
  } catch {
    // Never throw: callers include the crash handlers, where a throw would skip shutdown.
    text = JSON.stringify({ severity: level, scope, msg: message, logError: 'unserializable fields' });
  }
  process.stderr.write(`${text}\n`);
}

export interface StderrLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** Binds `stderrLog` to a scope so call sites read `log.error('create_issue failed', { toolName, status })`. */
export function createStderrLogger(scope: string): StderrLogger {
  return {
    debug: (message, fields) => stderrLog('debug', scope, message, fields),
    info: (message, fields) => stderrLog('info', scope, message, fields),
    warn: (message, fields) => stderrLog('warn', scope, message, fields),
    error: (message, fields) => stderrLog('error', scope, message, fields),
  };
}
