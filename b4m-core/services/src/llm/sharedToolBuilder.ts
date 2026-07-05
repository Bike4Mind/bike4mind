/**
 * Shared Tool Builder
 *
 * Extracted from ChatCompletionProcess.buildTools() to enable both
 * ChatCompletionProcess and the Agent Executor Lambda to build tools
 * using the same pipeline.
 */

import type { IChatHistoryItemDocument, ModelInfo } from '@bike4mind/common';
import { type BaseStorage } from '@bike4mind/utils';
import {
  type ApiKeyTable,
  type ICompletionBackend,
  type ICompletionOptionTools,
  getLlmByModel,
} from '@bike4mind/llm-adapters';
import type { Logger } from '@bike4mind/observability';
import type { ServerAgentStore } from './agents/ServerAgentStore';
import type { ServerSubagentTracker, SubagentHandoffSignal } from './agents/ServerSubagentOrchestrator';
import { b4mTools, generateTools, type LlmTools } from './tools/index';
import type { ToolContext } from './tools/base/types';
import type { ToolDefinition } from './tools/base/types';
import { createDelegateToAgentTool } from './tools/implementation/delegateToAgent';
import { createCoordinateTaskTool } from './tools/implementation/coordinateTask';
import type { DagDispatcher, DagHandoffSignal } from './tools/implementation/coordinateTask';
import { extractAndSaveEntitiesFromToolResult, shouldExtractEntitiesFromTool } from '../conversationContextService';
import type { MinimalSessionRepository } from '../conversationContextService/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies needed to build tools (provided by the caller's runtime context) */
export interface ToolBuilderDeps {
  userId: string;
  user: ToolContext['user'];
  logger: Logger;
  db: ToolContext['db'];
  /** Caller's resolved entitlement keys, forwarded to the tool context (see ToolContext). */
  entitlementKeys?: string[];
  storage: BaseStorage;
  imageGenerateStorage: BaseStorage;
  imageProcessorLambdaName?: string;
  llm: ICompletionBackend;
  model?: string;
  precomputed?: {
    adminSettingsEnforceCredits: boolean;
    models: ModelInfo[];
  };
  apiKeyTable?: ApiKeyTable;
  thinking?: { enabled: boolean; budget_tokens: number };
  agentStore?: ServerAgentStore;
  /** Session repository for entity extraction (optional - skipped if not provided) */
  sessionRepository?: MinimalSessionRepository;
  /**
   * Returns the host Lambda's remaining wall-clock in milliseconds. Forwarded to the
   * subagent orchestrator so it can decide whether to run subagents in-process or
   * dispatch them to their own Lambda. Omit for non-Lambda callers.
   */
  getRemainingTimeMs?: () => number;
  /**
   * Mutable side-channel ref the subagent orchestrator populates when the parent
   * runs out of time mid-poll on a Lambda-dispatched child. The caller (Agent
   * Executor) reads this AFTER `runIteration()` returns and persists
   * `awaiting_subagent` state if set.
   */
  handoffSignal?: SubagentHandoffSignal;

  // --- Phase 4a - DAG decomposition (coordinate_task) ---

  /**
   * Mutable side-channel ref the `coordinate_task` tool populates when it has
   * dispatched a DAG of children and the parent should transition to
   * `awaiting_dag_children`. Mirrors `handoffSignal` shape.
   */
  dagHandoffSignal?: DagHandoffSignal;

  /**
   * Materialises + dispatches DAG children for `coordinate_task`. When omitted,
   * the `coordinate_task` tool is not registered (graceful no-op for callers
   * like ChatCompletionProcess that don't run a full execution lifecycle).
   */
  dagDispatcher?: DagDispatcher;

  /** Delegation depth of the caller. Forwarded to delegate_to_agent so the
   * dispatched-Lambda path enforces MAX_SUBAGENT_DEPTH at the correct level. */
  depth?: number;

  /**
   * Returns the current top-level execution id (used by `coordinate_task` to
   * persist DAG children with `parentExecutionId`). Required when
   * `dagDispatcher` is provided.
   */
  getCurrentExecutionId?: () => string;
}

