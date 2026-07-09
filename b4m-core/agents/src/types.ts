import type { IMessage } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import type { ICompletionBackend, ICompletionOptionTools } from '@bike4mind/llm-adapters';

/** A single message in a user/assistant conversation history */
export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Agent step types representing different stages of the ReAct loop
 */
export type AgentStepType = 'thought' | 'action' | 'observation' | 'final_answer';

/**
 * Individual step in the agent's reasoning process
 */
export interface AgentStep {
  /** Type of step in the ReAct loop */
  type: AgentStepType;
  /** Content of the step (thought text, action name, observation result, or final answer) */
  content: string;
  /** Additional metadata about this step */
  metadata?: {
    /** Name of the tool being used (for action steps) */
    toolName?: string;
    /** Input provided to the tool (for action steps) */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toolInput?: any;
    /** Timestamp when this step occurred */
    timestamp: number;
    /**
     * 0-indexed iteration this step belongs to. Stamped at emit time in
     * `runIteration` so persisted checkpoint steps can be grouped back into
     * iteration accordions on replay. Optional for backward
     * compatibility with checkpoints written before this field existed -
     * readers fall back to the step's sequential index.
     */
    iteration?: number;
    /** Token usage for this step */
    tokenUsage?: {
      prompt: number;
      completion: number;
      total: number;
    };
    /** Confidence score for this step's tool result (0.0 - 1.0) */
    confidence?: number;
    /** How the confidence score was determined */
    confidenceSource?: 'deterministic' | 'llm_self_report' | 'heuristic' | 'default';
  };
}

/**
 * Result returned after agent completes execution
 */
export interface AgentResult {
  /** Final answer/response from the agent */
  finalAnswer: string;
  /** All steps taken during execution */
  steps: AgentStep[];
  /** Completion information and metrics */
  completionInfo: {
    /** Total tokens used across all iterations */
    totalTokens: number;
    /** Total input tokens used across all iterations */
    totalInputTokens: number;
    /** Total output tokens used across all iterations */
    totalOutputTokens: number;
    /** Total B4M credits used across all iterations */
    totalCredits?: number;
    /** Total tokens served from prompt cache (90% cheaper than uncached) */
    totalCacheReadTokens?: number;
    /** Total tokens written to prompt cache (initial cache creation) */
    totalCacheWriteTokens?: number;
    /** Number of iterations performed */
    iterations: number;
    /** Number of tool calls made */
    toolCalls: number;
    /** Whether max iterations was reached */
    reachedMaxIterations: boolean;
    /** Whether the cumulative token ceiling (maxTotalTokens) was reached */
    reachedMaxTotalTokens?: boolean;
    /** Average confidence score across all tool executions (0.0 - 1.0) */
    averageConfidence?: number;
    /** Minimum confidence score encountered during execution */
    minConfidence?: number;
    /** Individual confidence scores per tool call for audit trail */
    confidenceLog?: Array<{
      toolName: string;
      confidence: number;
      source: 'deterministic' | 'llm_self_report' | 'heuristic' | 'default';
      timestamp: number;
    }>;
  };
}

/**
 * Configuration for the ReAct agent
 */
