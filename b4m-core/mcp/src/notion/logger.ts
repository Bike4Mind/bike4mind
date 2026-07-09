/**
 * Notion MCP Server - Debug Logger
 *
 * Verbose logging gated by the NOTION_DEBUG env var.
 * All output goes to stderr so it never contaminates MCP JSON on stdout.
 */

function isDebug(): boolean {
  return process.env.NOTION_DEBUG === 'true' || process.env.NOTION_DEBUG === '1';
}

const prefix = '[notion]';

export function debug(message: string, data?: unknown): void {
  if (!isDebug()) return;
  if (data !== undefined) {
    console.error(prefix, message, JSON.stringify(data, null, 2));
  } else {
    console.error(prefix, message);
  }
}

export function debugWarn(message: string, data?: unknown): void {
  if (!isDebug()) return;
  if (data !== undefined) {
    console.error(prefix, '[warn]', message, JSON.stringify(data, null, 2));
  } else {
    console.error(prefix, '[warn]', message);
  }
}

export function debugError(message: string, error?: unknown): void {
  if (!isDebug()) return;
  console.error(prefix, '[error]', message, error);
}
