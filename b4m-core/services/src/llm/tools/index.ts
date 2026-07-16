import { BaseStorage } from '@bike4mind/utils';
import { type ICompletionBackend, type ICompletionOptionTools } from '@bike4mind/llm-adapters';
import { Logger } from '@bike4mind/observability';
import { ToolContext, ToolDefinition } from './base/types';
export type { ToolContext, ToolDefinition } from './base/types';
import { diceRollTool } from './implementation/diceroll';
import { weatherTool } from './implementation/weather';
import { imageGenerationTool } from './implementation/imageGeneration';
import { webSearchTool } from './implementation/websearch';
import { webFetchTool } from './implementation/webfetch';
import { wolframAlphaTool } from './implementation/wolfram_alpha';
import { mathTool } from './implementation/math';
import { mermaidChartTool } from './implementation/mermaidChart';
import { currentDateTimeTool } from './implementation/currentDateTime';
import { deepResearchTool } from './implementation/deepResearch';
import {
  B4MLLMTools,
  PremiumOverlayToolName,
  IChatHistoryItemDocument,
  getMcpProviderMetadata,
} from '@bike4mind/common';
import { IChatCompletionServiceOptions } from '../ChatCompletionFeatures';
import { promptEnhancementTool } from './implementation/promptEnhancement';
import { rechartsTool } from './implementation/recharts';
import { editFileTool } from './implementation/editFile';
import { imageEditTool } from './implementation/imageEdit';
import { blogPublishTool } from './implementation/blogPublish';
import { blogEditTool } from './implementation/blogEdit';
import { blogDraftTool } from './implementation/blogDraft';
import { wikipediaOnThisDayTool } from './implementation/wikipediaOnThisDay';
import { moonPhaseTool } from './implementation/moonPhase';
import { sunriseSunsetTool } from './implementation/sunriseSunset';
import { issTrackerTool } from './implementation/issTracker';
import { planetVisibilityTool } from './implementation/planetVisibility';
import { knowledgeBaseSearchTool } from './implementation/knowledgeBaseSearch';
import { knowledgeBaseRetrieveTool } from './implementation/knowledgeBaseRetrieve';
import { navigateViewTool } from './implementation/navigateView';
import { jupyterNotebookTool } from './implementation/jupyterNotebook';
import { excelGenerationTool } from './implementation/excelGeneration';
import { fmpTool } from './implementation/fmp';
import { skillTool } from './implementation/skill';
import { chessEngineTool } from './implementation/chessEngine';
import { setShowUserQuestionFn } from './implementation/askUserQuestion';

export type LlmTools = B4MLLMTools;
export type CliLlmTools =
  | 'file_read'
  | 'create_file'
  | 'edit_local_file'
  | 'glob_files'
  | 'grep_search'
  | 'delete_file'
  | 'bash_execute'
  | 'check_shell_output'
  | 'write_shell_stdin'
  | 'list_background_shells'
  | 'kill_background_shell'
  | 'recent_changes'
  | 'lattice_create_model'
  | 'lattice_add_entity'
  | 'lattice_set_value'
  | 'lattice_create_rule'
  | 'lattice_query'
  | 'lattice_explain'
  | 'ask_user_question';
export type SlackLlmTools =
  | 'slackbot_help'
  | 'list_curated_files'
  | 'share_curated_file'
  | 'notebook_new'
  | 'notebook_status'
  | 'confirm_pending_action'
  | 'cancel_pending_action';
export { setShowUserQuestionFn };
export type {
  UserQuestionPayload,
  UserQuestionResponse,
  UserQuestion,
  QuestionOption,
  UserQuestionAnswer,
} from './implementation/askUserQuestion';

export type { Searcher, SearchResult, ContentExtractionResult } from './implementation/deepResearch';

/**
 * Canonical list of Lattice tool names. Lattice (financial pro-forma modeling)
 * is gated behind the `enableLattice` feature flag; when enabled, callers append
 * these to their `enabledTools` so the LLM can offload structured data into a
 * queryable model instead of carrying it in the context window.
 *
 * Names only - no implementations - so this stays web-safe. `tools/index` is
 * imported broadly by the Next app; the resolvable implementations live in the
 * CLI-isolated `cliTools` module (`latticeToolDefinitions`) to avoid dragging
 * Turbopack into the tool implementations (see `cliTools.ts` header).
 */
export const LATTICE_TOOL_NAMES = [
  'lattice_create_model',
  'lattice_add_entity',
  'lattice_set_value',
  'lattice_create_rule',
  'lattice_query',
  'lattice_explain',
] as const satisfies readonly CliLlmTools[];

export const b4mTools = {
  dice_roll: diceRollTool,
  weather_info: weatherTool,
  image_generation: imageGenerationTool,
  edit_image: imageEditTool,
  web_search: webSearchTool,
  web_fetch: webFetchTool,
  wolfram_alpha: wolframAlphaTool,
  math_evaluate: mathTool,
  mermaid_chart: mermaidChartTool,
  current_datetime: currentDateTimeTool,
  deep_research: deepResearchTool,
  prompt_enhancement: promptEnhancementTool,
  recharts: rechartsTool,
  edit_file: editFileTool,
  blog_publish: blogPublishTool,
  blog_edit: blogEditTool,
  blog_draft: blogDraftTool,
  // Time Machine & Night Sky tools
  wikipedia_on_this_day: wikipediaOnThisDayTool,
  moon_phase: moonPhaseTool,
  sunrise_sunset: sunriseSunsetTool,
  iss_tracker: issTrackerTool,
  planet_visibility: planetVisibilityTool,

  // Knowledge base tools
  search_knowledge_base: knowledgeBaseSearchTool,
  // Chess engine
  chess_engine: chessEngineTool,
  retrieve_knowledge_content: knowledgeBaseRetrieveTool,

  // Navigation tool
  navigate_view: navigateViewTool,

  // Jupyter notebook generation
  generate_jupyter_notebook: jupyterNotebookTool,

  // Excel generation
  excel_generation: excelGenerationTool,

  // Financial data
  fmp_financial_data: fmpTool,

  // User-defined skills (LLM-invokable instruction templates)
  skill: skillTool,
} satisfies {
  // PremiumOverlayToolName: implemented by premium overlay packages, supplied at
  // runtime via the externalTools merge - core intentionally has no entry for them.
  [
    key in Exclude<LlmTools, CliLlmTools | 'delegate_to_agent' | SlackLlmTools | PremiumOverlayToolName>
  ]: ToolDefinition;
};

export const generateTools = (
  userId: string,
  user: import('@bike4mind/common').IUserDocument,
  logger: Logger,
  { db, retrievalFilter }: { db: ToolContext['db']; retrievalFilter?: ToolContext['retrievalFilter'] },
  storage: BaseStorage,
  imageGenerateStorage: BaseStorage,
  statusUpdate: (q: Partial<IChatHistoryItemDocument>, status?: string) => Promise<void>,
  onStart: (toolName: string, data: any) => Promise<void>,
  onFinish: (toolName: string, data: any) => Promise<void>,
  llm: ICompletionBackend,
  config: { [key in LlmTools]?: any },
  model?: string,
  imageProcessorLambdaName?: string,
  tools: Record<string, ToolDefinition> = b4mTools,
  allowedDirectories?: string[],
  entitlementKeys: string[] = [],
  sessionId?: string,
  codeMinifier?: ToolContext['codeMinifier'],
  availableModels?: import('@bike4mind/common').ModelInfo[]
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
    codeMinifier,
    availableModels,
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
