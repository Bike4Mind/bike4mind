/**
 * Minimal logger shape for code in `@bike4mind/common`, which cannot depend on
 * `@bike4mind/observability`. Structurally compatible with `Logger`, so a server caller can pass its own.
 */
export interface CommonLogger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

const write = (message: string, meta?: unknown) => {
  // eslint-disable-next-line no-console -- stderr only: MCP stdio servers use stdout for JSON-RPC
  if (meta === undefined) console.error(message);
  // eslint-disable-next-line no-console -- see above
  else console.error(message, meta);
};

/** Default logger for the Atlassian/LinkedIn clients: every level goes to stderr so stdout stays clean for MCP stdio. */
export const stderrLogger: CommonLogger = { debug: write, info: write, warn: write, error: write };