/**
 * Callbacks that let the caller handle side effects produced during tool execution.
 *
 * Each callback is optional - omit it to skip that side effect.
 * ChatCompletionProcess provides callbacks that mutate the quest document;
 * the Agent Executor provides callbacks that track state in AgentExecutionDoc.
 */
export interface ToolBuilderCallbacks {
  /** Called when `generateTools()` needs to push a status update */
  onStatusUpdate: (changes: Partial<IChatHistoryItemDocument>, status?: string) => Promise<void>;

  /** Called before a tool executes (e.g., credit validation for image tools) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onToolStart: (toolName: string, data: any) => Promise<void>;

  /** Called after a tool finishes (e.g., deep research state, image paths) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onToolFinish: (toolName: string, data: any) => Promise<void>;

  /** Called when navigate_view extracts navigation intents */
  onNavigationIntents?: (intents: unknown[]) => Promise<void>;

  /** Called when a tool emits a __uiSideEffect sentinel */
  onUiSideEffect?: (sideEffect: { type: string; payload: unknown }) => Promise<void>;

  /** Called when an artifact is extracted from a tool result */
  onArtifactExtracted?: (artifact: {
    type: string;
    content: string;
    metadata: Record<string, unknown>;
    timestamp: Date;
  }) => void;

  /** Called when an MCP tool emits a _confirmToken (decoded pendingAction) */
  onPendingAction?: (action: { tool: string; params: Record<string, unknown>; ts: number }) => Promise<void>;

  /** Called when an MCP tool emits _attachmentList */
  onAttachmentList?: (attachmentList: {
    source: string;
    issueKey?: string;
    pageId?: string;
    pageTitle?: string;
    attachments: Array<{
      id: string;
      filename: string;
      emoji: string;
      sizeFormatted: string;
      mimeType?: string;
      author?: string;
      created?: string;
    }>;
  }) => Promise<string | undefined>;

  /** Session ID for entity extraction from tool results */
  sessionId?: string;

  /** Called when delegate_to_agent accumulates credits */
  onSubagentCredits?: (credits: number) => void;

  /** Called when a subagent completes with telemetry */
  onSubagentTelemetry?: (telemetry: unknown) => void;

  /** Called to stream subagent progress */
  onSubagentStatusUpdate?: (status: string) => Promise<void>;

  /**
   * Optional tracker for persisting subagent execution lifecycle (Phase 2).
   * The Agent Executor passes this so each `delegate_to_agent` call records a
   * child AgentExecutionDoc; ChatCompletionProcess leaves it undefined.
   */
  subagentTracker?: ServerSubagentTracker;
}

/** Options passed to buildSharedTools */
export interface BuildSharedToolsOptions {
  enabledTools?: string[];
  mcpToolsByServer?: Record<string, Array<{ name: string } & ICompletionOptionTools>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config?: { [key in LlmTools]?: any };
  agentOnlyMcpServers?: string[];
  getAbortSignal?: () => AbortSignal | undefined;
  externalTools?: Record<string, ToolDefinition>;
}

// Sentinel types for wrapping
const VALID_SIDE_EFFECT_TYPES = new Set(['populateProblem', 'populateFamilyProblem']);
const TOOL_ARTIFACT_RE = /<artifact\s+([^>]*)>([\s\S]*?)<\/artifact>/gi;
const TOOL_ATTR_RE = /(\w+)=["']([^"']*?)["']/g;

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Build tools using the shared pipeline.
 *
 * This is the extracted core of ChatCompletionProcess.buildTools().
 * Both ChatCompletionProcess and Agent Executor delegate to this function,
 * providing their own callbacks for side-effect handling.
 */
