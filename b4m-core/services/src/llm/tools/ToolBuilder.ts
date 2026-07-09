import {
  CreditHolderType,
  IChatHistoryItemDocument,
  IMessage,
  IUserDocument,
  IOrganizationDocument,
  IUsageEventInput,
  ModelInfo,
} from '@bike4mind/common';
import { type ApiKeyTable, type ICompletionBackend, type ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { Logger } from '@bike4mind/observability';
import { z } from 'zod';
import type { ServerAgentConfig } from '@bike4mind/agents';
import { ServerAgentStore } from '../agents/ServerAgentStore';
import { generateMcpToolsFromCache, LlmTools } from './index';
import { ToolDefinition } from './base/types';
import { validateUserCredits } from './base/utils';
import {
  extractAndSaveEntitiesFromUserMessage,
  getConversationContextSystemMessage,
} from '../../conversationContextService';
import { buildSharedTools } from '../sharedToolBuilder';
import type { SubagentTelemetryData } from './implementation/delegateToAgent';
import type { IChatCompletionServiceOptions, QuestStartBodySchema } from '../ChatCompletionFeatures';

/** Usage-event input shared by both tool settlement sites. Analytics only, never billing. */
export function buildToolUsageEvent(params: {
  quest: IChatHistoryItemDocument;
  user: IUserDocument;
  organization?: IOrganizationDocument | null;
  provider: string;
  model: string;
  costUsd: number;
  creditsCharged: number;
  units?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
}): IUsageEventInput {
  const { quest, user, organization } = params;
  return {
    requestId: quest.id,
    userId: user.id,
    ownerId: organization ? organization.id : user.id,
    ownerType: organization ? CreditHolderType.Organization : CreditHolderType.User,
    sessionId: quest.sessionId,
    feature: 'tool',
    provider: params.provider,
    model: params.model,
    inputTokens: params.inputTokens ?? 0,
    outputTokens: params.outputTokens ?? 0,
    cachedInputTokens: params.cachedInputTokens ?? 0,
    cacheWriteTokens: params.cacheWriteTokens ?? 0,
    units: params.units,
    costUsd: params.costUsd,
    creditsCharged: params.creditsCharged,
    status: 'ok',
  };
}

/** Fire-and-forget dual-write: a failed analytics record must never throw into billing. */
export function recordToolUsageEvent(
  db: IChatCompletionServiceOptions['db'],
  logger: Logger,
  toolName: string,
  event: IUsageEventInput
): void {
  db.usageEvents?.record(event).catch(err => logger.warn(`[toolUsageEvent] failed for ${toolName}:`, err));
}

type SendStatusUpdate = (
  q: IChatHistoryItemDocument,
  status: string | null,
  options?: {
    silent?: boolean;
    immediate?: boolean;
    statusAt?: Date;
    skipPayloadOptimization?: boolean;
  }
) => Promise<void>;

// Named ToolBuilderConfig (not ToolBuilderDeps) to avoid name collision with the
// ToolBuilderDeps interface exported from ../sharedToolBuilder.ts, which describes
// the deps for the lower-level buildSharedTools() function.
export interface ToolBuilderConfig {
  user: IUserDocument;
  db: IChatCompletionServiceOptions['db'];
  /** Caller's resolved entitlement keys, forwarded to the tool context (see ToolContext). */
  entitlementKeys?: string[];
  logger: Logger;
  storage: IChatCompletionServiceOptions['storage'];
  imageGenerateStorage: IChatCompletionServiceOptions['imageGenerateStorage'];
  imageProcessorLambdaName?: string;
  getMcpClient: IChatCompletionServiceOptions['getMcpClient'];
  // State maps owned by ChatCompletionProcess. Passed by reference so mutations
  // inside tool callbacks (credit accounting, subagent telemetry) propagate back
  // without further synchronization.
  toolCreditsMap: Map<string, number>;
  // Shared by reference with ChatCompletionProcess; mutations from callbacks
  // propagate to the parent for end-of-quest telemetry assembly.
  subagentTelemetryData: SubagentTelemetryData[];
  sendStatusUpdate: SendStatusUpdate;
  /**
   * Fired before a tool's `toolFn` runs so callers (Voice v2 proxy) can speak a
   * preamble while the tool executes. No-op when omitted.
   */
  onToolPreamble?: (preamble: string, toolName: string) => void;
}

// Short spoken preambles for tools whose latency would otherwise leave the
// ElevenLabs agent silent past its time-to-first-token timer.
//
// CONVENTION FOR NEW TOOLS:
//   Any tool whose `toolFn` does network I/O, model calls, or other noticeable
//   work should call `await context.onStart?.(toolName, params)` as its FIRST
//   line. That's what fires this preamble. If the tool is in TOOL_PREAMBLES
//   below it speaks the specific line; otherwise it falls back to
//   DEFAULT_PREAMBLE so voice never goes silent during a new tool's first
//   deploy. To stay silent on purpose (truly fast tools that still want
//   onStart for credit/telemetry), add the name to SILENT_TOOLS.
const DEFAULT_PREAMBLE = 'One moment…';
const SILENT_TOOLS = new Set<string>([]);
const TOOL_PREAMBLES: Record<string, string> = {
  web_search: 'Searching the web…',
  search_knowledge_base: 'Looking through your knowledge base…',
  retrieve_knowledge_content: 'Pulling that up…',
  weather_info: 'Checking the weather…',
  wolfram_alpha: 'Running that through Wolfram…',
  deep_research: 'Doing deeper research — give me a moment…',
  image_generation: 'Generating an image…',
  edit_image: 'Editing the image…',
};

function resolveToolPreamble(toolName: string): string | null {
  if (SILENT_TOOLS.has(toolName)) return null;
  return TOOL_PREAMBLES[toolName] ?? DEFAULT_PREAMBLE;
}

/** Trim a tool input to a short, single-line snippet for a status label. */
function truncateForStatus(text: string, max = 64): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Chat-facing status line shown live while a tool runs ("watch it work"). Richer than
 * the voice-only TOOL_PREAMBLES - enriched with the tool's actual input (query/tags) so
 * the user sees the assistant working through the data lake instead of a dead spinner.
 * Returns null for tools that should stay silent in the chat status area.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveToolStatus(toolName: string, data: any): string | null {
  if (SILENT_TOOLS.has(toolName)) return null;
  const d = (data ?? {}) as Record<string, unknown>;
  const query = typeof d.query === 'string' ? d.query : undefined;
  const tags = Array.isArray(d.tags) && d.tags.length ? ` [${(d.tags as string[]).join(', ')}]` : '';
  switch (toolName) {
    case 'search_knowledge_base':
      return query ? `🔎 Searching the data lake${tags}: “${truncateForStatus(query)}”` : '🔎 Searching the data lake…';
    case 'retrieve_knowledge_content':
      return '📄 Reading the most relevant articles…';
    case 'web_search':
      return query ? `🌐 Searching the web: “${truncateForStatus(query)}”` : '🌐 Searching the web…';
    case 'web_fetch':
      return '🌐 Fetching that page…';
    case 'deep_research':
      return '🔬 Running deeper research — a few rounds…';
    default:
      // Only known tools surface a chat status; everything else stays silent here.
      return TOOL_PREAMBLES[toolName] ?? null;
  }
}

/**
 * Apply a partial status-update change set onto the live quest object.
 *
 * Most fields are overwritten wholesale via Object.assign, but two fields
 * accrete across a single turn and MUST merge instead of overwrite:
 *   - promptMeta.citables: accreted by web_search / knowledge retrieval; merged
 *     and deduped by stable identity (id, then url, then title) to avoid duplicate
 *     "Sources" chips and React duplicate-key warnings.
 *   - images: each image_generation / edit_image tool call sends only its own
 *     output through statusUpdate, so a wholesale overwrite collapses an N-image
 *     request down to just the last call's image. Merge-append with dedup;
 *     onToolFinish dedup-appends the same paths, so this stays idempotent for a
 *     single call.
 *
 * Mutates `quest` in place.
 */
export function applyQuestStatusChanges(
  quest: IChatHistoryItemDocument,
  changes: Partial<IChatHistoryItemDocument>
): void {
  const { promptMeta: changedPromptMeta, images: changedImages, ...otherChanges } = changes;

  if (changedPromptMeta && quest.promptMeta) {
    const mergedCitables = [...(quest.promptMeta.citables || []), ...(changedPromptMeta.citables || [])];
    const seenCitableKeys = new Set<string>();
    const dedupedCitables = mergedCitables.filter(c => {
      const key = c.id || c.url || c.title;
      if (!key || seenCitableKeys.has(key)) return false;
      seenCitableKeys.add(key);
      return true;
    });
    quest.promptMeta = {
      ...quest.promptMeta,
      ...changedPromptMeta,
      citables: dedupedCitables,
    };
  } else if (changedPromptMeta) {
    quest.promptMeta = changedPromptMeta;
  }

  if (changedImages) {
    const seenImages = new Set(quest.images || []);
    const accumulated = quest.images ? [...quest.images] : [];
    for (const img of changedImages) {
      if (!seenImages.has(img)) {
        seenImages.add(img);
        accumulated.push(img);
      }
    }
    quest.images = accumulated;
  }

  Object.assign(quest, otherChanges);
}

export interface BuildMcpToolsArgs {
  enableMCPServer: boolean;
  requestedMcpServers: string[] | undefined;
  defaultAdminSettings: Record<string, string>;
  userMessage: string;
  logger: Logger;
  processStartTime: number;
  quest: IChatHistoryItemDocument;
}

export interface BuildToolsArgs {
  enabledTools?: z.infer<typeof QuestStartBodySchema>['tools'];
  mcpToolsByServer?: Record<string, Array<{ name: string } & ICompletionOptionTools>>;
  quest: IChatHistoryItemDocument;
  saveQuest: (quest: IChatHistoryItemDocument) => Promise<IChatHistoryItemDocument | null>;
  llm: ICompletionBackend;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: { [key in LlmTools]?: any };
  model?: string;
  organization?: IOrganizationDocument | null;
  precomputed?: {
    adminSettingsEnforceCredits: boolean;
    models: ModelInfo[];
  };
  agentOnlyMcpServers?: string[];
  apiKeyTable?: ApiKeyTable;
  getAbortSignal?: () => AbortSignal | undefined;
  thinking?: { enabled: boolean; budget_tokens: number };
  agentStore?: ServerAgentStore;
  externalTools?: Record<string, ToolDefinition>;
}

// Reuse the role enum validated at the API boundary by QuestStartBodySchema so the
// type contract here stays in sync with the wire schema.
type ExtraContextMessage = NonNullable<z.infer<typeof QuestStartBodySchema>['extraContextMessages']>[number];

export interface BuildToolPromptArgs {
  toolPromptId?: string;
  hasContentTransform: boolean;
  hasChessEngine: boolean;
  hasCurrentDateTime: boolean;
  /**
   * User's IANA timezone (from the browser) when known, so the current-time
   * nudge can tell the model which timezone to pass to `current_datetime`.
   */
  userTimezone?: string;
  mcpTools: Array<{ name: string }>;
  sessionId: string;
  message: string;
  logger: Logger;
  processStartTime: number;
  /**
   * When undefined, the agent-delegation section is omitted from the tool
   * prompt - matches the contract in `sharedToolBuilder` where an absent
   * agentStore suppresses the `delegate_to_agent` tool itself.
   */
  agentStore?: ServerAgentStore;
  extraContextMessages: ExtraContextMessage[];
}

export class ToolBuilder {
  constructor(private readonly deps: ToolBuilderConfig) {}

  /**
   * Build MCP tool definitions from DB-cached schemas.
   * No MCP server connections are made here - callTool closures connect lazily via Lambda
   * only when the LLM actually invokes a tool.
   */
  async buildMcpTools({
    enableMCPServer,
    requestedMcpServers,
    defaultAdminSettings: _defaultAdminSettings,
    userMessage: _userMessage,
    logger,
    processStartTime,
    quest: _quest,
  }: BuildMcpToolsArgs): Promise<{
    mcpToolsByServer: Record<string, Array<{ name: string } & ICompletionOptionTools>>;
    serverAgentConfig: ServerAgentConfig;
  }> {
    const mcpToolsStartTime = Date.now();
    const mcpToolsByServer: Record<string, Array<{ name: string } & ICompletionOptionTools>> = {};

    if (!enableMCPServer) {
      logger.info(
        `⏱️ [${Date.now() - processStartTime}ms] MCP tools setup completed (0 tools) in ${Date.now() - mcpToolsStartTime}ms`
      );
      return { mcpToolsByServer, serverAgentConfig: {} };
    }

    logger.info('🛠️ [MCP] Enabling MCP Servers');

    // All enabled MCP servers for this user.
    const allMcpServers = await this.deps.db.mcpServers.find({ enabled: true, userId: this.deps.user.id });

    // Filter to only the requested servers
    // - If requestedMcpServers is null/undefined: use all servers (backwards compatibility)
    // - If requestedMcpServers is empty array: user disabled all, use none
    // - If requestedMcpServers has values: filter to only those
    const mcpServers =
      requestedMcpServers === null || requestedMcpServers === undefined
        ? allMcpServers
        : allMcpServers.filter(s => requestedMcpServers.includes(s.name));

    logger.info('🛠️ [MCP] Found MCP servers:', {
      allCount: allMcpServers.length,
      requestedCount: requestedMcpServers?.length ?? 'all',
      filteredCount: mcpServers.length,
      servers: mcpServers.map(s => ({
        name: s.name,
        enabled: s.enabled,
        hasEnvVars: !!s.envVariables && s.envVariables.length > 0,
      })),
    });

    if (mcpServers.length === 0 && requestedMcpServers && requestedMcpServers.length > 0) {
      logger.warn('🛠️ [MCP] WARNING: Client requested MCP servers but none were found/enabled:', requestedMcpServers);
    }

    // Build tool definitions from DB-cached schemas, grouped by server name.
    // Tool schemas are populated by the GET /api/mcp-servers endpoint and connect/OAuth flows.
    // callTool connects lazily via Lambda only when the LLM actually invokes a tool.
    for (const server of mcpServers) {
      if (server.toolSchemas?.length) {
        const callTool = async (toolName: string, toolArgs: unknown) => {
          const client = await this.deps.getMcpClient(server);
          const result = await client.callTool(toolName, toolArgs);
          return result;
        };
        mcpToolsByServer[server.name] = generateMcpToolsFromCache(server.name, server.toolSchemas, callTool);
        logger.info(`🛠️ [MCP] Loaded ${server.toolSchemas.length} tool schemas for ${server.name} from DB`);
      } else {
        logger.warn(`🛠️ [MCP] No tool schemas found for ${server.name} — skipping (reconnect server to populate)`);
      }
    }

    const totalTools = Object.values(mcpToolsByServer).reduce((sum, tools) => sum + tools.length, 0);

    // Extract selected repositories from GitHub MCP server metadata for agent prompt injection.
    // Look in allMcpServers (not the filtered mcpServers) because GitHub is agent-only
    // and may not be in the user's requestedMcpServers list.
    const githubServer = allMcpServers.find(s => s.name === 'github');
    let selectedRepositories: string | undefined;
    if (githubServer?.metadata?.selectedRepositories?.length) {
      selectedRepositories = githubServer.metadata.selectedRepositories
        .map((r: { fullName: string }) => `- ${r.fullName}`)
        .join('\n');
    }
    const githubUsername = (githubServer?.metadata?.githubLogin as string) || undefined;

    logger.info(
      `⏱️ [${Date.now() - processStartTime}ms] MCP tools setup completed (${totalTools} tools) in ${Date.now() - mcpToolsStartTime}ms`
    );

    return { mcpToolsByServer, serverAgentConfig: { selectedRepositories, githubUsername } };
  }

  /**
   * Build the LLM tool list for the current quest.
   *
   * Thin wrapper around `buildSharedTools()` (the canonical extraction shared with the
   * Agent Executor Lambda - see `../sharedToolBuilder.ts`). This wrapper provides the
   * ChatCompletionProcess-specific side-effect callbacks: persisting credit usage,
   * navigation intents, artifacts, pending actions, attachment lists, and subagent
   * telemetry onto the quest document.
   */
  buildTools({
    enabledTools = [],
    mcpToolsByServer = {},
    quest,
    saveQuest,
    llm,
    config,
    model,
    organization,
    precomputed,
    agentOnlyMcpServers = [],
    apiKeyTable,
    getAbortSignal,
    thinking,
    agentStore,
    externalTools,
  }: BuildToolsArgs): ICompletionOptionTools[] | undefined {
    return buildSharedTools(
      {
        userId: this.deps.user.id,
        user: this.deps.user,
        logger: this.deps.logger,
        db: this.deps.db,
        entitlementKeys: this.deps.entitlementKeys,
        sessionRepository: this.deps.db.sessions,
        storage: this.deps.storage,
        imageGenerateStorage: this.deps.imageGenerateStorage,
        imageProcessorLambdaName: this.deps.imageProcessorLambdaName,
        llm,
        model,
        precomputed,
        apiKeyTable,
        thinking,
        agentStore,
      },
      {
        onStatusUpdate: async (changes, status) => {
          // Merge nested fields that accrete across a turn (promptMeta.citables,
          // images) instead of overwriting them wholesale - see
          // applyQuestStatusChanges.
          applyQuestStatusChanges(quest, changes as Partial<IChatHistoryItemDocument>);
          await this.deps.sendStatusUpdate(quest, status ?? null);
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onToolStart: async (toolName: string, data: any) => {
          // Chat: surface a live, input-enriched status so the wait reads as
          // productive work instead of a dead spinner. Fire-and-forget and
          // immediate so each tool transition is visible as it happens.
          const chatStatus = resolveToolStatus(toolName, data);
          if (chatStatus) {
            void this.deps
              .sendStatusUpdate(quest, chatStatus, { statusAt: new Date(), immediate: true })
              .catch(err => this.deps.logger.warn(`[toolStatus] failed for ${toolName}:`, err));
          }

          // Voice v2: speak a short preamble while the tool runs so ElevenLabs
          // hears audio before its time-to-first-token timer fires. Fire-and-forget
          // - the preamble must not block tool execution. Unknown tools fall back
          // to a generic line so a newly-added slow tool can't accidentally make
          // voice go silent before it's added to TOOL_PREAMBLES.
          if (this.deps.onToolPreamble) {
            const preamble = resolveToolPreamble(toolName);
            if (preamble) {
              try {
                this.deps.onToolPreamble(preamble, toolName);
              } catch (err) {
                this.deps.logger.warn(`[onToolPreamble] failed for ${toolName}:`, err);
              }
            }
          }

          if (toolName === 'image_generation' || toolName === 'edit_image') {
            this.deps.logger.info(`Tool ${toolName} started with data: ${JSON.stringify(data)}`);
            const { model: toolModel, n, size, quality } = data;
            if (!toolModel) return;

            const enforceCredits = precomputed?.adminSettingsEnforceCredits ?? true;
            if (enforceCredits && toolModel && !!this.deps.db.creditTransactions) {
              const availableModels = precomputed?.models ?? [];
              const modelInfo = availableModels.find(m => m.id === toolModel);
              if (!modelInfo) return;

              const { requiredCredits: creditsUsed, usdCost } = await validateUserCredits(
                this.deps.user,
                modelInfo,
                n || 1,
                { model: toolModel, size, quality },
                this.deps.logger,
                organization
              );
              this.deps.logger.info(`Credits used for tool ${toolName}: ${creditsUsed}`);
              this.deps.toolCreditsMap.set(toolName, creditsUsed);
              quest.creditsUsed = (quest.creditsUsed ?? 0) + creditsUsed;
              await saveQuest(quest);
              recordToolUsageEvent(
                this.deps.db,
                this.deps.logger,
                toolName,
                buildToolUsageEvent({
                  quest,
                  user: this.deps.user,
                  organization,
                  provider: modelInfo.backend,
                  model: toolModel,
                  costUsd: usdCost,
                  creditsCharged: creditsUsed,
                  units: n || 1,
                })
              );
            }
          }
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onToolFinish: async (toolName: string, data: any) => {
          if (toolName === 'deep_research') {
            this.deps.logger.info(`Tool ${toolName} finished with data: ${JSON.stringify(data)}`);
            quest.deepResearchState = data;
            await saveQuest(quest);
          }
          if (toolName === 'image_generation' || toolName === 'edit_image') {
            this.deps.logger.info(`Tool ${toolName} finished with data: ${JSON.stringify(data)}`);
            const imagePaths = Array.isArray(data) ? data : [data];
            if (!quest.images) quest.images = [];
            imagePaths.forEach((path: string) => {
              if (!quest.images?.includes(path)) quest.images?.push(path);
            });
            await saveQuest(quest);
          }
        },
        onNavigationIntents: async intents => {
          quest.navigationIntents = intents as typeof quest.navigationIntents;
          await saveQuest(quest);
        },
        onUiSideEffect: async sideEffect => {
          if (!quest.uiSideEffects) quest.uiSideEffects = [];
          quest.uiSideEffects.push(sideEffect as (typeof quest.uiSideEffects)[number]);
          await saveQuest(quest);
        },
        onArtifactExtracted: artifact => {
          if (!quest.promptMeta) quest.promptMeta = {} as NonNullable<typeof quest.promptMeta>;
          if (!quest.promptMeta!.artifacts) quest.promptMeta!.artifacts = [];
          quest.promptMeta!.artifacts.push(artifact as (typeof quest.promptMeta.artifacts)[number]);
          // Fire-and-forget save
          void saveQuest(quest).catch(err => {
            this.deps.logger.warn('[toolArtifact] Failed to save quest after extracting artifact:', err);
          });
        },
        onPendingAction: async action => {
          quest.pendingAction = action;
          await saveQuest(quest);
          this.deps.logger.debug(`[MCP] pendingAction saved to quest ${quest.id}`);
        },
        onAttachmentList: async attachmentList => {
          quest.attachmentList = attachmentList as typeof quest.attachmentList;
          await saveQuest(quest);
          return undefined; // Use default simplified result
        },
        sessionId: quest.sessionId,
        onSubagentCredits: (credits, meta) => {
          this.deps.toolCreditsMap.set('delegate_to_agent', credits);
          // No meta == model unresolvable; skip rather than fabricate a zero-cost event.
          if (meta) {
            recordToolUsageEvent(
              this.deps.db,
              this.deps.logger,
              'delegate_to_agent',
              buildToolUsageEvent({
                quest,
                user: this.deps.user,
                organization,
                provider: meta.provider,
                model: meta.model,
                costUsd: meta.usdCost,
                creditsCharged: credits,
                inputTokens: meta.inputTokens,
                outputTokens: meta.outputTokens,
                cachedInputTokens: meta.cacheReadTokens,
                cacheWriteTokens: meta.cacheWriteTokens,
              })
            );
          }
        },
        onSubagentTelemetry: telemetryData => {
          const typed = telemetryData as SubagentTelemetryData;
          this.deps.subagentTelemetryData.push(typed);
          this.deps.logger.info(`[Telemetry] Subagent "${typed.agentName}" completed`, {
            durationMs: typed.durationMs,
            success: typed.success,
            isTimeout: typed.isTimeout,
          });
        },
        onSubagentStatusUpdate: async status => {
          await this.deps.sendStatusUpdate(quest, status, { statusAt: new Date() });
        },
      },
      {
        enabledTools,
        mcpToolsByServer,
        config,
        agentOnlyMcpServers,
        getAbortSignal,
        externalTools,
      }
    );
  }

  /**
   * Build a single tool-related system prompt combining: tool prompt from DB, blog draft workflow,
   * MCP integration guidance, conversation context, and agent delegation guidance.
   * Returns a single IMessage or null if there's nothing to add.
   *
   * NOTE: not pure. When MCP tools are present this method also writes to the session
   * via `extractAndSaveEntitiesFromUserMessage` to persist entities for later reference
   * resolution (e.g. "review that PR"). See `# 5. Conversation context` block below.
   */
  async buildToolPrompt({
    toolPromptId,
    hasContentTransform,
    hasChessEngine,
    hasCurrentDateTime,
    userTimezone,
    mcpTools,
    sessionId,
    message,
    logger,
    processStartTime,
    agentStore,
    extraContextMessages,
  }: BuildToolPromptArgs): Promise<IMessage | null> {
    const sections: string[] = [];

    // 1. Tool prompt from DB (custom prompt attached to tool)
    if (toolPromptId) {
      const toolPromptStartTime = Date.now();
      try {
        const toolPrompt = await this.deps.db.prompts.findById(toolPromptId);
        if (toolPrompt) {
          sections.push(toolPrompt.promptText);
          logger.info(
            `⏱️ [${Date.now() - processStartTime}ms] Tool prompt loaded: "${toolPrompt.name}" in ${Date.now() - toolPromptStartTime}ms`
          );
        } else {
          logger.warn(`Tool prompt with ID ${toolPromptId} not found`);
        }
      } catch (error) {
        logger.error(`Failed to load tool prompt ${toolPromptId}:`, error);
      }
    }

    // 2. Blog publishing workflow instruction (if blog_draft tool is enabled)
    if (hasContentTransform) {
      sections.push(`# MANDATORY BLOG WORKFLOW

**CRITICAL RULE**: When user says "publish to my blog" or "draft a blog post" or similar, you MUST use blog_draft tool.

## Step 1: YOU CALL blog_draft (REQUIRED)
When user wants to blog about conversation/content:
- IMMEDIATELY call blog_draft tool with the conversation content
- DO NOT talk about calling it - ACTUALLY CALL IT
- DO NOT call blog_publish instead
- DO NOT create content and publish directly

## Step 2: User Reviews (Automatic)
- Frontend shows preview card automatically
- User can edit/review

## Step 3: User Publishes (Not Your Job)
- User clicks button in preview modal
- That triggers blog_publish
- You don't call blog_publish yourself

## EXCEPTION
ONLY call blog_publish directly if:
- User provides exact title, content, tags already formatted
- User explicitly says "publish this exact text"

Otherwise: USE blog_draft TOOL FIRST!`);
    }

    // 3. Chess engine workflow (if chess_engine tool is enabled)
    if (hasChessEngine) {
      sections.push(`# MANDATORY CHESS WORKFLOW

**CRITICAL**: You have the \`chess_engine\` tool. You MUST follow these rules for ALL chess interactions:

## Rule 1: EVERY move goes through the tool
- To start a game: call chess_engine with action "new_game"
- For EVERY player move: call chess_engine with action "play_turn" (this applies the player's move AND computes your counter-move atomically)
- NEVER write moves in text without calling the tool first
- NEVER fabricate or write <artifact> tags yourself — the tool returns them

## Rule 2: Use "play_turn" for all moves during a game
- "play_turn" requires "fen" (current board state from the last tool result) and "move" (player's move in SAN notation)
- It returns BOTH the player's move and your AI counter-move in one response
- The returned artifact contains the authoritative board state — trust it completely

## Rule 3: Parse natural language into SAN and call the tool immediately
- "English opening" → call new_game, then call play_turn with move "c4"
- "Knight to f3" or "knight to see three" → call play_turn with move "Nf3"
- "Castle kingside" → call play_turn with move "O-O"
- "I play c4" or just "c4" → call play_turn with move "c4"
- If the user says "let's play chess" or "chess please" → call new_game immediately
- ALWAYS call the tool. NEVER just narrate a move in text.

## Rule 4: NEVER render ASCII/text chess boards
- The artifact system renders the board visually in the side panel
- Do NOT draw boards with Unicode pieces in your text response
- Your text should only contain brief commentary about the moves

## Rule 5: Trust the tool's legal moves list
- The tool returns LEGAL_MOVES in every response — these are authoritative
- If a move isn't in LEGAL_MOVES, it IS illegal — tell the user
- If a move IS in LEGAL_MOVES, it IS legal — never claim otherwise

## Rule 6: Always pass the FEN from the LAST tool result
- Each tool response returns JSON with a "fen" field — use THAT exact string for your next call
- NEVER modify, reconstruct, or guess FEN strings
- NEVER use a FEN from your own memory — always use the tool's output
- NEVER echo the raw tool result JSON or artifact tags in your text response

## Rule 7: Two-step game start
When the user wants to play chess AND specifies an opening move in the same message:
1. First call chess_engine with action "new_game" to get the starting position and FEN
2. Then call chess_engine with action "play_turn" using the starting FEN and the user's first move
Both calls happen in the same response — do NOT ask the user to repeat their move.`);
    }

    // 3b. Current date/time nudge (if current_datetime tool is enabled).
    // The ambient system prefix (dateTimeContext in ChatCompletionProcess) carries
    // only day-granularity date - kept byte-stable for prompt-cache reads;
    // it deliberately omits the time of day, so the model must call the tool for
    // anything clock-level.
    if (hasCurrentDateTime) {
      const timezoneHint = userTimezone
        ? ` The user's timezone is \`${userTimezone}\` — pass it as the \`timezone\` parameter.`
        : '';
      sections.push(
        `# CURRENT TIME\n\n` +
          `For the current time of day, or to timestamp an action at the moment it executes, ` +
          `call the \`current_datetime\` tool — never guess or invent the time.${timezoneHint}`
      );
    }

    // 4. MCP integration guidance (if MCP tools are available)
    if (mcpTools.length > 0) {
      // Tool/server names come from user-configured MCP servers, so strip control
      // characters and cap length before interpolating into the system prompt.
      const sanitizeToolName = (name: string) => name.replace(/[\r\n\t]+/g, ' ').slice(0, 80);
      const mcpIntegrations: Record<string, string[]> = {};
      mcpTools.forEach(tool => {
        const safeName = sanitizeToolName(tool.name);
        const parts = safeName.split('_');
        const prefix = parts[0];
        if (!mcpIntegrations[prefix]) {
          mcpIntegrations[prefix] = [];
        }
        mcpIntegrations[prefix].push(safeName);
      });

      const integrationList = Object.entries(mcpIntegrations)
        .map(([integration, tools]) => {
          const displayName = integration;
          return `- **${displayName}**: ${tools.length} tools available (${tools.slice(0, 3).join(', ')}${tools.length > 3 ? '...' : ''})`;
        })
        .join('\n');

      sections.push(`## Connected Integrations

You have access to the following external integrations:

${integrationList}

**Important guidelines for using these integrations:**
1. When the user asks about tasks related to these integrations, you MUST call the appropriate tool
2. Do not respond that you cannot help - use the available tools to fulfill the request
3. **Be concise when using tools** - do NOT repeat introductory phrases like "I'll help you with..." before each tool call. Simply execute the tools and present the results
4. When making multiple tool calls, skip the preamble and just execute them efficiently`);

      logger.info('🛠️ [MCP] Added integration guidance to tool prompt:', {
        integrationCount: Object.keys(mcpIntegrations).length,
        integrations: Object.keys(mcpIntegrations),
      });

      // 5. Conversation context for reference resolution.
      // Enables "review that PR" after discussing a PR
      try {
        await extractAndSaveEntitiesFromUserMessage(sessionId, message, this.deps.db.sessions);

        const contextMessage = await getConversationContextSystemMessage(sessionId, this.deps.db.sessions);
        if (contextMessage) {
          sections.push(contextMessage.content);
          logger.info('🧠 [ConversationContext] Added context to tool prompt');
        }
      } catch (contextErr) {
        logger.debug('[ConversationContext] Failed to add context:', contextErr);
      }
    }

    // 5. (Removed) Product-surface prompts are no longer injected here. A surface
    // that needs a page-specific system prompt bakes it into the session's
    // server-owned `systemPromptText` at create time (consumer-not-modifier:
    // the surface sets generic session fields; core stays product-neutral).

    // 6. Agent delegation guidance - only included when delegate_to_agent is
    // actually being exposed to the model. ChatCompletionProcess passes
    // `agentStore: undefined` when the user didn't @mention an agent, didn't
    // attach one to the session, and the caller didn't pass an explicit
    // allowedAgents allowlist. In that case the tool is suppressed and this
    // prompt section must be too - otherwise the model would be told about a
    // tool it can't actually call.
    if (agentStore) {
      const agents = agentStore.getAllAgents();
      const agentList = agents.map(a => `- **${a.name}**: ${a.description}`).join('\n');

      sections.push(`## Agent Delegation

You have the \`delegate_to_agent\` tool which lets you delegate tasks to specialized autonomous agents. Each agent runs independently with its own reasoning loop and tools.

### Available Agents
${agentList}

### Guidelines
1. Delegate when a task clearly matches an agent's specialty — do not attempt it yourself
2. Provide a clear, specific task description so the agent can work autonomously
3. You can set thoroughness: \`quick\` for simple lookups, \`medium\` (default) for balanced work, \`very_thorough\` for comprehensive analysis`);

      logger.debug('🤖 [Agents] Added agent delegation guidance to tool prompt:', {
        agentCount: agents.length,
        agents: agents.map(a => a.name),
      });
    }

    if (sections.length === 0) {
      return null;
    }

    return { role: 'system', content: sections.join('\n\n') };
  }
}