export interface AgentContext {
  /** User ID for tracking and permissions */
  userId: string;
  /** Logger instance for debugging and monitoring */
  logger: Logger;
  /** LLM backend to use for completions */
  llm: ICompletionBackend;
  /** Model ID to use (e.g., 'claude-3-5-sonnet-20241022') */
  model: string;
  /** Available tools the agent can use */
  tools: ICompletionOptionTools[];
  /** Maximum number of reasoning iterations (default: 50) */
  maxIterations?: number;
  /** Maximum tokens per completion (default: 4096) */
  maxTokens?: number;
  /**
   * Cumulative cap on total tokens (input + output) across the entire run.
   * When exceeded, the agent terminates with `reachedMaxTotalTokens=true` rather
   * than starting another iteration. Acts as a cost backstop independent of
   * iteration count. Default: undefined (no ceiling).
   */
  maxTotalTokens?: number;
  /** Temperature for LLM completions (default: 0.7) */
  temperature?: number;
  /** System prompt override (optional) */
  systemPrompt?: string;
  /**
   * Persona prompt PREPENDED to the system prompt (optional). Distinct from
   * `systemPrompt`, which fully replaces the default operational prompt: the
   * persona is composed in FRONT of the (default or overridden) operational
   * prompt so an Agent-mode run keeps the ReAct tool-use guidance while also
   * speaking in the agent's configured personality. See `getSystemPrompt()`.
   */
  personaPrompt?: string;
  /**
   * Artifact-emission guidance APPENDED to the system prompt (optional). Carries
   * the same instruction chat completions inject (chat's `ArtifactEmissionPrompt`
   * / `ARTIFACT_EMISSION_PROMPT`) so the agent wraps chart/code/HTML/SVG/Mermaid
   * output in `<artifact>` tags in its final answer. Composed AFTER persona and
   * the operational (default or overridden) prompt so both keep leading. The
   * host resolves it (gated on the admin `EnableArtifacts` setting) and only
   * passes it when the feature is on; when unset, behavior is unchanged. See
   * `getSystemPrompt()`.
   */
  artifactEmissionPrompt?: string;
  /** Force the model to use a specific tool or any tool */
  toolChoice?: 'auto' | 'required' | { type: 'function'; function: { name: string } };
  /** Extended thinking configuration (Anthropic models) */
  thinking?: { enabled: boolean; budget_tokens: number };
  /**
   * Resolver invoked when the model calls a tool that isn't in `tools`.
   * Returning a tool schema causes the agent to push it into `tools` and
   * return a retry hint to the model - the guessed call is NOT executed
   * (the model is told the tool is now available and asked to call it
   * again with proper arguments). Returning null falls through to the
   * standard "Tool not found" observation. Used by hosts (e.g. the CLI)
   * that defer rarely-used tool schemas and load them on demand. The
   * default behavior (no resolver) is unchanged.
   */
  unknownToolResolver?: (toolName: string) => Promise<ICompletionOptionTools | null>;
}

/**
 * Event types emitted by the agent during execution
 */
export interface AgentEvents {
  /** Emitted when agent produces a thought */
  thought: (step: AgentStep) => void;
  /** Emitted when agent decides to take an action */
  action: (step: AgentStep) => void;
  /** Emitted when agent receives an observation from a tool */
  observation: (step: AgentStep) => void;
  /** Emitted when agent produces final answer */
  final_answer: (step: AgentStep) => void;
  /** Emitted when agent execution completes */
  complete: (result: AgentResult) => void;
  /** Emitted when an error occurs */
  error: (error: Error) => void;
  /** Emitted for streaming text chunks */
  stream: (text: string) => void;
  /**
   * Emitted for incremental token deltas during an LLM iteration so consumers
   * can render partial responses live. Fires multiple times per iteration when
   * the underlying LLM call streams; `iteration` is 0-indexed (matches
   * AgentStep.metadata.iteration). Suppressed when `stream: false`.
   */
  text_delta: (info: { delta: string; iteration: number }) => void;
  /** Emitted when confidence gate pauses execution for human review */
  gate_paused: (decision: ConfidenceGateDecision & { iteration: number }) => void;
  /** Emitted when confidence gate sets a timed auto-approval */
  gate_timed: (decision: ConfidenceGateDecision & { iteration: number }) => void;
  /** Emitted when confidence gate allows autonomous continuation */
  gate_proceed: (decision: ConfidenceGateDecision & { iteration: number }) => void;
}

/**
 * Options for running the agent
 */
/** Confidence gate decision returned by the gate callback */
export interface ConfidenceGateDecision {
  action: 'proceed' | 'wait_for_human' | 'timed_gate';
  confidence: number;
  timedGateDelayMs?: number;
  reason: string;
}

