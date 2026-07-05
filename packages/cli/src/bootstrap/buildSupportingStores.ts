import type { ICompletionBackend, ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { Logger } from '@bike4mind/observability';
import type { CliConfig } from '../storage';
import type { CheckpointStore } from '../storage/CheckpointStore.js';
import type { ConfigStore } from '../storage';
import type { CustomCommandStore } from '../storage/CustomCommandStore.js';
import type { ApiClient } from '../auth/ApiClient';
import type { SandboxOrchestrator } from '../sandbox/SandboxOrchestrator.js';
import { generateCliTools, loadContextFiles, type AgentContext, type PermissionManager } from '../utils';
import { McpManager } from '../utils/mcpAdapter';
import { AgentStore } from '../agents/AgentStore.js';
import { SubagentOrchestrator } from '../agents/SubagentOrchestrator.js';
import { BackgroundAgentManager } from '../agents/BackgroundAgentManager.js';
import { deferredToolRegistry } from '../tools/deferredToolRegistry.js';
import type { UserQuestionPayload, UserQuestionResponse } from '@bike4mind/services';
import type { PermissionResponse } from '../components';
import type { SilentLogger } from './types.js';

/** B4M tool list shape returned by generateCliTools (carries `.toolSchema.name`). */
type CliToolList = Awaited<ReturnType<typeof generateCliTools>>['tools'];
type ContextResult = Awaited<ReturnType<typeof loadContextFiles>>;

export interface BuildSupportingStoresInput {
  config: CliConfig;
  llm: ICompletionBackend;
  modelId: string;
  permissionManager: PermissionManager;
  apiClient: ApiClient;
  configStore: ConfigStore;
  customCommandStore: CustomCommandStore;
  checkpointStore: CheckpointStore;
  sandboxOrchestrator: SandboxOrchestrator;
  additionalDirectories: string[];
  agentContext: AgentContext;
  promptFn: (toolName: string, args: unknown, preview?: string) => Promise<{ action: PermissionResponse }>;
  userQuestionFn: (payload: UserQuestionPayload) => Promise<UserQuestionResponse>;
  /** Startup log collected for the two-column banner; pushed into, not owned. */
  startupLog: string[];
  /** No-op logger created by the shell to avoid Ink re-renders. */
  silentLogger: SilentLogger;
  /** Background-agent status callback (wired to Zustand in the shell, kept out of this module). */
  onBackgroundStatusChange: Parameters<BackgroundAgentManager['setOnStatusChange']>[0];
  /** Background-agent group-completion callback (wired to Zustand in the shell). */
  onGroupCompletion: Parameters<BackgroundAgentManager['setOnGroupCompletion']>[0];
}

export interface SupportingStores {
  mcpManager: McpManager;
  agentStore: AgentStore;
  contextResult: ContextResult;
  mcpTools: ICompletionOptionTools[];
  loadedB4mTools: CliToolList;
  deferredB4mTools: CliToolList;
  orchestrator: SubagentOrchestrator;
  backgroundManager: BackgroundAgentManager;
}

/**
 * Build the supporting stores and orchestration the agent needs: CLI tools
 * (permission-wrapped + server-routed), MCP manager, agent store, context
 * files, the deferred-tool registry partition, the subagent orchestrator, and
 * the background-agent manager.
 *
 * Pure bootstrap seam: no React hooks, no Zustand state. React-owned values
 * (permission/user-question prompt functions, the agent context, and the
 * background-agent status callbacks) are passed in. Tool *assembly* that weaves
 * the React workflow-store refs (decision/blocker/review-gate tools) stays in
 * the shell; this module returns only the agent-construction materials.
 */
export async function buildSupportingStores(input: BuildSupportingStoresInput): Promise<SupportingStores> {
  const {
    config,
    llm,
    modelId,
    permissionManager,
    apiClient,
    configStore,
    customCommandStore,
    checkpointStore,
    sandboxOrchestrator,
    additionalDirectories,
    agentContext,
    promptFn,
    userQuestionFn,
    startupLog,
    silentLogger,
    onBackgroundStatusChange,
    onGroupCompletion,
  } = input;

  // Generate CLI-friendly tools with permission wrapping, server routing, and observation tracking
  const { tools: b4mTools } = await generateCliTools(
    config.userId,
    llm,
    modelId,
    permissionManager,
    promptFn,
    agentContext,
    configStore,
    apiClient,
    undefined, // toolFilter
    userQuestionFn,
    checkpointStore,
    sandboxOrchestrator,
    additionalDirectories
  );

  // Initialize MCP, agent store, and context files in parallel (all independent)
  // Supports both Claude Code convention (.claude/agents/) and B4M convention (.bike4mind/agents/)
  // Global dirs: ~/.claude/agents/, ~/.bike4mind/agents/
  // Project dirs: .claude/agents/, .bike4mind/agents/
  const mcpManager = new McpManager(config);
  const builtinAgentsDir = new URL('../agents/defaults/', import.meta.url).pathname;
  const agentProjectDir = configStore.getProjectConfigDir();
  const agentStore = new AgentStore(builtinAgentsDir, agentProjectDir || process.cwd());

  const [, , contextResult] = await Promise.all([
    mcpManager.initialize(),
    agentStore.loadAgents(),
    loadContextFiles(agentProjectDir),
  ]);

  const mcpTools = mcpManager.getTools();
  // Partition B4M tools into "always loaded" (touched in most sessions)
  // and "deferred" (rarely used - load on demand via tool_search). The
  // deferred set saves ~500-800 tokens of schema per turn for sessions
  // that don't use them. Same mechanism as MCP tools - see
  // packages/cli/src/tools/deferredToolRegistry.ts.
  const deferredB4mToolNames = new Set([
    'math_evaluate',
    'dice_roll',
    'current_datetime',
    'recent_changes',
    // Only the Cmd+P enhance-prompt flow invokes prompt_enhancement;
    // the agent itself rarely needs it. Defer to save its schema bytes.
    'prompt_enhancement',
  ]);
  const deferredB4mTools = b4mTools.filter(t => deferredB4mToolNames.has(t.toolSchema.name));
  const loadedB4mTools = b4mTools.filter(t => !deferredB4mToolNames.has(t.toolSchema.name));

  // Register MCP + deferred B4M tools together. MCP schemas are heavy
  // (~250-350 tokens each); the B4M set adds ~100-200 tokens per tool.
  deferredToolRegistry.register([...mcpTools, ...deferredB4mTools]);
  if (mcpTools.length > 0) {
    const toolCountByServer = mcpManager.getToolCount();
    const serverSummaries = toolCountByServer.map(s => `${s.serverName} (${s.count})`).join(', ');
    startupLog.push(
      `🛠️ Loaded ${loadedB4mTools.length} B4M + ${mcpTools.length} MCP tool(s, ${deferredB4mTools.length + mcpTools.length} deferred): ${serverSummaries}`
    );
  } else {
    const suffix = deferredB4mTools.length > 0 ? ` (${deferredB4mTools.length} deferred)` : '';
    startupLog.push(`🛠️ Loaded ${loadedB4mTools.length} B4M tool(s)${suffix}, no MCP tools`);
  }

  const agentSummary = agentStore.getSummary();
  startupLog.push(
    `🤖 Loaded ${agentSummary.total} agent(s): ` +
      `${agentSummary.builtin} built-in, ${agentSummary.global} global, ${agentSummary.project} project`
  );

  // Initialize subagent orchestrator with agent store
  const orchestrator = new SubagentOrchestrator({
    userId: config.userId,
    llm,
    // silentLogger is an ILogger-shaped no-op; SubagentOrchestrator types logger
    // as the concrete Logger class (with protected state) a plain object can't
    // satisfy structurally, so bridge through `unknown` rather than `any`.
    logger: silentLogger as unknown as Logger,
    permissionManager,
    showPermissionPrompt: promptFn,
    configStore,
    apiClient,
    agentStore,
    customCommandStore,
    enableParallelToolExecution: config.preferences.enableParallelToolExecution === true,
    showUserQuestion: userQuestionFn,
    checkpointStore,
  });

  // Create background agent manager
  const backgroundManager = new BackgroundAgentManager(orchestrator);
  backgroundManager.setOnStatusChange(onBackgroundStatusChange);
  backgroundManager.setOnGroupCompletion(onGroupCompletion);

  return {
    mcpManager,
    agentStore,
    contextResult,
    mcpTools,
    loadedB4mTools,
    deferredB4mTools,
    orchestrator,
    backgroundManager,
  };
}
