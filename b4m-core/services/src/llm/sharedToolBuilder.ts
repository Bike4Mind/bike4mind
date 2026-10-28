/**
 * Shared Tool Builder
 *
 * Extracted from ChatCompletionProcess.buildTools() to enable both
 * ChatCompletionProcess and the Agent Executor Lambda to build tools
 * using the same pipeline.
 */

import {
  parseToolArtifactAttributes,
  scanArtifactTags,
  resolveToolArtifactType,
  type IChatHistoryItemDocument,
  type ModelInfo,
  type ThinkingVisibility,
} from '@bike4mind/common';
import { type BaseStorage } from '@bike4mind/utils';
import {
  type ApiKeyTable,
  type ICompletionBackend,
  type ICompletionOptionTools,
  getLlmByModel,
} from '@bike4mind/llm-adapters';
import type { Logger } from '@bike4mind/observability';
import type { ServerAgentStore } from './agents/ServerAgentStore';
import type {
  ServerSubagentTracker,
  SubagentHandoffSignal,
  SubagentToolPermissions,
} from './agents/ServerSubagentOrchestrator';
import type { ModelAdmission } from './modelAdmission';
import { b4mTools, generateTools, type LlmTools } from './tools/index';
import type { ToolContext } from './tools/base/types';
import type { ToolDefinition } from './tools/base/types';
import { createDelegateToAgentTool, type SubagentUsageMeta } from './tools/implementation/delegateToAgent';
import { createCoordinateTaskTool } from './tools/implementation/coordinateTask';
import type { DagDispatcher, DagHandoffSignal } from './tools/implementation/coordinateTask';
import { isToolOfferable, type ToolAvailability } from './toolAvailability';
import { isVideoToolConfig } from './tools/implementation/videoGeneration';
import { isMusicToolConfig } from './tools/implementation/musicGeneration';
import { extractAndSaveEntitiesFromToolResult, shouldExtractEntitiesFromTool } from '../conversationContextService';
import type { MinimalSessionRepository } from '../conversationContextService/types';
import { notifyToolFinish } from './toolFinishObserver';
import { extractMcpPendingAction, type McpPendingAction } from './mcpPendingAction';
import { JIRA_LIST_ATTACHMENTS, CONFLUENCE_LIST_ATTACHMENTS } from '@bike4mind/mcp/atlassian/constants';
import { CURRENT_MODEL_DETAILS_TOOL_NAME } from './tools/implementation/currentModelDetails';

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
  /** The turn's active organization, forwarded to the tool context (see ToolContext.organizationId). */
  organizationId?: ToolContext['organizationId'];
  /** How the turn was authenticated, forwarded to the tool context (see ToolContext.authOrigin). */
  authOrigin: ToolContext['authOrigin'];
  /** The authenticating API key, forwarded to the tool context (see ToolContext.apiKeyId). */
  apiKeyId?: ToolContext['apiKeyId'];
  /** Generic retrieval-exclusion filter, forwarded to the tool context (see ToolContext.retrievalFilter). */
  retrievalFilter?: ToolContext['retrievalFilter'];
  /** Agent-scoped KB restriction, forwarded to the tool context (see ToolContext.kbScope). */
  kbScope?: ToolContext['kbScope'];
  /** Inlined-attachment ids, forwarded to the tool context (see ToolContext.inlinedAttachmentIds). */
  inlinedAttachmentIds?: ToolContext['inlinedAttachmentIds'];
  /** Attached file ids, forwarded to the tool context (see ToolContext.attachedFileIds). */
  attachedFileIds?: ToolContext['attachedFileIds'];
  /** Fully-inlined-attachment ids, forwarded to the tool context (see ToolContext.fullyInlinedAttachmentIds). */
  fullyInlinedAttachmentIds?: ToolContext['fullyInlinedAttachmentIds'];
  /** Personal-corpus lake suppression, forwarded to the tool context (see ToolContext.suppressLakeArms). */
  suppressLakeArms?: ToolContext['suppressLakeArms'];
  /** Session lake scope, forwarded to the tool context (see ToolContext.sessionRetrievalTags). */
  sessionRetrievalTags?: ToolContext['sessionRetrievalTags'];
  /** Reader opt-in consent, forwarded to the tool context (see ToolContext.sessionReaderConsentDatalakeTags). */
  sessionReaderConsentDatalakeTags?: ToolContext['sessionReaderConsentDatalakeTags'];
  /** Lake-scope sidecar, forwarded to the tool context (see ToolContext.sessionLakeScopeExplicit). */
  sessionLakeScopeExplicit?: ToolContext['sessionLakeScopeExplicit'];
  /** libraryFlagForScope(session), forwarded to the tool context (see ToolContext.sessionIncludeLibraryFiles). */
  sessionIncludeLibraryFiles?: ToolContext['sessionIncludeLibraryFiles'];
  /** Pre-authorized lake ids, forwarded to the tool context (see ToolContext.sessionPreauthorizedLakeIds). */
  sessionPreauthorizedLakeIds?: ToolContext['sessionPreauthorizedLakeIds'];
  /**
   * Sink for tool-internal LLM spend, forwarded to the tool context. The agent
   * executor wires this to fold nested tool generation into iteration billing (#630);
   * omit on hosts that don't bill nested tool spend to the customer (e.g. the chat
   * path). See ToolContext.onToolLlmUsage.
   */
  onToolLlmUsage?: ToolContext['onToolLlmUsage'];
  /** The `decide` tool's execution seam, forwarded to the tool context (see ToolContext.decide). */
  decide?: ToolContext['decide'];
  storage: BaseStorage;
  imageGenerateStorage: BaseStorage;
  imageProcessorLambdaName?: string;
  llm: ICompletionBackend;
  model?: string;
  /** See `ToolContext.servingModel`. */
  servingModel?: ToolContext['servingModel'];
  precomputed?: {
    adminSettingsEnforceCredits: boolean;
    models: ModelInfo[];
  };
  /**
   * The models a delegated subagent may run on, when narrower than `precomputed.models`
   * (which also prices media and tool usage, so it stays the full catalog). The Agent
   * Executor and the chat path pass the user's runnable models here; a subagent pinned to any
   * other model falls back to the parent's (see `ServerSubagentOrchestrator.resolveAgentRuntime`).
   */
  subagentModels?: ModelInfo[];
  apiKeyTable?: ApiKeyTable;
  thinking?: { enabled: boolean; budget_tokens: number };
  /** Reasoning visibility for the caller, applied by every subagent this run spawns. */
  thinkingVisibility?: ThinkingVisibility;
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
   * Tools a subagent can OPT INTO by explicitly naming them (or a matching
   * wildcard) in its `allowedTools`. Forwarded to `delegate_to_agent` /
   * `coordinate_task` and merged into the subagent's toolset via the
   * orchestrator's `optInTools` channel. Kept out of the parent's own toolbelt
   * (never added to `tools`), so launch-gated capabilities like Lattice reach a
   * delegated agent that asked for them without being forced on every run. Omit
   * for callers that expose no opt-in-only tools.
   */
  optInTools?: ICompletionOptionTools[];

  /**
   * Returns the current top-level execution id (used by `coordinate_task` to
   * persist DAG children with `parentExecutionId`). Required when
   * `dagDispatcher` is provided.
   */
  getCurrentExecutionId?: () => string;

  /**
   * Returns true when the calling user is at or over their organization's
   * per-member credit cap. Forwarded to `delegate_to_agent` and
   * `coordinate_task`'s in-process orchestrators. Omit for callers with no
   * organization context, or that already gate the whole request upstream
   * (see `ServerOrchestratorDeps.checkMemberCreditCap`).
   */
  checkMemberCreditCap?: () => boolean | Promise<boolean>;

  /**
   * Returns true when the payer cannot cover a subagent's first iteration on the given model;
   * forwarded like `checkMemberCreditCap`. Set by the agent executor when credits are enforced
   * (see `ServerOrchestratorDeps.checkInsufficientCredits`).
   */
  checkInsufficientCredits?: (model: string) => boolean | Promise<boolean>;

  /**
   * The run's tool-permission lists, set only by the agent executor (whose parent gate
   * uses the same lists). Forwarded to `delegate_to_agent` and `coordinate_task` so a
   * child's tool calls are classified like the parent's; see
   * `ServerOrchestratorDeps.toolPermissions`. Omitted by ungated callers.
   */
  toolPermissions?: SubagentToolPermissions;

  /**
   * The user's model admission, forwarded to `delegate_to_agent` and `coordinate_task` so an
   * in-process subagent's model is admitted; see `ServerOrchestratorDeps.modelAdmission`.
   */
  modelAdmission?: Pick<ModelAdmission, 'assert'>;
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
  onToolStart: (toolName: string, data: unknown) => Promise<void>;

  /** Called after a tool finishes (e.g., deep research state, image paths) */
  onToolFinish: (toolName: string, data: unknown) => Promise<void>;

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
  onPendingAction?: (action: McpPendingAction) => Promise<void>;

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

  /** Quest (turn) id, for lake-access audit rows to join back to their turn - see
   * ToolContext['questId']'s own doc comment for the agent-mode caveat. */
  questId?: string;
  slackDestination?: ToolContext['slackDestination'];

  /** See ToolContext['numberCitables']; the chat path supplies it for indexed-citation sessions. */
  numberCitables?: ToolContext['numberCitables'];

  /**
   * Bills a delegation's spend that no tracker bills (see `DelegateToAgentToolDeps.onCredits`);
   * meta carries cost attribution when resolvable.
   */
  onSubagentCredits?: (credits: number, meta?: SubagentUsageMeta) => void | Promise<void>;

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
  /**
   * The caller asked to be offered ONLY the tools it named, so server-side additions it never
   * named are withheld - today that means MCP tools, which are merged after the `enabledTools`
   * filter and are not part of it.
   *
   * This must be driven by an EXPLICIT caller signal, never inferred from `enabledTools` being
   * empty: an empty list is the ordinary chat payload (the web client defaults to `toolMode:
   * 'smart'` with an empty `tools` array), so treating it as a request for silence would strip
   * MCP tools from normal chat. Agent-only servers are exempt - they are never in the main
   * model's schemas, so withholding them would remove delegation capability rather than save the
   * caller anything.
   */
  offerOnlyNamedTools?: boolean;
  /**
   * Tool names the session forbids, in the same namespace the tool answers to - so an MCP tool is
   * named by its namespaced `server__tool` id.
   *
   * Every caller with a denylist should pass it, even one that also filters the returned array:
   * two things this function produces are unreachable from that array - agent-only MCP tools,
   * routed to the delegation pool instead of being returned, and `parentTools`, captured by the
   * delegate tool's closure. An offered (non-agent-only) MCP tool DOES appear in the returned
   * array, so a caller's own post-build filter reaches that one too - passing this option is
   * still required to close the other two.
   */
  sessionDisabledTools?: readonly string[];
  mcpToolsByServer?: Record<string, Array<{ name: string } & ICompletionOptionTools>>;
  config?: { [key in LlmTools]?: unknown };
  agentOnlyMcpServers?: string[];
  getAbortSignal?: () => AbortSignal | undefined;
  externalTools?: Record<string, ToolDefinition>;
  /**
   * Per-request key-gated tool availability (from `resolveToolAvailability`). Omitted ->
   * every enabled tool is offered unfiltered (callers that haven't wired it yet keep today's
   * behavior). Passed, a tool the caller enabled but that has no working key/config is dropped
   * from the schema sent to the model instead of reaching it and then throwing or refusing.
   */
  toolAvailability?: ToolAvailability;
  /**
   * Applied to the tools handed to in-process subagents (`parentTools`), before the denylist.
   * Callers pass the same wrapper they apply to the array this function returns for the parent.
   */
  wrapChildTools?: (tools: ICompletionOptionTools[]) => ICompletionOptionTools[];
}