export function buildSharedTools(
  deps: ToolBuilderDeps,
  callbacks: ToolBuilderCallbacks,
  options: BuildSharedToolsOptions = {}
): ICompletionOptionTools[] | undefined {
  const {
    enabledTools = [],
    mcpToolsByServer = {},
    config = {},
    agentOnlyMcpServers = [],
    getAbortSignal,
    externalTools,
  } = options;

  const {
    userId,
    user,
    logger,
    db,
    storage,
    imageGenerateStorage,
    llm,
    model,
    imageProcessorLambdaName,
    entitlementKeys,
  } = deps;

  // Merge built-in tools with any external tool definitions (e.g., Slack tools)
  const allToolDefinitions = externalTools ? { ...b4mTools, ...externalTools } : b4mTools;

  const llmToolDefinitions = generateTools(
    userId,
    user,
    logger,
    { db },
    storage,
    imageGenerateStorage,
    callbacks.onStatusUpdate,
    callbacks.onToolStart,
    callbacks.onToolFinish,
    llm,
    {
      deep_research: config.deep_research,
      image_generation: config.image_generation,
      edit_image: config.image_generation,
    },
    model,
    imageProcessorLambdaName,
    allToolDefinitions,
    undefined, // allowedDirectories - not used in this path
    entitlementKeys ?? [],
    callbacks.sessionId
  );

  // Filter to enabled tools only
  let tools: ICompletionOptionTools[] | undefined = undefined;
  if (enabledTools.length > 0) {
    const mappedTools = enabledTools.filter(tool => tool in llmToolDefinitions).map(tool => llmToolDefinitions[tool]);

    const undefinedTools = enabledTools.filter(tool => !llmToolDefinitions[tool]);
    if (undefinedTools.length > 0) {
      logger.warn(`Undefined tools requested (will be skipped): ${undefinedTools.join(', ')}`);
    }

    tools = mappedTools.filter((tool): tool is ICompletionOptionTools => tool !== undefined);

    // Wrap navigate_view for navigation intent extraction
    if (enabledTools.includes('navigate_view') && tools && callbacks.onNavigationIntents) {
      wrapNavigateViewTool(tools, logger, callbacks.onNavigationIntents);
    }

    // Wrap all tools for sentinel extraction
    if (tools) {
      wrapToolsForSentinels(tools, logger, callbacks);
    }
  }

  // Merge MCP tools
  const allMcpTools = Object.values(mcpToolsByServer).flat();
  logger.debug('[MCP] Merging MCP tools:', {
    mcpToolsCount: allMcpTools.length,
    mcpToolNames: allMcpTools.map(t => t.name),
    enabledToolsCount: enabledTools.length,
  });

  const agentOnlyMcpTools: ICompletionOptionTools[] = [];

  for (const [serverName, serverTools] of Object.entries(mcpToolsByServer)) {
    const isAgentOnly = agentOnlyMcpServers.includes(serverName);

    for (const item of serverTools) {
      const { name, toolFn: originalToolFn, ...rest } = item;
      tools ??= [];

      const wrappedToolFn = createMcpToolWrapper(name, originalToolFn, logger, callbacks, deps);

      if (isAgentOnly) {
        agentOnlyMcpTools.push({ ...rest, toolFn: wrappedToolFn });
      } else {
        tools.push({ ...rest, toolFn: wrappedToolFn });
      }
    }
  }

  if (agentOnlyMcpTools.length > 0) {
    logger.info(`[MCP] ${agentOnlyMcpTools.length} agent-only MCP tools withheld from main LLM`);
  }

  // Inject delegate_to_agent tool - only when an agentStore is available.
  // The Agent Executor (Phase 1) does not yet wire one up, in which case the
  // resulting tool list simply omits subagent delegation.
  tools ??= [];
  if (!deps.agentStore) {
    return tools;
  }

  const parentTools = [...tools, ...agentOnlyMcpTools];

  const subagentModelInfo = deps.precomputed?.models.find(m => m.id === model);
  const subagentLlm = getLlmByModel(deps.apiKeyTable!, {
    modelInfo: subagentModelInfo,
    logger,
    endUserId: deps.userId,
  });
  if (!subagentLlm) {
    throw new Error(`Failed to create subagent LLM backend for model "${model}"`);
  }
  subagentLlm.currentModel = model!;

  const delegateTool = createDelegateToAgentTool({
    userId,
    llm: subagentLlm,
    logger,
    parentTools,
    getSignal: getAbortSignal,
    onCredits: callbacks.onSubagentCredits ? (credits: number) => callbacks.onSubagentCredits!(credits) : undefined,
    availableModels: deps.precomputed?.models,
    onStatusUpdate: callbacks.onSubagentStatusUpdate
      ? async (status: string) => callbacks.onSubagentStatusUpdate!(status)
      : undefined,
    onTelemetry: callbacks.onSubagentTelemetry
      ? (telemetry: unknown) => callbacks.onSubagentTelemetry!(telemetry)
      : undefined,
    thinking: deps.thinking,
    agentStore: deps.agentStore,
    apiKeyTable: deps.apiKeyTable ?? undefined,
    tracker: callbacks.subagentTracker,
    getRemainingTimeMs: deps.getRemainingTimeMs,
    handoffSignal: deps.handoffSignal,
    depth: deps.depth,
  });
  tools.push(delegateTool);

  // Inject coordinate_task tool - only when a DagDispatcher is wired up
  // (the Agent Executor provides it; ChatCompletionProcess does not). The
  // coordinator agent itself must also be present in the store.
  if (deps.dagDispatcher && deps.getCurrentExecutionId && deps.agentStore.hasAgent('coordinator')) {
    const coordinateTool = createCoordinateTaskTool({
      userId,
      llm: subagentLlm,
      logger,
      parentTools,
      getSignal: getAbortSignal,
      availableModels: deps.precomputed?.models,
      onStatusUpdate: callbacks.onSubagentStatusUpdate
        ? async (status: string) => callbacks.onSubagentStatusUpdate!(status)
        : undefined,
      thinking: deps.thinking,
      agentStore: deps.agentStore,
      apiKeyTable: deps.apiKeyTable ?? undefined,
      tracker: callbacks.subagentTracker,
      getRemainingTimeMs: deps.getRemainingTimeMs,
      subagentHandoffSignal: deps.handoffSignal,
      dagDispatcher: deps.dagDispatcher,
      getParentExecutionId: deps.getCurrentExecutionId,
      dagHandoffSignal: deps.dagHandoffSignal,
    });
    tools.push(coordinateTool);
  }

  return tools;
}

