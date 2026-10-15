/**
 * Turns an MCP confirm preview (a tool result carrying `_confirmToken`, built by
 * `createPreviewResponse` in b4m-core/mcp/src/shared/confirmation-helpers.ts) into the pending
 * action a confirm button later executes.
 *
 * The token is not signed, so its authority comes from where it was emitted. A tool result is
 * not trusted content: a read tool can echo upstream JSON, and a non-confirming server can return
 * anything. A token is only honoured when a confirming server emitted it AND it names the very
 * tool that emitted it AND that tool is one of the server's confirmable write tools, so a click can
 * never execute a different tool than the one previewed, nor a read tool that echoed a token.
 */

import { ATLASSIAN_CONFIRMABLE_TOOLS } from '@bike4mind/mcp/atlassian/constants';
import { GITHUB_CONFIRMABLE_TOOLS } from '@bike4mind/mcp/github/constants';

export type McpPendingAction = {
  tool: string;
  params: Record<string, unknown>;
  ts: number;
};

export type McpPendingActionExtraction =
  | { kind: 'none' }
  | { kind: 'accepted'; action: McpPendingAction; result: string }
  | { kind: 'rejected'; reason: 'malformed' | 'untrusted-emitter' | 'unparseable'; result: string };

/** Per confirming server, the write tools that gate on a confirm button. The host executors route by
 * the same sets (apps/client/server/utils/pendingActionTarget.ts). The subagent permission gate also
 * trusts these servers' tools (isConfirmingMcpTool), so a server belongs here only if every one of its
 * write tools previews instead of executing (pinned by
 * b4m-core/mcp/src/shared/confirmingServers.previewGate.test.ts). */
const CONFIRMABLE_TOOLS_BY_SERVER: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['github', GITHUB_CONFIRMABLE_TOOLS],
  ['atlassian', ATLASSIAN_CONFIRMABLE_TOOLS],
]);

const MCP_NAMESPACE_SEPARATOR = '__';

/** True for a namespaced `server__tool` id from a confirming server. */
export function isConfirmingMcpTool(toolName: string): boolean {
  const separatorIndex = toolName.indexOf(MCP_NAMESPACE_SEPARATOR);
  return separatorIndex > 0 && CONFIRMABLE_TOOLS_BY_SERVER.has(toolName.slice(0, separatorIndex));
}

const CONFIRM_NEXT_STEP = 'Click the Confirm or Cancel button below to proceed.';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function isEmittedByConfirmingServer(emittingTool: string, actionTool: string): boolean {
  const separatorIndex = emittingTool.indexOf(MCP_NAMESPACE_SEPARATOR);
  if (separatorIndex <= 0) return false;
  const server = emittingTool.slice(0, separatorIndex);
  const tool = emittingTool.slice(separatorIndex + MCP_NAMESPACE_SEPARATOR.length);
  return tool === actionTool && (CONFIRMABLE_TOOLS_BY_SERVER.get(server)?.has(tool) ?? false);
}

function decodePendingAction(token: unknown): McpPendingAction | null {
  if (typeof token !== 'string') return null;
  const decoded: unknown = JSON.parse(Buffer.from(token, 'base64').toString('utf-8'));
  if (!isRecord(decoded)) return null;
  const { tool, params, ts } = decoded;
  if (typeof tool !== 'string' || typeof ts !== 'number' || !isRecord(params)) return null;
  return { tool, params, ts };
}

const withoutToken = (parsed: Record<string, unknown>): string => {
  const { _confirmToken: _omitted, ...rest } = parsed;
  return JSON.stringify(rest, null, 2);
};

/**
 * @param emittingTool - the namespaced `server__tool` id that produced `result`
 * @param result - the raw tool result; only a JSON string carrying `_confirmToken` is touched
 * @returns `none` when there is no token; otherwise the result with the token stripped (it must
 *   never reach the model), plus the action when it was accepted
 */
export function extractMcpPendingAction(emittingTool: string, result: unknown): McpPendingActionExtraction {
  if (typeof result !== 'string' || !result.includes('_confirmToken')) return { kind: 'none' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    // Cannot strip what cannot be parsed, so nothing of the result may be returned.
    return {
      kind: 'rejected',
      reason: 'unparseable',
      result: JSON.stringify({ error: `Tool ${emittingTool} returned an unparseable result. Please try again.` }),
    };
  }
  if (!isRecord(parsed) || !('_confirmToken' in parsed)) return { kind: 'none' };

  let action: McpPendingAction | null;
  try {
    action = decodePendingAction(parsed._confirmToken);
  } catch {
    action = null;
  }
  if (!action) return { kind: 'rejected', reason: 'malformed', result: withoutToken(parsed) };

  if (!isEmittedByConfirmingServer(emittingTool, action.tool)) {
    return { kind: 'rejected', reason: 'untrusted-emitter', result: withoutToken(parsed) };
  }

  const forModel = 'next_step' in parsed ? { ...parsed, next_step: CONFIRM_NEXT_STEP } : parsed;
  return { kind: 'accepted', action, result: withoutToken(forModel) };
}
