import { redactLogValue } from '@bike4mind/observability';

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
  const line = redactLogValue({ severity: level, scope, msg: message, ...fields });
  process.stderr.write(`${JSON.stringify(line)}\n`);
}