export interface AgentRunOptions {
  /** Override max iterations for this run */
  maxIterations?: number;
  /** Override temperature for this run */
  temperature?: number;
  /** Override max tokens for this run */
  maxTokens?: number;
  /** Override cumulative token ceiling for this run. See AgentContext.maxTotalTokens. */
  maxTotalTokens?: number;
  /** Additional context to include in the prompt */
  context?: string;
  /**
   * Previous conversation messages to maintain context. Typed as IMessage[] so
   * callers can replay rich content (tool_use / tool_result / image blocks), not
   * just plain strings. Plain { role, content: string } objects still satisfy
   * this, so existing callers are unaffected.
   */
  previousMessages?: IMessage[];
  signal?: AbortSignal;
  /** Enable parallel execution of read-only tools for performance improvement */
  parallelExecution?: boolean;
  /** Custom function to determine if a tool is read-only (defaults to built-in check) */
  isReadOnlyTool?: (toolName: string) => boolean;
  /**
   * Confidence gate callback. Called after each iteration with the average confidence
   * of tool results from that iteration. Return a decision to proceed, pause, or timed-gate.
   * If not provided, the agent always proceeds (original behavior).
   */
  confidenceGate?: (iterationConfidence: number, iterationIndex: number) => ConfidenceGateDecision;
  /**
   * Enable prompt caching for system prompt and tool definitions.
   * Reduces input token cost by ~90% on cached portions across iterations.
   * Defaults to false.
   */
  enableCaching?: boolean;
  /**
   * Max number of recent iterations to keep in full in the conversation history.
   * Older iterations are trimmed to reduce input token accumulation.
   * Also trims the steps array to prevent unbounded growth.
   * 0 = keep all (no trimming). Defaults to 4.
   */
  maxHistoryIterations?: number;
  /**
   * Delay in milliseconds between iterations. Useful for throttling agents
   * that are exploring without a specific task (e.g., idle tavern agents).
   * 0 = no delay (default).
   */
  iterationDelayMs?: number;
}

/**
 * Serialized snapshot of a ReActAgent's execution state.
 *
 * Used to persist agent progress between Lambda invocations in serverless
 * environments. A checkpoint captures everything needed to resume execution
 * from the exact point where it was saved - including conversation history,
 * execution trace, token metrics, and confidence data.
 *
 * @see ReActAgent.toCheckpoint()
 * @see ReActAgent.fromCheckpoint()
 */
export interface AgentCheckpoint {
  /** Current iteration count (0-indexed: 0 means no iterations completed yet) */
  iteration: number;
  /** Conversation history (system prompt + user query + tool call/result messages) */
  messages: IMessage[];
  /** Execution trace (thought, action, observation, final_answer steps) */
  steps: AgentStep[];
  /** Cumulative token usage */
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  /** Cumulative credit usage */
  totalCredits: number;
  /** Total tool calls executed */
  toolCallCount: number;
  /** Full confidence audit trail */
  confidenceLog: Array<{
    toolName: string;
    confidence: number;
    source: 'deterministic' | 'llm_self_report' | 'heuristic' | 'default';
    timestamp: number;
  }>;
  /** Confidence scores from the most recent iteration (reset each iteration) */
  iterationConfidences: number[];
  /**
   * Length of the initial messages array (system + previousMessages + user query)
   * before any ReAct iteration messages were appended. Used to protect the
   * conversation prefix during trimming. Optional for backward compatibility
   * with checkpoints written before this field existed.
   */
  initialMessageCount?: number;
  /**
   * Provider stop reason of the last LLM completion; persisted to
   * `promptMeta.finishReason` for chat parity. Optional for backward
   * compatibility with checkpoints written before this field existed.
   */
  finishReason?: string;
}

/**
 * Result of a single agent iteration via `runIteration()`.
 *
 * Gives the caller (e.g., Agent Executor Lambda) control over the execution loop:
 * checkpoint after each iteration, stream progress, check timeout watchdog,
 * and self-dispatch between iterations.
 */
export interface IterationResult {
  /** The primary step produced by this iteration (final_answer, thought, or observation) */
  step: AgentStep;
  /** All steps produced during this iteration (may include thought + multiple action/observation pairs) */
  allSteps: AgentStep[];
  /** Whether the agent has finished (produced a final answer or reached max iterations) */
  isComplete: boolean;
  /** Serialized state for persistence after this iteration */
  checkpoint: AgentCheckpoint;
  /** Whether max iterations was reached (only true when isComplete is also true) */
  reachedMaxIterations: boolean;
  /** Whether the cumulative token ceiling was reached (only true when isComplete is also true) */
  reachedMaxTotalTokens?: boolean;
}

