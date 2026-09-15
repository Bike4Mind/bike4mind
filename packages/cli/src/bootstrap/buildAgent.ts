import type { ICompletionBackend, ICompletionOptionTools } from '@bike4mind/llm-adapters';
import { ReActAgent } from '@bike4mind/agents';
import type { Logger } from '@bike4mind/observability';
import type { CliConfig } from '../storage';
import type { CustomCommandStore } from '../storage/CustomCommandStore.js';
import { buildSystemPrompt, type PromptVariant } from '../core/prompts';
import { getPlanModeFilePath } from '../utils/planMode.js';
import type { AgentContext } from '../utils';
import { AgentStore } from '../agents/AgentStore.js';
import { deferredToolRegistry } from '../tools/deferredToolRegistry.js';
import type { BuildPromptForMode, InteractionMode, SilentLogger } from './types.js';

export interface BuildAgentInput {
  config: CliConfig;
  modelId: string;
  /** LLM already wrapped with FallbackLlmBackend + NotifyingLlmBackend in the shell. */
  notifyingLlm: ICompletionBackend;
  allTools: ICompletionOptionTools[];
  /** Shared observation-tracking context; `currentAgent` is set here after construction. */
  agentContext: AgentContext;
  /** Holder wired to the agent's live tools array so the tool_search closure resolves. */
  agentToolsRef: { current: ICompletionOptionTools[] | null };
  silentLogger: SilentLogger;
  sessionId: string;
  initialInteractionMode: InteractionMode;
  // System-prompt building inputs (all plain values / passed collaborators):
  contextContent: string;
  agentStore: AgentStore;
  customCommandStore: CustomCommandStore;
  enableSkillTool: boolean;
  additionalDirectories: string[];
  featureModulePrompts: string;
}

export interface BuildAgentResult {
  agent: ReActAgent;
  /**
   * Rebuilds the system prompt for a given interaction mode. Returned so the
   * shell can register the Zustand interaction-mode subscription (which lives
   * in the React component, not here) to hot-swap the prompt on Shift+Tab.
   */
  buildPromptForMode: BuildPromptForMode;
}

/**
 * Construct the main ReAct agent with the system prompt selected by config
 * variant, wire the tool_search closure to the agent's live tools array, and
 * record the agent in the shared observation context.
 *
 * Pure bootstrap seam: no React hooks, no Zustand state. The interaction-mode
 * subscription (`useCliStore.subscribe`) stays in the shell and uses the
 * returned `buildPromptForMode`. Ordering is load-bearing: agent built ->
 * agentToolsRef wired -> agentContext.currentAgent set, all here, before the
 * shell registers the subscription (which guards on currentAgent === agent).
 */
export function buildAgent(input: BuildAgentInput): BuildAgentResult {
  const {
    config,
    modelId,
    notifyingLlm,
    allTools,
    agentContext,
    agentToolsRef,
    silentLogger,
    sessionId,
    initialInteractionMode,
    contextContent,
    agentStore,
    customCommandStore,
    enableSkillTool,
    additionalDirectories,
    featureModulePrompts,
  } = input;

  // Create ReAct agent with system prompt selected by config variant.
  // 'minimal' is opt-in via config.preferences.promptVariant - see
  // packages/cli/src/core/prompts.ts for the variants.
  const promptVariant: PromptVariant = config.preferences.promptVariant ?? 'current';
  // Closure that rebuilds the system prompt for the current interaction mode.
  // Reused below to hot-swap the prompt when the user cycles into/out of plan mode.
  const buildPromptForMode: BuildPromptForMode = mode =>
    buildSystemPrompt(promptVariant, {
      contextContent,
      agentStore,
      customCommands: customCommandStore.getAllCommands(),
      enableSkillTool,
      enableDynamicAgentCreation: config.preferences.enableDynamicAgentCreation === true,
      additionalDirectories,
      featureModulePrompts: featureModulePrompts || undefined,
      planModeFilePath: mode === 'plan' ? getPlanModeFilePath(sessionId) : undefined,
      appendSystemPrompt: process.env.B4M_APPEND_SYSTEM_PROMPT,
      deferredToolNames: deferredToolRegistry.getDirectoryNames(),
    });
  const cliSystemPrompt = buildPromptForMode(initialInteractionMode);

  // Use maxIterations from config (null = infinite, use very large number to avoid agent default of 5)
  const maxIterations = config.preferences.maxIterations === null ? 999999 : config.preferences.maxIterations;

  const agent = new ReActAgent({
    userId: config.userId,
    // silentLogger is an ILogger-shaped no-op; AgentContext.logger is typed as
    // the concrete Logger class (with protected state) a plain object can't
    // satisfy structurally, so bridge through `unknown` rather than `any`.
    logger: silentLogger as unknown as Logger,
    llm: notifyingLlm,
    model: modelId,
    tools: allTools,
    maxIterations,
    maxTokens: config.preferences.maxTokens,
    temperature: config.preferences.temperature,
    systemPrompt: cliSystemPrompt,
    // Auto-resolve unknown tool names against the deferred MCP registry.
    // If the model calls an MCP tool without first using tool_search,
    // the schema gets loaded and the model is asked to retry.
    unknownToolResolver: async (toolName: string) => deferredToolRegistry.get(toolName) ?? null,
  });
  // Wire the tool_search closure to the agent's live tools array.
  // ReActAgent.getTools() returns the array reference that the agent
  // reads each iteration - pushing into it makes new schemas callable.
  agentToolsRef.current = agent.getTools();

  // Set agent in context so tool wrappers can queue observations
  agentContext.currentAgent = agent;

  return { agent, buildPromptForMode };
}
