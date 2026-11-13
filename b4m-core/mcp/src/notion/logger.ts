/**
 * Notion MCP Server - Debug Logger
 *
 * Verbose logging gated by the NOTION_DEBUG env var.
 * All output goes to stderr (redacted JSON lines) so it never contaminates MCP JSON on stdout.
 */

import { stderrLog } from '../shared/stderrLog.js';

function isDebug(): boolean {
  return process.env.NOTION_DEBUG === 'true' || process.env.NOTION_DEBUG === '1';
}

// `detail`, not `data`: redaction blanks a `data` key wholesale.
export function debug(message: string, data?: unknown): void {
  if (!isDebug()) return;
  stderrLog('debug', 'notion', message, data === undefined ? undefined : { detail: data });
}

export function debugWarn(message: string, data?: unknown): void {
  if (!isDebug()) return;
  stderrLog('warn', 'notion', message, data === undefined ? undefined : { detail: data });
}

export function debugError(message: string, error?: unknown): void {
  if (!isDebug()) return;
  stderrLog('error', 'notion', message, error === undefined ? undefined : { error });
}