/**
 * Thoroughness level for subagent execution
 */
export type ThoroughnessLevel = 'quick' | 'medium' | 'very_thorough';

/**
 * Configuration for a specialized subagent
 */
export interface SubagentConfig {
  /** Type of subagent (e.g., 'explore', 'plan', 'code_review') */
  type: string;
  /** Model to use (e.g., 'claude-3-5-haiku-20241022') */
  model?: string;
  /** Custom system prompt for this subagent */
  systemPrompt?: string;
  /** Tools that this subagent is allowed to use (whitelist) */
  allowedTools?: string[];
  /** Tools that this subagent is NOT allowed to use (blacklist) */
  deniedTools?: string[];
  /** Maximum iterations by thoroughness level */
  maxIterations?: {
    quick: number;
    medium: number;
    very_thorough: number;
  };
  /** Default thoroughness level */
  defaultThoroughness?: ThoroughnessLevel;
}

/**
 * Extended agent context with subagent support
 */
export interface SubagentContext extends AgentContext {
  /** Subagent configuration */
  subagentConfig?: SubagentConfig;
  /** Parent session ID if this is a subagent */
  parentSessionId?: string;
  /** Thoroughness level for this execution */
  thoroughness?: ThoroughnessLevel;
}

/**
 * Server-side agent definition (no filesystem/hooks concepts)
 *
 * Used by the server-side SubagentOrchestrator to define
 * hardcoded or DB-backed agent configurations.
 */
export interface ServerAgentDefinition {
  /** Agent name (e.g., 'explore', 'plan', 'code_review') */
  name: string;
  /** Short description of what this agent does */
  description: string;
  /** Model to use (e.g., 'claude-3-5-haiku-20241022') */
  model: string;
  /** System prompt template (may contain $TASK and $VARIABLE placeholders) */
  systemPrompt: string;
  /** Tools that this agent is allowed to use (whitelist with wildcard support) */
  allowedTools?: string[];
  /** Tools that this agent is NOT allowed to use (blacklist with wildcard support) */
  deniedTools?: string[];
  /** Maximum iterations per thoroughness level */
  maxIterations: {
    quick: number;
    medium: number;
    very_thorough: number;
  };
  /** Default thoroughness level */
  defaultThoroughness: ThoroughnessLevel;
  /** Default variable values for prompt substitution */
  defaultVariables?: Record<string, string>;
  /**
   * MCP server names whose tools are exclusive to this agent.
   * These tools will NOT be exposed to the main/parent LLM - only to this subagent via delegation.
   */
  exclusiveMcpServers?: string[];
  /**
   * Ordered list of fallback model IDs to try if the primary model fails
   * (e.g., due to deprecation, rate limiting, or unavailability).
   */
  fallbackModels?: string[];
}

/**
 * Mapping from Slack persona names to allowed sub-agent names.
 *
 * When a persona (e.g., @dev) triggers an AI request, only the listed sub-agents
 * are available for delegation. This prevents e.g. @dev from delegating to the
 * project_manager agent (Jira/Confluence).
 *
 * Personas not listed here (e.g., 'agent') have no filter - all agents are available.
 */
export const PERSONA_ALLOWED_SUBAGENTS: Record<string, string[]> = {
  dev: ['github_manager', 'code_review'],
  pm: ['project_manager', 'code_review'],
  analyst: ['analyst', 'code_review'],
  researcher: ['researcher', 'code_review'],
};

/**
 * Optional configuration passed to agent factory functions.
 *
 * Allows overriding defaults at construction time (e.g., model, thoroughness).
 */
export interface ServerAgentConfig {
  /** Override the default model */
  model?: string;
  /** Override the default thoroughness */
  defaultThoroughness?: ThoroughnessLevel;
  /** Additional denied tools to append */
  extraDeniedTools?: string[];
  /** Additional allowed tools to append */
  extraAllowedTools?: string[];
  /** Repositories the user has selected for GitHub AI access (e.g., "- owner/repo") */
  selectedRepositories?: string;
  /** The user's GitHub username (from mcpServer.metadata.githubLogin) */
  githubUsername?: string;
}