// ---------------------------------------------------------------------------
// Wrapping utilities
// ---------------------------------------------------------------------------

function wrapNavigateViewTool(
  tools: ICompletionOptionTools[],
  logger: Logger,
  onNavigationIntents: (intents: unknown[]) => Promise<void>
): void {
  const navToolIdx = tools.findIndex(t => t.toolSchema?.name === 'navigate_view');
  if (navToolIdx === -1) return;

  const originalNavToolFn = tools[navToolIdx].toolFn;
  tools[navToolIdx] = {
    ...tools[navToolIdx],
    toolFn: async (args: unknown) => {
      const result = await originalNavToolFn(args);
      try {
        if (typeof result === 'string' && result.includes('__navigationIntents')) {
          const parsed = JSON.parse(result);
          if (parsed.__navigationIntents && Array.isArray(parsed.intents)) {
            logger.debug(
              '[navigate_view] Extracted navigation intents:',
              parsed.intents.map((i: { viewId: string }) => i.viewId)
            );
            await onNavigationIntents(parsed.intents);
            return parsed.message || 'Navigation suggestions provided.';
          }
        }
      } catch {
        // Not JSON - return as-is
      }
      return result;
    },
  };
}

function wrapToolsForSentinels(tools: ICompletionOptionTools[], logger: Logger, callbacks: ToolBuilderCallbacks): void {
  for (let i = 0; i < tools.length; i++) {
    const originalToolFn = tools[i].toolFn;
    const toolName = tools[i].toolSchema?.name || `tool-${i}`;
    tools[i] = {
      ...tools[i],
      toolFn: async (args: unknown) => {
        const result = await originalToolFn(args);

        // Extract __uiSideEffect sentinel
        if (callbacks.onUiSideEffect) {
          try {
            if (typeof result === 'string' && result.includes('__uiSideEffect')) {
              const parsed = JSON.parse(result);
              if (
                parsed.__uiSideEffect === true &&
                typeof parsed.type === 'string' &&
                VALID_SIDE_EFFECT_TYPES.has(parsed.type) &&
                parsed.payload != null &&
                typeof parsed.payload === 'object'
              ) {
                logger.debug(`[uiSideEffect] Extracted side-effect type=${parsed.type} from tool`);
                await callbacks.onUiSideEffect({ type: parsed.type, payload: parsed.payload });
                return parsed.displayMessage || `UI side-effect (${parsed.type}) dispatched.`;
              } else if (parsed.__uiSideEffect === true) {
                logger.warn(`[uiSideEffect] Unknown or malformed side-effect type=${parsed.type}, skipping`);
              }
            }
          } catch {
            // Not JSON or doesn't contain sentinel - pass through
          }
        }

        // Extract artifacts from tool results
        if (callbacks.onArtifactExtracted && typeof result === 'string' && result.includes('<artifact')) {
          try {
            TOOL_ARTIFACT_RE.lastIndex = 0;
            let artifactMatch;
            while ((artifactMatch = TOOL_ARTIFACT_RE.exec(result)) !== null) {
              const [, attrsStr, content] = artifactMatch;
              const attrs: Record<string, string> = {};
              let attrMatch;
              TOOL_ATTR_RE.lastIndex = 0;
              while ((attrMatch = TOOL_ATTR_RE.exec(attrsStr)) !== null) {
                attrs[attrMatch[1]] = attrMatch[2];
              }

              let metadata: Record<string, unknown> = {
                artifactType: attrs.type,
                identifier: attrs.identifier,
                title: attrs.title,
                toolName,
                source: 'tool_result',
              };
              try {
                const parsed = JSON.parse(content.trim());
                if (attrs.type === 'application/vnd.ant.chess' && parsed.fen) {
                  metadata = {
                    ...metadata,
                    fen: parsed.fen || parsed.resultingFen,
                    turn: parsed.turn,
                    moveNumber: parsed.moveNumber,
                    isCheck: parsed.isCheck,
                    isCheckmate: parsed.isCheckmate,
                    isDraw: parsed.isDraw,
                    isGameOver: parsed.isGameOver,
                    playerMove: parsed.playerMove,
                    aiMove: parsed.aiMove || parsed.move,
                    bestMove: parsed.bestMove,
                  };
                }
              } catch {
                // Content isn't JSON - still store as-is
              }

              callbacks.onArtifactExtracted({
                type: 'data',
                content: content.trim(),
                metadata,
                timestamp: new Date(),
              });
              logger.debug(`[toolArtifact] Extracted ${attrs.type} artifact from ${toolName}`, {
                identifier: attrs.identifier,
              });
            }
          } catch (e) {
            logger.warn(`[toolArtifact] Failed to extract artifact from ${toolName}:`, e);
          }
        }

        return result;
      },
    };
  }
}

