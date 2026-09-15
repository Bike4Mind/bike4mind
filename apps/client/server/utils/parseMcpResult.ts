import { Logger } from '@bike4mind/observability';

/**
 * Parse the raw result returned by invokeMcpHandler into a usable object.
 *
 * MCP results can arrive as:
 *  1. A plain string (try JSON.parse, fall back to wrapping)
 *  2. An object with nested `content[0].text` JSON
 *  3. An already-parsed object
 */
// Record<string, unknown>: MCP results are dynamic tool-specific shapes
export function parseMcpResult(result: unknown, logger: Logger, logPrefix: string): Record<string, unknown> {
  let data: Record<string, unknown> =
    typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : {};

  if (typeof result === 'string') {
    try {
      data = JSON.parse(result);
    } catch {
      logger.warn(`${logPrefix} MCP result is not valid JSON`, {
        result: result.substring(0, 500),
      });
      data = { message: result };
    }
  }

  // Unwrap nested content structure from MCP
  const content = data?.content as Array<{ text?: string }> | undefined;
  if (content?.[0]?.text) {
    try {
      data = JSON.parse(content[0].text);
    } catch {
      logger.warn(`${logPrefix} Failed to parse MCP content text`, {
        text: String(content[0].text).substring(0, 500),
      });
    }
  }

  return data;
}