/** Namespaced `server__tool` ids of the only tools whose `_attachmentList` result is trusted. */
const ATTACHMENT_LIST_SOURCE_BY_TOOL: ReadonlyMap<string, 'jira' | 'confluence'> = new Map([
  [`atlassian__${JIRA_LIST_ATTACHMENTS}`, 'jira'],
  [`atlassian__${CONFLUENCE_LIST_ATTACHMENTS}`, 'confluence'],
]);

// Sentinel types for wrapping. A tool may emit one of these generic
// optimization-console side-effects; the type must be allowlisted here so its
// payload is dispatched via onUiSideEffect (and the terse displayMessage replaces
// the model-visible result) rather than echoed back to the model.
// `populateDecomposition` loads a decomposed multi-step plan's first sub-problem.
// `populateScheduleRace` carries a solve tool's scheduling problem + its bounded race under a
// type distinct from `populateProblem`, so a client predating it ignores the race rather than
// persisting the wrapper as the brief (allowlisting it here is what lets the frame through).
const VALID_SIDE_EFFECT_TYPES = new Set([
  'populateProblem',
  'populateScheduleRace',
  'populateFamilyProblem',
  'populateDecomposition',
]);

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
    offerOnlyNamedTools = false,
    sessionDisabledTools,
    mcpToolsByServer = {},
    config = {},
    agentOnlyMcpServers = [],
    getAbortSignal,
    externalTools,
    toolAvailability,
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
    retrievalFilter,
    kbScope,
    inlinedAttachmentIds,
    attachedFileIds,
    fullyInlinedAttachmentIds,
    suppressLakeArms,
    sessionRetrievalTags,
    sessionReaderConsentDatalakeTags,
    sessionLakeScopeExplicit,
    sessionIncludeLibraryFiles,
    sessionPreauthorizedLakeIds,
    organizationId,
    authOrigin,
    apiKeyId,
  } = deps;

  // Merge built-in tools with any external tool definitions (e.g., Slack tools)
  const allToolDefinitions = externalTools ? { ...b4mTools, ...externalTools } : b4mTools;

  const llmToolDefinitions = generateTools(
    userId,
    user,
    logger,
    {
      db,
      retrievalFilter,
      kbScope,
      inlinedAttachmentIds,
      attachedFileIds,
      fullyInlinedAttachmentIds,
      suppressLakeArms,
      sessionRetrievalTags,
      sessionReaderConsentDatalakeTags,
      sessionLakeScopeExplicit,
      sessionIncludeLibraryFiles,
      sessionPreauthorizedLakeIds,
      organizationId,
      authOrigin,
      apiKeyId,
      questId: callbacks.questId,
      requestConfirmation: callbacks.onPendingAction,
      slackDestination: callbacks.slackDestination,
      numberCitables: callbacks.numberCitables,
      decide: deps.decide,
      getAbortSignal,
    },
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
      audio_generation: config.audio_generation,
      web_search: config.web_search,
      video_generation: config.video_generation,
      music_generation: config.music_generation,
    },
    model,
    imageProcessorLambdaName,
    allToolDefinitions,
    undefined, // allowedDirectories - not used in this path
    entitlementKeys ?? [],
    callbacks.sessionId,
    undefined, // codeMinifier - CLI-only (web-tree-sitter); server path has no minifier
    deps.precomputed?.models,
    deps.onToolLlmUsage,
    deps.servingModel
  );

  // The tool is inert without a usable config, so the config itself is the availability signal.
  const effectiveAvailability: ToolAvailability = {
    ...toolAvailability,
    video_generation: isVideoToolConfig(config.video_generation),
    music_generation: isMusicToolConfig(config.music_generation),
    // `decide` runs on its host's injected seam; a host that omits it must not offer a tool whose
    // every call would throw. Derived here, not in the deps literals, so no call site can forget.
    decide: toolAvailability?.decide !== false && deps.decide !== undefined,
  };

  // Filter to enabled tools only
  let tools: ICompletionOptionTools[] | undefined = undefined;
  if (enabledTools.length > 0) {
    const mappedTools = enabledTools
      .filter(tool => tool in llmToolDefinitions && isToolOfferable(tool, effectiveAvailability))
      .map(tool => llmToolDefinitions[tool]);

    // Ids namespaced to a CONNECTED server are excluded here even though they're not native
    // tools: they are handled by the MCP merge loop below, not skipped, so warning about them as
    // "undefined" would be a false positive on the one route (`session.enabledTools`) that can
    // name an MCP tool under `offerOnlyNamedTools`. Scoped to the servers actually in
    // `mcpToolsByServer` rather than to any id containing `__`, so a typo'd, stale, or
    // disconnected-server id still warns - those are exactly the cases the warning is for, and
    // under `offerOnlyNamedTools` they are why a caller gets silence instead of the tool it named.
    const connectedServerPrefixes = Object.keys(mcpToolsByServer).map(serverName => `${serverName}__`);
    const isConnectedMcpToolId = (tool: string) => connectedServerPrefixes.some(prefix => tool.startsWith(prefix));
    const undefinedTools = enabledTools.filter(tool => !llmToolDefinitions[tool] && !isConnectedMcpToolId(tool));
    if (undefinedTools.length > 0) {
      logger.warn(`Undefined tools requested (will be skipped): ${undefinedTools.join(', ')}`);
    }

    const unavailableTools = enabledTools.filter(
      tool => tool in llmToolDefinitions && !isToolOfferable(tool, effectiveAvailability)
    );
    if (unavailableTools.length > 0) {
      logger.info(`Enabled tools dropped as unavailable (no working key/config): ${unavailableTools.join(', ')}`);
    }

    tools = mappedTools.filter((tool): tool is ICompletionOptionTools => tool !== undefined);

    // Wrap navigate_view for navigation intent extraction
    if (enabledTools.includes('navigate_view') && tools && callbacks.onNavigationIntents) {
      wrapNavigateViewTool(tools, logger, callbacks.onNavigationIntents);
    }

    // Wrap all tools for sentinel extraction
    if (tools) {
      wrapToolsForSentinels(tools, logger, callbacks, userId);
    }
  }

  // Merge MCP tools.
  //
  // MCP tools are merged AFTER the native `enabledTools` filter and were never subject to it, so
  // no narrowing lever could reach them and a caller asking for a minimal tool profile still paid
  // for every schema its servers expose (#2960).
  //
  // The gate is `offerOnlyNamedTools`, an explicit caller signal - NOT `enabledTools` being empty.
  // An empty list is the ordinary chat payload (the web client defaults to `toolMode: 'smart'`
  // with an empty `tools` array and scopes MCP through `mcpServers` instead), so inferring intent
  // from it would strip MCP tools from normal chat.
  //
  // Agent-only servers are exempt on purpose: they are withheld from the main model's schemas
  // anyway, so they cost nothing the caller is trying to avoid, and dropping them here would
  // quietly remove delegation capability instead.
  const allMcpTools = Object.values(mcpToolsByServer).flat();
  logger.debug('[MCP] Merging MCP tools:', {
    mcpToolsCount: allMcpTools.length,
    mcpToolNames: allMcpTools.map(t => t.name),
    enabledToolsCount: enabledTools.length,
    offerOnlyNamedTools,
  });

  const agentOnlyMcpTools: ICompletionOptionTools[] = [];
  const namedToolNames = new Set(enabledTools);
  const deniedToolNames = new Set(sessionDisabledTools ?? []);
  const deniedMcpToolNames: string[] = [];
  const unnamedMcpToolNames: string[] = [];

  for (const [serverName, serverTools] of Object.entries(mcpToolsByServer)) {
    const isAgentOnly = agentOnlyMcpServers.includes(serverName);

    for (const item of serverTools) {
      // artifactType, endsTurnAfterText and validateResult are dropped: an MCP server is untrusted
      // output and must not unlock artifact markup, cut the model's follow-up round short, or
      // score its own results past the agent confidence gate.
      const {
        name,
        toolFn: originalToolFn,
        artifactType: _ignored,
        endsTurnAfterText: _ignoredEndsTurn,
        validateResult: _ignoredValidator,
        ...rest
      } = item;
      // Denied by name, not by server: a session may forbid one tool of a server it otherwise
      // uses. `name` is already the namespaced `server__tool` id, which is the id the denylist
      // speaks and the one the model would have seen.
      if (deniedToolNames.has(name)) {
        deniedMcpToolNames.push(name);
        continue;
      }
      if (offerOnlyNamedTools && !isAgentOnly && !namedToolNames.has(name)) {
        unnamedMcpToolNames.push(name);
        continue;
      }
      tools ??= [];

      const wrappedToolFn = createMcpToolWrapper(name, originalToolFn, logger, callbacks, deps);

      if (isAgentOnly) {
        agentOnlyMcpTools.push({ ...rest, toolFn: wrappedToolFn });
      } else {
        tools.push({ ...rest, toolFn: wrappedToolFn });
      }
    }
  }

  if (unnamedMcpToolNames.length > 0) {
    // Logged rather than dropped in silence: this is the branch where a connected server
    // contributes nothing, which otherwise reads as the server being broken.
    logger.info(
      `[MCP] Withholding ${unnamedMcpToolNames.length} unnamed MCP tools - the caller asked to be offered only ` +
        `the tools it named: ${unnamedMcpToolNames.join(', ')}`
    );
  }

  if (deniedMcpToolNames.length > 0) {
    logger.info(
      `[MCP] Dropped ${deniedMcpToolNames.length} session-disabled MCP tools: ${deniedMcpToolNames.join(', ')}`
    );
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

  // Filtered here rather than left to a caller's post-build pass: `parentTools` is captured by the
  // delegate tool's closure below, so it never appears in the array this function returns and a
  // denylist applied to that array cannot reach it. Without this, a session-forbidden tool stays
  // callable by a dispatched subagent - the same loophole the delegate gate exists to close.
  // current_model_details is bound to the parent's serving model, so a subagent on another model
  // must not inherit it (its adapter keeps its own identity line).
  const childTools = [...tools, ...agentOnlyMcpTools];
  const parentTools = (options.wrapChildTools ? options.wrapChildTools(childTools) : childTools).filter(
    tool => !deniedToolNames.has(tool.toolSchema.name) && tool.toolSchema.name !== CURRENT_MODEL_DETAILS_TOOL_NAME
  );

  const subagentModels = deps.subagentModels ?? deps.precomputed?.models;
  const subagentModelInfo = subagentModels?.find(m => m.id === model);
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
    onCredits: callbacks.onSubagentCredits,
    availableModels: subagentModels,
    onStatusUpdate: callbacks.onSubagentStatusUpdate
      ? async (status: string) => callbacks.onSubagentStatusUpdate!(status)
      : undefined,
    onTelemetry: callbacks.onSubagentTelemetry
      ? (telemetry: unknown) => callbacks.onSubagentTelemetry!(telemetry)
      : undefined,
    thinking: deps.thinking,
    thinkingVisibility: deps.thinkingVisibility,
    agentStore: deps.agentStore,
    apiKeyTable: deps.apiKeyTable ?? undefined,
    tracker: callbacks.subagentTracker,
    getRemainingTimeMs: deps.getRemainingTimeMs,
    handoffSignal: deps.handoffSignal,
    depth: deps.depth,
    optInTools: deps.optInTools,
    checkMemberCreditCap: deps.checkMemberCreditCap,
    checkInsufficientCredits: deps.checkInsufficientCredits,
    toolPermissions: deps.toolPermissions,
    modelAdmission: deps.modelAdmission,
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
      availableModels: subagentModels,
      onCredits: callbacks.onSubagentCredits,
      onStatusUpdate: callbacks.onSubagentStatusUpdate
        ? async (status: string) => callbacks.onSubagentStatusUpdate!(status)
        : undefined,
      thinking: deps.thinking,
      thinkingVisibility: deps.thinkingVisibility,
      agentStore: deps.agentStore,
      apiKeyTable: deps.apiKeyTable ?? undefined,
      tracker: callbacks.subagentTracker,
      getRemainingTimeMs: deps.getRemainingTimeMs,
      subagentHandoffSignal: deps.handoffSignal,
      dagDispatcher: deps.dagDispatcher,
      getParentExecutionId: deps.getCurrentExecutionId,
      dagHandoffSignal: deps.dagHandoffSignal,
      optInTools: deps.optInTools,
      checkMemberCreditCap: deps.checkMemberCreditCap,
      checkInsufficientCredits: deps.checkInsufficientCredits,
      toolPermissions: deps.toolPermissions,
      modelAdmission: deps.modelAdmission,
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

// ---------------------------------------------------------------------------
// Tool-finish observer (host seam)
// ---------------------------------------------------------------------------

// The seam itself lives in a dependency-free leaf module so the host can
// register an observer without tracing the tool registry into every route
// bundle. Re-exported here to keep the ./llm barrel surface unchanged.
export { setToolFinishObserver, type ToolFinishObservation } from './toolFinishObserver';

function wrapToolsForSentinels(
  tools: ICompletionOptionTools[],
  logger: Logger,
  callbacks: ToolBuilderCallbacks,
  userId?: string
): void {
  for (let i = 0; i < tools.length; i++) {
    const originalToolFn = tools[i].toolFn;
    const toolName = tools[i].toolSchema?.name || `tool-${i}`;
    const allowedArtifactType = resolveToolArtifactType(toolName, tools[i].artifactType);
    tools[i] = {
      ...tools[i],
      toolFn: async (args: unknown) => {
        const result = await originalToolFn(args);

        // Non-blocking host observer: sync, never awaited, exceptions swallowed
        // inside notifyToolFinish - zero added latency by contract.
        notifyToolFinish({ toolName, userId });

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
        if (
          callbacks.onArtifactExtracted &&
          allowedArtifactType !== undefined &&
          typeof result === 'string' &&
          result.includes('<artifact')
        ) {
          try {
            for (const { attrs: attrsStr, body: content } of scanArtifactTags(result, true)) {
              const attrs = parseToolArtifactAttributes(attrsStr);

              // Checked on the final value, so a repeated type= attribute cannot smuggle one past.
              if (attrs.type !== allowedArtifactType) {
                logger.warn(
                  `[toolArtifact] Dropped ${JSON.stringify(attrs.type?.slice(0, 80))} artifact from ${toolName}: not the type it emits`
                );
                continue;
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

    if (callbacks.onPendingAction) {
      const extraction = extractMcpPendingAction(name, result);
      if (extraction.kind === 'rejected') {
        logger.warn(`[MCP] Ignored _confirmToken from tool ${name}`, { reason: extraction.reason });
        return extraction.result;
      }
      if (extraction.kind === 'accepted') {
        logger.debug(`[MCP] Extracted pendingAction from tool ${name}:`, {
          tool: extraction.action.tool,
          ts: extraction.action.ts,
        });
        try {
          await callbacks.onPendingAction(extraction.action);
        } catch (saveErr) {
          logger.error(`[MCP] Failed to persist pendingAction from tool ${name}`, {
            error: saveErr instanceof Error ? saveErr.message : String(saveErr),
          });
        }
        return extraction.result;
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
          // Only the Atlassian list tools may mint a list the delete buttons act on; the source comes
          // from which tool ran, never from the (tool-controlled) payload.
          const attachmentListSource = ATTACHMENT_LIST_SOURCE_BY_TOOL.get(name);
          if (attachmentListSource && parsed._attachmentList === true && Array.isArray(parsed.attachments)) {
            logger.debug(`[MCP] Extracted attachment list from tool ${name}`, {
              source: attachmentListSource,
              count: parsed.attachments.length,
            });

            const attachmentList = {
              source: attachmentListSource,
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
            const sourceLabel = attachmentListSource === 'jira' ? 'Jira issue' : 'Confluence page';
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
