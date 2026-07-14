/**
 * Type definitions for the Unified Markdown-Based Agent System
 *
 * This module defines types for:
 * - Agent definitions parsed from markdown files
 * - Frontmatter schema for agent configuration
 * - Lifecycle hooks for agents
 * - Tool filtering patterns
 */

import { z } from 'zod';
import { ChatModels } from '@bike4mind/common';

// Re-export ThoroughnessLevel from @bike4mind/agents for convenience
export type { ThoroughnessLevel } from '@bike4mind/agents';

/**
 * Hook event types for agent lifecycle
 */
export type AgentHookEvent = 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'Stop';

/**
 * A single hook definition
 */
export interface HookDefinition {
  type: 'command' | 'prompt';
  /** Shell command to execute (for type: command) */
  command?: string;
  /** LLM prompt for evaluation (for type: prompt) */
  prompt?: string;
  /** Timeout in seconds (default: 60) */
  timeout?: number;
}

/**
 * A hook matcher with its hooks
 */
export interface HookMatcher {
  /** Regex pattern for tool name (optional for Stop event) */
  matcher?: string;
  /** Hooks to execute when matcher matches */
  hooks: HookDefinition[];
}

/**
 * Hooks configuration in agent frontmatter
 */
export interface AgentHooks {
  PreToolUse?: HookMatcher[];
  PostToolUse?: HookMatcher[];
  PostToolUseFailure?: HookMatcher[];
  Stop?: HookMatcher[];
}

/**
 * Hook execution result
 */
export interface HookResult {
  decision: 'allow' | 'deny' | 'block' | 'ask';
  reason?: string;
  updatedInput?: Record<string, unknown>;
}

/**
 * Error thrown when a hook blocks tool execution
 *
 * This error is used to stop the agent gracefully when a PreToolUse
 * or PostToolUse hook returns a 'block' decision.
 */
export class HookBlockedError extends Error {
  toolName: string;

  constructor(toolName: string, reason?: string) {
    super(`Hook blocked execution of ${toolName}: ${reason || 'No reason provided'}`);
    this.name = 'HookBlockedError';
    this.toolName = toolName;
  }
}

/**
 * Tools that are ALWAYS denied for spawned agents
 * Prevents agent chaining and other dangerous patterns
 */
export const ALWAYS_DENIED_FOR_AGENTS = [
  'agent_delegate', // No agent chaining
  'create_dynamic_agent', // No recursive agent creation
  'coordinate_task', // No recursive coordination loops
  'resume_agent', // Resume is orchestrator-only; subagents cannot resume sessions
] as const;

/**
 * Maximum nesting depth for spawned agents (fail-closed recursion cap).
 *
 * Depth convention: the main agent is depth 0, an agent it spawns is depth 1,
 * an agent that agent spawns is depth 2, and so on. `delegateToAgent` rejects
 * any spawn whose depth would be >= this value.
 *
 * ALWAYS_DENIED_FOR_AGENTS already caps the common paths (subagents cannot call
 * the delegation tools), so today the only way past depth 1 is a forking skill
 * invoked from within a subagent. A value of 3 preserves that existing nesting
 * (depths 1 and 2 allowed) while bounding runaway recursion, and fails closed if
 * a future tool or dynamic-agent path reopens delegation to subagents.
 */
export const MAX_SUBAGENT_DEPTH = 3;

/**
 * Source location of an agent definition
 */
export type AgentSource = 'builtin' | 'global' | 'project' | 'dynamic';

/**
 * Retry configuration for agent execution
 */
export interface RetryConfig {
  /** Maximum number of retry attempts (default: 2) */
  maxRetries: number;
  /** Initial delay in milliseconds before first retry (default: 1000) */
  initialDelayMs: number;
}

/**
 * Default retry configuration for agent execution
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 2,
  initialDelayMs: 1000,
};

/**
 * Parsed agent definition from markdown file
 */
export interface AgentDefinition {
  /** Agent name (derived from filename) */
  name: string;

  /** Short description */
  description: string;

  /** Model to use (e.g., 'claude-3-5-haiku-20241022') */
  model: string;

  /** System prompt template (markdown body, may contain $VARIABLES) */
  systemPrompt: string;

  /** Allowed tools - whitelist with wildcard support (e.g., 'mcp__github__*') */
  allowedTools?: string[];

  /** Denied tools - blacklist with wildcard support */
  deniedTools?: string[];

  /** Allowed skills - whitelist of skill names agent can access */
  skills?: string[];

  /** Max iterations per thoroughness level */
  maxIterations: {
    quick: number;
    medium: number;
    very_thorough: number;
  };

  /** Default thoroughness for this agent */
  defaultThoroughness: 'quick' | 'medium' | 'very_thorough';

  /** Default variable values for substitution */
  defaultVariables?: Record<string, string>;

  /** Lifecycle hooks */
  hooks?: AgentHooks;

