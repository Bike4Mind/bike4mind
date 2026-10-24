/**
 * Offers a user's custom-connector tools to a model as namespaced `<slug>__<tool>` tools.
 *
 * Shared by the chat builder and the agent loader so approval, namespacing and result wrapping
 * cannot drift between surfaces. The app tier supplies the host (`CustomMcpToolHost`); the host's
 * call path owns policy, rate limits and audit, so this file never imports app-tier code.
 */

import { createHash } from 'crypto';
import type { Logger } from '@bike4mind/observability';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import {
  isReadOnlyMcpConnectionTool,
  requiresMcpConnectionToolApproval,
  type CustomConnectorPendingRef,
  type IMcpConnectionTool,
} from '@bike4mind/common';
import { normalizeToolParameters, stripServerOnlyArgs } from './toolGenerators';

const MAX_TOOL_ID_LENGTH = 64;
const MAX_RESULT_CHARS = 30_000;
export const MAX_CUSTOM_TOOLS_PER_TURN = 40;

/** One connection as the host reports it: enabled, connected and allowed by policy. */
export interface CustomMcpConnectionOffer extends CustomConnectorPendingRef {
  /** False when an org policy allows read-only tools only. */
  allowWriteTools: boolean;
  /** True when an org policy wants a human approval before every call, reads included. */
  requireApprovalForAll: boolean;
  tools: IMcpConnectionTool[];
}

export interface CustomMcpToolCallInput {
  connectionId: string;
  userId: string;
  toolName: string;
  args: Record<string, unknown>;
  approved: boolean;
}

export interface CustomMcpToolHost {
  listConnections(userId: string): Promise<CustomMcpConnectionOffer[]>;
  callTool(input: CustomMcpToolCallInput): Promise<{ result: { content?: unknown[]; isError?: boolean } }>;
}

export interface CustomMcpApprovalRequest extends CustomConnectorPendingRef {
  toolName: string;
  args: Record<string, unknown>;
}

export interface CustomMcpToolOptions {
  userId: string;
  host: CustomMcpToolHost;
  /**
   * Chat: records the call for a human to confirm and the call is not made. Omitted for agent runs,
   * whose permission gate has already authorized any call that reaches the tool.
   */
  requestApproval?: (request: CustomMcpApprovalRequest) => Promise<void>;
}

export { CUSTOM_MCP_DATA_NOTICE } from '@bike4mind/common';

/** Same predicate the call path uses: no hint at all is a write. */
export const isReadOnlyCustomTool = isReadOnlyMcpConnectionTool;

/** Whether a connection currently offers this tool to a model: reviewed, enabled and allowed by policy. */
export const isCustomToolOffered = (tool: IMcpConnectionTool, connection: CustomMcpConnectionOffer) =>
  tool.enabled && tool.state === 'active' && (connection.allowWriteTools || isReadOnlyCustomTool(tool));

/** `<slug>__<tool>`, with the tool part hashed down when the id would pass the provider's 64-char limit. */
export function customMcpToolId(slug: string, toolName: string): string {
  const id = `${slug}__${toolName}`;
  if (id.length <= MAX_TOOL_ID_LENGTH) return id;
  const hash = createHash('sha256').update(toolName).digest('hex').slice(0, 6);
  return `${slug}__${toolName.slice(0, MAX_TOOL_ID_LENGTH - slug.length - 2 - 7)}_${hash}`;
}

/** The connections' offered tools, cut to `maxTools` in listing order. */
export async function loadCustomMcpConnections(
  host: CustomMcpToolHost,
  userId: string,
  logger: Pick<Logger, 'warn'>,
  maxTools = MAX_CUSTOM_TOOLS_PER_TURN
): Promise<CustomMcpConnectionOffer[]> {
  let remaining = maxTools;
  const kept: CustomMcpConnectionOffer[] = [];
  for (const connection of await host.listConnections(userId)) {
    const tools = connection.tools.filter(tool => isCustomToolOffered(tool, connection));
    if (tools.length > remaining) {
      logger.warn(`[MCP] Custom tool cap of ${maxTools} reached; dropping tools from ${connection.slug}`);
    }
    const offered = tools.slice(0, remaining);
    remaining -= offered.length;
    if (offered.length > 0) kept.push({ ...connection, tools: offered });
  }
  return kept;
}

function flattenContent(content: unknown[] | undefined): string {
  const text = (content ?? [])
    .map(block => {
      const entry = block as { type?: string; text?: unknown };
      return entry?.type === 'text' && typeof entry.text === 'string'
        ? entry.text
        : `[non-text content omitted: ${entry?.type ?? 'unknown'}]`;
    })
    .join('\n');
  return text.length > MAX_RESULT_CHARS
    ? `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated: result exceeded ${MAX_RESULT_CHARS} characters]`
    : text;
}

const attr = (value: string) => value.replace(/["<>\r\n]/g, '');

function wrapUntrusted(connection: CustomConnectorPendingRef, body: string): string {
  // Both tags: a spoofed opening tag could claim another connector's provenance mid-body.
  const safe = body.replace(/<(\/?)untrusted_tool_result/gi, '<\\$1untrusted_tool_result');
  return `<untrusted_tool_result connector="${attr(connection.slug)}" host="${attr(connection.urlHost)}">\n${safe}\n</untrusted_tool_result>`;
}

/** Tool definitions for one connection's offered tools (see `loadCustomMcpConnections`). */
export function generateCustomMcpTools(
  connection: CustomMcpConnectionOffer,
  { userId, host, requestApproval }: CustomMcpToolOptions
): Array<{ name: string } & ICompletionOptionTools> {
  const ref: CustomConnectorPendingRef = {
    connectionId: connection.connectionId,
    slug: connection.slug,
    displayName: connection.displayName,
    urlHost: connection.urlHost,
  };
  return connection.tools
    .filter(tool => isCustomToolOffered(tool, connection))
    .map(tool => {
      const name = customMcpToolId(connection.slug, tool.name);
      const needsApproval = requiresMcpConnectionToolApproval(tool, connection.requireApprovalForAll);
      return {
        name,
        _isMcpTool: true,
        toolFn: async (rawArgs: unknown) => {
          const args = (stripServerOnlyArgs(rawArgs) ?? {}) as Record<string, unknown>;
          if (needsApproval && requestApproval) {
            await requestApproval({ ...ref, toolName: tool.name, args });
            return `Awaiting your approval: ${connection.displayName} ${tool.name} was not run. Tell the user to use the Confirm or Cancel button.`;
          }
          const { result } = await host.callTool({
            connectionId: connection.connectionId,
            userId,
            toolName: tool.name,
            args,
            approved: needsApproval,
          });
          return wrapUntrusted(ref, flattenContent(result.content));
        },
        toolSchema: {
          name,
          description: tool.description,
          parameters: normalizeToolParameters({ inputSchema: tool.inputSchema }),
        },
      };
    });
}
