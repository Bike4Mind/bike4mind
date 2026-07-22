/**
 * Pure tool-generation helpers, deliberately free of any tool *implementation*
 * imports.
 *
 * `tools/index.ts` statically imports every b4m tool (image generation, excel
 * export, ...) to assemble the `b4mTools` map. Anything that imports a value
 * from `index.ts` therefore drags those implementations - and their heavy,
 * server-only npm deps (jimp, @aws-sdk/client-rekognition, write-excel-file) -
 * into its bundle. The CLI hit exactly this (see packages/cli/tsdown.config.ts's
 * externals guard and issue #660).
 *
 * These generators need none of that: they only operate on a tool map passed in
 * by the caller. Keeping them here lets CLI-safe entry points (tools/cliTools)
 * re-export them without pulling the full tool graph. `index.ts` re-exports them
 * so the server barrel's public API is unchanged.
 */
import { Logger } from '@bike4mind/observability';
import { getMcpProviderMetadata } from '@bike4mind/common';
import type { ICompletionBackend, ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { BaseStorage } from '@bike4mind/utils';
// LlmTools is the union of all tool names; sourced from common (not ./index) so
// this module has no edge back into the full tool graph it exists to avoid.
import type { B4MLLMTools as LlmTools, IChatHistoryItemDocument } from '@bike4mind/common';
import type { ToolContext, ToolDefinition } from './base/types';
import type { IChatCompletionServiceOptions } from '../ChatCompletionFeatures';

export const generateTools = (
  userId: string,
  user: import('@bike4mind/common').IUserDocument,
  logger: Logger,
  // retrievalFilter rides in this object arg rather than as a new positional (like
  // entitlementKeys below) on purpose: this function already takes 18 positionals across 4
  // call sites, and adding a 19th is the fragile pattern the deps-object avoids. New optional
  // inputs should keep going here.
  {
    db,
    retrievalFilter,
    kbScope,
  }: { db: ToolContext['db']; retrievalFilter?: ToolContext['retrievalFilter']; kbScope?: ToolContext['kbScope'] },
  storage: BaseStorage,
  imageGenerateStorage: BaseStorage,
  statusUpdate: (q: Partial<IChatHistoryItemDocument>, status?: string) => Promise<void>,
  onStart: (toolName: string, data: any) => Promise<void>,
  onFinish: (toolName: string, data: any) => Promise<void>,
  llm: ICompletionBackend,
  config: { [key in LlmTools]?: any },
  model: string | undefined,
  imageProcessorLambdaName: string | undefined,
  // `tools` is required (no default): the previous `= b4mTools` default silently
  // pulled the entire tool graph into any bundle that imported this module. Callers
  // pass their tool map explicitly - server paths pass `b4mTools`, the CLI passes
  // its narrow subset.
  tools: Record<string, ToolDefinition>,
  allowedDirectories?: string[],
  entitlementKeys: string[] = [],
  sessionId?: string,
  codeMinifier?: ToolContext['codeMinifier'],
  availableModels?: import('@bike4mind/common').ModelInfo[],
  onToolLlmUsage?: ToolContext['onToolLlmUsage']
): Record<string, ICompletionOptionTools> => {
  const context: ToolContext = {
    userId,
    user,
    sessionId,
    logger,
    db,
    storage,
    imageGenerateStorage,
    statusUpdate,
    onStart,
    onFinish,
    llm,
    model,
    imageProcessorLambdaName,
    allowedDirectories,
    entitlementKeys,
    retrievalFilter,
    kbScope,
    codeMinifier,
    availableModels,
    onToolLlmUsage,
  };

  return Object.entries(tools).reduce(
    (acc, [key, tool]) => ({
      ...acc,
      [key]: tool.implementation(context, config[key as LlmTools]),
    }),
    {} as Record<LlmTools, ICompletionOptionTools>
  );
};

/**
 * Normalize MCP tool parameters for OpenAI compatibility.
 * OpenAI requires 'properties' on object schemas - MCP tools like current_user
 * return { type: 'object' } without it, causing 400 errors.
 */
function normalizeToolParameters(rest: Record<string, unknown>): ICompletionOptionTools['toolSchema']['parameters'] {
  const rawParameters = rest?.input_schema ?? rest?.inputSchema ?? rest?.parameters;
  if (rawParameters && typeof rawParameters === 'object') {
    return {
      ...rawParameters,
      properties: (rawParameters as Record<string, unknown>).properties ?? {},
    } as ICompletionOptionTools['toolSchema']['parameters'];
  }
  return {
    type: 'object',
    properties: {},
    additionalProperties: true,
  };
}

const ATLASSIAN_RECONNECT_MESSAGE =
  '⚠️ Your Atlassian connection has expired.\n\nPlease reconnect your Atlassian account in Settings > Connected Apps to continue using Confluence and Jira tools.';

/**
 * Recursively ensure every `{ type: "object" }` node in a JSON Schema has a
 * `properties` field. OpenAI rejects object schemas without `properties`,
 * while MCP servers (e.g., GitHub `current_user`) may omit it for tools that
 * take no parameters.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- TODO: Integrate this into normalizeToolParameters or remove if unnecessary
function ensureObjectProperties(schema: Record<string, unknown>): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return schema;

  const result = { ...schema };

  if (result.type === 'object' && !result.properties) {
    result.properties = {};
  }

  if (result.properties && typeof result.properties === 'object') {
    const props = result.properties as Record<string, Record<string, unknown>>;
    result.properties = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, ensureObjectProperties(v)]));
  }
  if (result.items && typeof result.items === 'object') {
    result.items = ensureObjectProperties(result.items as Record<string, unknown>);
  }
  if (result.additionalProperties && typeof result.additionalProperties === 'object') {
    result.additionalProperties = ensureObjectProperties(result.additionalProperties as Record<string, unknown>);
  }

  return result;
}

export const generateMcpTools = async (
  mcpData: Awaited<ReturnType<IChatCompletionServiceOptions['getMcpClient']>>
): Promise<Array<{ name: string } & ICompletionOptionTools>> => {
  let tools;
  try {
    tools = await mcpData.getTools();
  } catch (error) {
    const errorName = error instanceof Error ? error.name : '';
    if (errorName === 'AtlassianReconnectRequiredError') {
      Logger.globalInstance.warn(`Atlassian reconnection required during getTools for ${mcpData.serverName}`);
      // Return empty array - the real-time subscription will show toast to user
      return [];
    }
    throw error;
  }
  const toolList = Array.isArray(tools) ? tools : (tools as any)?.tools || [];

  if (!Array.isArray(tools)) {
    Logger.globalInstance.warn(
      `MCP server ${mcpData.serverName} returned unexpected tools payload:`,
      JSON.stringify(tools)
    );
  }
  if (!Array.isArray(toolList)) {
    throw new Error(`Expected getTools() to return an array, but got ${typeof tools}`);
  }

  const result = toolList.map((item: any) => {
    const { name: originalToolName, ...rest } = item;
    const serverName = (mcpData.serverName || '').toLowerCase();

    // Add namespace prefix to avoid tool name conflicts between MCP servers
    // Format: serverName__toolName (e.g., "github__create_issue", "context7__query_docs")
    const namespacedToolName = `${serverName}__${originalToolName}`;

    const providerMetadata = getMcpProviderMetadata(serverName);
    const fallbackDescription = providerMetadata?.defaultToolDescriptions?.[originalToolName] ?? '';
    const parameters = normalizeToolParameters(rest as Record<string, unknown>);
    const optionTools: ICompletionOptionTools = {
      toolFn: async (args: any) => {
        // Use original tool name when calling the MCP server
        Logger.debug(`Calling ${originalToolName} tool via ${mcpData.serverName}`, args);
        try {
          const toolResult = await mcpData.callTool(originalToolName, args);
          const contentBlocks = (toolResult as any)?.content;
          if (Array.isArray(contentBlocks) && contentBlocks.length > 0) {
            const normalized = contentBlocks
              .map((entry: any) => {
                if (entry && typeof entry === 'object' && 'text' in entry) {
                  return entry.text;
                }
                return JSON.stringify(entry);
              })
              .join('\n');
            Logger.debug(`[Tool Result] ${originalToolName}:`, normalized);
            return normalized;
          }

          const serialized = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);
          Logger.debug(`[Tool Result] Unexpected format for ${originalToolName}, returning serialized output`);
          return serialized;
        } catch (error) {
          // Handle Atlassian token expiration
          const serverName = mcpData.serverName?.toLowerCase();
          if (serverName === 'atlassian') {
            const errorName = error instanceof Error ? error.name : '';
            const errorMessage = error instanceof Error ? error.message : String(error);
            const isTokenError =
              errorName === 'AtlassianReconnectRequiredError' ||
              errorMessage.includes('401') ||
              errorMessage.includes('403') ||
              errorMessage.includes('unauthorized') ||
              errorMessage.includes('expired');

            if (isTokenError) {
              Logger.globalInstance.warn(
                `Atlassian token may be expired for tool ${originalToolName}, error:`,
                errorMessage
              );
              return ATLASSIAN_RECONNECT_MESSAGE;
            }
          }

          throw error;
        }
      },
      toolSchema: {
        name: namespacedToolName, // Use namespaced name in tool schema for Claude API
        description: rest.description || fallbackDescription,
        parameters,
      },
    };
    return {
      name: namespacedToolName, // Use namespaced name for external identification
      ...optionTools,
      _isMcpTool: true, // Mark as MCP tool to enable tool chaining
    };
  }, {});

  Logger.debug(`🔧 generateMcpTools: Generated ${result.length} tool implementations for ${mcpData.serverName}`);
  return result;
};

/**
 * Build MCP tool definitions from cached schemas without connecting to the MCP server.
 * The callTool function is invoked lazily only when the LLM actually calls a tool.
 */
export const generateMcpToolsFromCache = (
  serverName: string,
  cachedTools: Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>,
  callTool: (toolName: string, toolArgs: unknown) => Promise<unknown>
): Array<{ name: string } & ICompletionOptionTools> => {
  const normalizedServerName = serverName.toLowerCase();

  const result = cachedTools.map(item => {
    const { name: originalToolName, ...rest } = item;
    const namespacedToolName = `${normalizedServerName}__${originalToolName}`;

    const providerMetadata = getMcpProviderMetadata(normalizedServerName);
    const fallbackDescription = providerMetadata?.defaultToolDescriptions?.[originalToolName] ?? '';
    const parameters = normalizeToolParameters(rest as Record<string, unknown>);
    const optionTools: ICompletionOptionTools = {
      toolFn: async (args: unknown) => {
        Logger.debug(`Calling ${originalToolName} tool via ${serverName}`, args);
        try {
          const toolResult = await callTool(originalToolName, args);
          const contentBlocks = (toolResult as Record<string, unknown>)?.content;
          if (Array.isArray(contentBlocks) && contentBlocks.length > 0) {
            const normalized = contentBlocks
              .map((entry: unknown) => {
                if (entry && typeof entry === 'object' && 'text' in (entry as Record<string, unknown>)) {
                  return (entry as Record<string, string>).text;
                }
                return JSON.stringify(entry);
              })
              .join('\n');
            Logger.debug(`[Tool Result] ${originalToolName}:`, normalized);
            return normalized;
          }

          const serialized = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);
          Logger.debug(`[Tool Result] Unexpected format for ${originalToolName}, returning serialized output`);
          return serialized;
        } catch (error) {
          // Handle Atlassian token expiration
          if (normalizedServerName === 'atlassian') {
            const errorName = error instanceof Error ? error.name : '';
            const errorMessage = error instanceof Error ? error.message : String(error);
            const isTokenError =
              errorName === 'AtlassianReconnectRequiredError' ||
              errorMessage.includes('401') ||
              errorMessage.includes('403') ||
              errorMessage.includes('unauthorized') ||
              errorMessage.includes('expired');

            if (isTokenError) {
              Logger.globalInstance.warn(
                `Atlassian token may be expired for tool ${originalToolName}, error:`,
                errorMessage
              );
              return ATLASSIAN_RECONNECT_MESSAGE;
            }
          }

          throw error;
        }
      },
      toolSchema: {
        name: namespacedToolName,
        description: rest.description || fallbackDescription,
        parameters,
      },
    };
    return {
      name: namespacedToolName,
      ...optionTools,
      _isMcpTool: true,
    };
  });

  Logger.debug(
    `🔧 generateMcpToolsFromCache: Generated ${result.length} tool implementations for ${serverName} (from cache)`
  );
  return result;
};