function createMcpToolWrapper(
  name: string,
  originalToolFn: ICompletionOptionTools['toolFn'],
  logger: Logger,
  callbacks: ToolBuilderCallbacks,
  deps: ToolBuilderDeps
): ICompletionOptionTools['toolFn'] {
  return async (args: unknown) => {
    const result = await originalToolFn(args);

    // Extract _confirmToken from tool result
    if (callbacks.onPendingAction) {
      try {
        if (typeof result === 'string' && result.includes('_confirmToken')) {
          const parsed = JSON.parse(result);
          if (parsed._confirmToken) {
            const decoded = JSON.parse(Buffer.from(parsed._confirmToken, 'base64').toString('utf-8'));

            if (
              typeof decoded.tool !== 'string' ||
              typeof decoded.ts !== 'number' ||
              decoded.params === null ||
              typeof decoded.params !== 'object'
            ) {
              logger.warn(`[MCP] Malformed _confirmToken payload from tool ${name}`, {
                decodedKeys: Object.keys(decoded),
              });
              delete parsed._confirmToken;
              return JSON.stringify(parsed, null, 2);
            }

            logger.debug(`[MCP] Extracted pendingAction from tool ${name}:`, {
              tool: decoded.tool,
              ts: decoded.ts,
            });

            try {
              await callbacks.onPendingAction({
                tool: decoded.tool as string,
                params: decoded.params as Record<string, unknown>,
                ts: decoded.ts as number,
              });
            } catch (saveErr) {
              logger.error(`[MCP] Failed to persist pendingAction from tool ${name}`, {
                error: saveErr instanceof Error ? saveErr.message : String(saveErr),
              });
            }

            // Strip _confirmToken from result before AI sees it
            delete parsed._confirmToken;
            if (parsed.next_step) {
              parsed.next_step = 'Click the Confirm or Cancel button below to proceed.';
            }
            return JSON.stringify(parsed, null, 2);
          }
        }
      } catch (err) {
        logger.warn(`[MCP] Failed to extract _confirmToken from tool ${name}`, {
          error: err instanceof Error ? err.message : String(err),
          resultSnippet: typeof result === 'string' ? result.slice(0, 200) : typeof result,
        });
        // SECURITY: Strip _confirmToken even on decode failure
        if (typeof result === 'string') {
          try {
            const fallbackParsed = JSON.parse(result);
            delete fallbackParsed._confirmToken;
            return JSON.stringify(fallbackParsed, null, 2);
          } catch {
            logger.error(`[MCP] SECURITY: Fallback _confirmToken strip failed for tool ${name}`);
            return JSON.stringify({ error: `Tool ${name} returned an unparseable result. Please try again.` });
          }
        }
      }
    }

    // Extract entities from tool result for conversation context
    if (callbacks.sessionId && shouldExtractEntitiesFromTool(name) && deps.sessionRepository) {
      extractAndSaveEntitiesFromToolResult(callbacks.sessionId, name, result, deps.sessionRepository).catch(err => {
        logger.debug(`[ConversationContext] Failed to extract entities from ${name}:`, err);
      });
    }

    // Extract _attachmentList for interactive download buttons
    if (callbacks.onAttachmentList) {
      try {
        if (typeof result === 'string' && result.includes('_attachmentList')) {
          const parsed = JSON.parse(result);
          if (parsed._attachmentList === true && Array.isArray(parsed.attachments)) {
            logger.debug(`[MCP] Extracted attachment list from tool ${name}`, {
              source: parsed.source,
              count: parsed.attachments.length,
            });

            const attachmentList = {
              source: parsed.source,
              issueKey: parsed.issueKey,
              pageId: parsed.pageId,
              pageTitle: parsed.pageTitle,
              // any: parsed from JSON.parse of untyped MCP tool result
              attachments: parsed.attachments.map((att: Record<string, unknown>) => ({
                id: att.id,
                filename: att.filename,
                emoji: att.emoji,
                sizeFormatted: att.sizeFormatted,
                mimeType: att.mimeType,
                author: att.author,
                created: att.created,
              })),
            };

            try {
              const overrideResult = await callbacks.onAttachmentList(attachmentList);
              if (overrideResult) return overrideResult;
            } catch (saveErr) {
              logger.error(`[MCP] Failed to persist attachmentList from tool ${name}`, {
                error: saveErr instanceof Error ? saveErr.message : String(saveErr),
              });
            }

            // Default: return simplified result for AI
            const sourceLabel = parsed.source === 'jira' ? 'Jira issue' : 'Confluence page';
            const identifier = parsed.issueKey || parsed.pageId || '';
            return JSON.stringify(
              {
                success: true,
                message: `Found ${parsed.attachments.length} attachment(s) on ${sourceLabel} ${identifier}. Interactive download buttons are shown below with file details. Tell the user they can click any Download button to get the file directly in this channel. Do NOT list the files - the buttons already show all the details.`,
                count: parsed.attachments.length,
              },
              null,
              2
            );
          }
        }
      } catch (err) {
        logger.warn(`[MCP] Failed to extract _attachmentList from tool ${name}`, {
          error: err instanceof Error ? err.message : String(err),
          resultSnippet: typeof result === 'string' ? result.slice(0, 200) : typeof result,
        });
        if (typeof result === 'string') {
          try {
            const fallbackParsed = JSON.parse(result);
            delete fallbackParsed._attachmentList;
            delete fallbackParsed.attachments;
            return JSON.stringify(fallbackParsed, null, 2);
          } catch {
            // Original result is not parseable - return as-is
          }
        }
      }
    }

    return result;
  };
}
