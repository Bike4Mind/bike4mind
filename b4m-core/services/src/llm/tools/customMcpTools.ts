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

/** A tool as offered; `outputSchema` describes `structuredContent` when the host returns it. */
export type CustomMcpOfferedTool = IMcpConnectionTool & { outputSchema?: Record<string, unknown> };

/** One connection as the host reports it: enabled, connected and allowed by policy. */
export interface CustomMcpConnectionOffer extends CustomConnectorPendingRef {
  /** False when an org policy allows read-only tools only. */
  allowWriteTools: boolean;
  /** True when an org policy wants a human approval before every call, reads included. */
  requireApprovalForAll: boolean;
  tools: CustomMcpOfferedTool[];
}

export interface CustomMcpToolCallInput {
  connectionId: string;
  userId: string;
  toolName: string;
  args: Record<string, unknown>;
  approved: boolean;
  /** Platform connectors the user switched on, by id; a platform connector not named here is not found. */
  platformConnectionIds?: readonly string[];
  /** When the turn must end (epoch ms), for a turn shorter than the host's own wait; unset otherwise. */
  deadline?: number;
}

export interface CustomMcpListOptions {
  /**
   * Platform connectors the user switched on in the Tools menu, by id. A platform connector is off
   * for each user until they switch it on, so one not named here is not listed.
   */
  platformConnectionIds?: readonly string[];
  /** No one can answer an approval card in this turn (an API-key call), so hosts may leave out always-ask tools. */
  headless?: boolean;
  /** Enable MCP Server is off: a composed host lists only the hosts that set `listsWithoutMcpServer`. */
  mcpServerOff?: boolean;
}

export interface CustomMcpToolCallResult {
  content?: unknown[];
  isError?: boolean;
  /** A typed result; when present the model gets `{ output, stamp }` as JSON instead of the text blocks. */
  structuredContent?: Record<string, unknown>;
  /** Provenance for `structuredContent`, sent as `stamp`. */
  meta?: Record<string, unknown>;
  /** A short trust label carried on the untrusted wrapper. */
  label?: string;
}

export interface CustomMcpToolHost {
  listConnections(userId: string, options?: CustomMcpListOptions): Promise<CustomMcpConnectionOffer[]>;
  callTool(input: CustomMcpToolCallInput): Promise<{ result: CustomMcpToolCallResult }>;
  /** Set by a host that serves fixed connection ids, so a composed host can route its calls. */
  ownsConnection?(connectionId: string): boolean;
  /** Set by a host whose tools are offered whether or not Enable MCP Server is on (callable functions). */
  listsWithoutMcpServer?: boolean;
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
  /** The same switched-on platform connector ids the connections were listed with. */
  platformConnectionIds?: readonly string[];
  /** Passed to every call as `CustomMcpToolCallInput.deadline`. */
  deadline?: number;
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

/** The connections' offered tools, cut to `maxTools` in listing order; a `skip`ped connection takes no share. */
export async function loadCustomMcpConnections(
  host: CustomMcpToolHost,
  userId: string,
  logger: Pick<Logger, 'warn'>,
  maxTools = MAX_CUSTOM_TOOLS_PER_TURN,
  listOptions: CustomMcpListOptions = {},
  skip: (connection: CustomMcpConnectionOffer) => boolean = () => false
): Promise<CustomMcpConnectionOffer[]> {
  let remaining = maxTools;
  const kept: CustomMcpConnectionOffer[] = [];
  for (const connection of await host.listConnections(userId, listOptions)) {
    if (skip(connection)) continue;
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

const capResult = (text: string) =>
  text.length > MAX_RESULT_CHARS
    ? `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated: result exceeded ${MAX_RESULT_CHARS} characters]`
    : text;

function flattenContent(content: unknown[] | undefined): string {
  return capResult(
    (content ?? [])
      .map(block => {
        const entry = block as { type?: string; text?: unknown };
        return entry?.type === 'text' && typeof entry.text === 'string'
          ? entry.text
          : `[non-text content omitted: ${entry?.type ?? 'unknown'}]`;
      })
      .join('\n')
  );
}

/** What the model reads when a structured result does not fit: refused whole, never cut. */
export const CUSTOM_MCP_OUTPUT_TOO_LARGE_BODY = JSON.stringify({
  outcome: 'output_too_large',
  max_chars: MAX_RESULT_CHARS,
});

/**
 * The result as the model reads it, before the untrusted wrapper. A structured result is valid JSON with its
 * stamp whole, or `CUSTOM_MCP_OUTPUT_TOO_LARGE_BODY`; text blocks are cut at the same cap.
 */
export function customMcpResultBody(result: CustomMcpToolCallResult): string {
  if (!result.structuredContent) return flattenContent(result.content);
  // Escaping `<` keeps the JSON parseable, since a raw tag inside it would be rewritten by wrapUntrusted.
  const body = JSON.stringify({ output: result.structuredContent, stamp: result.meta ?? null }).replace(
    /</g,
    '\\u003c'
  );
  return body.length > MAX_RESULT_CHARS ? CUSTOM_MCP_OUTPUT_TOO_LARGE_BODY : body;
}

const attr = (value: string) => value.replace(/["<>\r\n]/g, '');

function wrapUntrusted(connection: CustomConnectorPendingRef, body: string, label?: string): string {
  // Both tags: a spoofed opening tag could claim another connector's provenance mid-body.
  const safe = body.replace(/<\s*(\/?)\s*untrusted_tool_result/gi, '<\\$1untrusted_tool_result');
  const labelAttr = label ? ` label="${attr(label)}"` : '';
  return `<untrusted_tool_result connector="${attr(connection.slug)}" host="${attr(connection.urlHost)}"${labelAttr}>\n${safe}\n</untrusted_tool_result>`;
}

/** A call's result as the model reads it, wrapped untrusted; also what a confirmed card's call is replayed as. */
export const customMcpResultText = (connection: CustomConnectorPendingRef, result: CustomMcpToolCallResult) =>
  wrapUntrusted(connection, customMcpResultBody(result), result.label);

/** The tool's reply while its card waits; the confirm route finds the stored call by this prefix. */
export const CUSTOM_MCP_AWAITING_APPROVAL_PREFIX = 'Awaiting your approval:';

/** Tool definitions for one connection's offered tools (see `loadCustomMcpConnections`). */
export function generateCustomMcpTools(
  connection: CustomMcpConnectionOffer,
  { userId, host, requestApproval, platformConnectionIds, deadline }: CustomMcpToolOptions
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
        _isCustomMcpTool: true,
        toolFn: async (rawArgs: unknown) => {
          const args = (stripServerOnlyArgs(rawArgs) ?? {}) as Record<string, unknown>;
          if (needsApproval && requestApproval) {
            await requestApproval({ ...ref, toolName: tool.name, args });
            return `${CUSTOM_MCP_AWAITING_APPROVAL_PREFIX} ${connection.displayName} ${tool.name} was not run. Tell the user to use the Confirm or Cancel button.`;
          }
          const { result } = await host.callTool({
            connectionId: connection.connectionId,
            userId,
            toolName: tool.name,
            args,
            approved: needsApproval,
            platformConnectionIds,
            ...(deadline === undefined ? {} : { deadline }),
          });
          return customMcpResultText(ref, result);
        },
        toolSchema: {
          name,
          description: tool.description,
          parameters: normalizeToolParameters({ inputSchema: tool.inputSchema }),
        },
      };
    });
}
