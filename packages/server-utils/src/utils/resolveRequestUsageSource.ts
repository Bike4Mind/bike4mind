import { parseMcpClient, resolveApiCompletionSource, type ApiKeyCompletionSource } from '@bike4mind/common';
import type { IncomingHttpHeaders } from 'http';
import { flattenHeaders } from './flattenHeaders';

/**
 * The `source` a public API route stamps on its UsageEvent and ledger rows: `cli` for the b4m CLI,
 * `desktop` for B4M Desktop, `mcp` for an MCP host, else `api`. The same classifier apiKeyAuth stamps
 * on ApiKeyUsageLog, so the admin dashboard's credit sections and endpoint section filter the same
 * slice - keep the two on one rule.
 */
export const resolveRequestUsageSource = (req: { headers: IncomingHttpHeaders }): ApiKeyCompletionSource =>
  resolveApiCompletionSource(flattenHeaders(req.headers));

/** The sanitized MCP host name for an `mcp` request, else undefined. Analytics only. */
export const resolveRequestMcpClient = (req: { headers: IncomingHttpHeaders }): string | undefined =>
  parseMcpClient(flattenHeaders(req.headers))?.client;