  /** Source location (builtin, global, or project) */
  source: AgentSource;

  /** Full file path to the agent markdown file */
  filePath: string;

  /** Whether the model was successfully resolved from alias/ID (false = fell back to default) */
  modelResolved: boolean;

  /** Retry configuration for transient failure handling */
  retry: RetryConfig;

  /** Shared context access permissions: 'read', 'write', or both */
  sharedContext?: SharedContextAccess[];
}

/**
 * Access mode for shared agent context
 */
export type SharedContextAccess = 'read' | 'write';

/**
 * Frontmatter schema for agent markdown files (raw YAML structure)
 */
export interface AgentFrontmatter {
  description: string;
  model?: string;
  'allowed-tools'?: string[];
  'denied-tools'?: string[];
  skills?: string[];
  'max-iterations'?: {
    quick?: number;
    medium?: number;
    very_thorough?: number;
  };
  'default-thoroughness'?: 'quick' | 'medium' | 'very_thorough';
  variables?: Record<string, string>;
  hooks?: AgentHooks;
  retry?: {
    maxRetries?: number;
    initialDelay?: number;
  };
  'shared-context'?: SharedContextAccess[];
}

// ============================================================================
// Zod Schemas for Validation
// ============================================================================

/**
 * Schema for a command hook definition
 */
const CommandHookSchema = z.object({
  type: z.literal('command'),
  command: z.string().min(1, 'Command is required for command hooks'),
  timeout: z.number().optional(),
});

/**
 * Schema for a prompt hook definition
 */
const PromptHookSchema = z.object({
  type: z.literal('prompt'),
  prompt: z.string().min(1, 'Prompt is required for prompt hooks'),
  timeout: z.number().optional(),
});

/**
 * Schema for a single hook definition (discriminated union)
 * Ensures command hooks require 'command' field and prompt hooks require 'prompt' field
 */
export const HookDefinitionSchema = z.discriminatedUnion('type', [CommandHookSchema, PromptHookSchema]);

/**
 * Schema for a hook matcher with its hooks
 */
export const HookMatcherSchema = z.object({
  matcher: z.string().optional(),
  hooks: z.array(HookDefinitionSchema),
});

/**
 * Schema for agent hooks configuration
 */
export const AgentHooksSchema = z
  .object({
    PreToolUse: z.array(HookMatcherSchema).optional(),
    PostToolUse: z.array(HookMatcherSchema).optional(),
    PostToolUseFailure: z.array(HookMatcherSchema).optional(),
    Stop: z.array(HookMatcherSchema).optional(),
  })
  .optional();

/**
 * Schema for validating agent frontmatter
 */
export const AgentFrontmatterSchema = z.object({
  description: z.string().min(1, 'Agent description is required'),
  model: z.string().optional(),
  'allowed-tools': z.array(z.string()).optional(),
  'denied-tools': z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  'max-iterations': z
    .object({
      quick: z.int().positive().optional(),
      medium: z.int().positive().optional(),
      very_thorough: z.int().positive().optional(),
    })
    .optional(),
  'default-thoroughness': z.enum(['quick', 'medium', 'very_thorough']).optional(),
  variables: z.record(z.string(), z.string()).optional(),
  hooks: AgentHooksSchema,
  retry: z
    .object({
      maxRetries: z.int().nonnegative().optional(),
      initialDelay: z.number().positive().optional(),
    })
    .optional(),
  'shared-context': z.array(z.enum(['read', 'write'])).optional(),
});

/**
 * Default iteration limits for agents
 */
export const DEFAULT_MAX_ITERATIONS = {
  quick: 4,
  medium: 10,
  very_thorough: 20,
} as const;

/**
 * Default model for agents
 */
export const DEFAULT_AGENT_MODEL = ChatModels.CLAUDE_4_5_HAIKU;

/**
 * Default thoroughness level
 */
export const DEFAULT_THOROUGHNESS = 'medium' as const;

/**
 * Status of a background agent job
 */
export type BackgroundAgentStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * A background agent job tracked by BackgroundAgentManager
 */
export interface BackgroundAgentJob {
  /** Unique job ID (e.g. "bg-abc123") */
  id: string;
  /** Name of the agent running this job */
  agentName: string;
  /** Task description */
  task: string;
  /** Current status */
  status: BackgroundAgentStatus;
  /** Start timestamp (ms) */
  startTime: number;
  /** End timestamp (ms) */
  endTime?: number;
  /** Result summary (available when completed) */
  resultSummary?: string;
  /** Total tokens used by this job (available when completed) */
  totalTokens?: number;
  /** Total B4M credits used by this job (available when completed) */
  totalCredits?: number;
  /** Error message (available when failed) */
  error?: string;
  /** Groups jobs spawned in the same LLM turn for consolidated notifications */
  turnId?: string;
  /** Description of the group this job belongs to (for UI display) */
  groupDescription?: string;
}
