/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AgentStep, SubagentConfig, ThoroughnessLevel } from '@bike4mind/agents';
import type { MessageContentObject } from '@bike4mind/common';
import type { SandboxConfig, PartialSandboxConfig } from '../sandbox/types.js';

/**
 * Message in a conversation
 */
export interface Message {
  id: string; // Unique identifier for React reconciliation
  role: 'user' | 'assistant' | 'system';
  content: string;
  /**
   * Lossless structured content blocks for this turn (tool_use / tool_result /
   * text / image). When present, this is the rich record used to rebuild LLM
   * context; `content` stays the display/back-compat string (the final answer
   * or the user's text). Absent on legacy sessions and on plain turns with no
   * tool activity - readers fall back to `content` in that case.
   */
  richContent?: MessageContentObject[];
  timestamp: string;
  metadata?: {
    tokenUsage?: {
      prompt: number;
      completion: number;
      total: number;
    };
    cost?: number;
    creditsUsed?: number; // B4M credits used for this message
    steps?: AgentStep[];
    model?: string;
    permissionDenied?: boolean; // True if this message ended due to permission denial
    cancelled?: boolean; // True if this message/operation was cancelled by user
    isContinuation?: boolean; // True if this is a continuation message (renders without header)
    // Subagent execution metadata
    subagentExecution?: {
      type: string; // 'explore' | 'plan' | 'code_review'
      thoroughness: string; // 'quick' | 'medium' | 'very_thorough'
      fullSteps: AgentStep[]; // Complete subagent execution trace
      summary: string; // Condensed summary for parent context
    };
  };
}

/**
 * A significant decision logged during a session with rationale for audit trail.
 */
export interface WorkflowDecision {
  id: string;
  timestamp: string;
  /** What was decided */
  summary: string;
  /** Why this decision was made */
  rationale: string;
  /** What alternatives were considered */
  alternatives?: string[];
  /** What triggered this decision */
  context?: string;
}

/**
 * A blocker preventing progress, with optional resolution.
 */
export interface WorkflowBlocker {
  id: string;
  createdAt: string;
  resolvedAt?: string;
  description: string;
  resolution?: string;
  status: 'open' | 'resolved';
}

/**
 * Structured handoff state for session continuity.
 * Generated at session end so the next session can resume with full context.
 */
export interface SessionHandoff {
  summary: string;
  keyFindings: string[];
  nextSteps: string[];
  pendingDecisions: string[];
  blockers: string[];
  generatedAt: string;
}

/**
 * A review gate entry - AI paused for human approval at a decision point.
 */
export interface ReviewGateEntry {
  id: string;
  timestamp: string;
  description: string;
  /**
   * Resolution state. `'pending'` is reserved for a future remote-resolver
   * path (e.g. tavern bridge) where a gate could be observed mid-flight; the
   * local tool only ever writes `'approved' | 'rejected'`.
   */
  status: 'pending' | 'approved' | 'rejected';
  resolvedAt?: string;
  userNote?: string;
  /** Alternatives the user was shown - preserved for the audit trail. */
  options?: string[];
  /** AI's recommended path at the time of the gate - preserved for the audit trail. */
  recommendation?: string;
}

/**
 * Durable workflow state for a session.
 * Tracks decisions, blockers, handoff, and review gates across the session lifecycle.
 */
export interface WorkflowState {
  decisions: WorkflowDecision[];
  blockers: WorkflowBlocker[];
  handoff?: SessionHandoff;
  reviewGates?: ReviewGateEntry[];
}

/**
 * Conversation session
 */
export interface Session {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  messages: Message[];
  metadata: {
    totalTokens: number;
    totalCost: number;
    totalCredits?: number; // Total B4M credits used in this session
    toolCallCount: number;
    // Subagent execution tracking (spawned agents: agent_delegate, skills, background jobs)
    subagentCalls?: number;
    subagentTokens?: number;
    /** Total B4M credits consumed by spawned agents (same unit as totalCredits) */
    subagentCost?: number;
    /** Per-agent usage breakdown, keyed by agent name (for /usage) */
    subagentUsage?: Record<string, { calls: number; tokens: number; credits: number }>;
    // Compaction tracking
    compactedFrom?: string; // Original session ID if this is a compacted session
    // Durable workflow state (Q-inspired agentic patterns)
    workflow?: WorkflowState;
  };
}

/**
 * Authentication tokens from OAuth device flow
 */
export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: string; // ISO 8601 timestamp
  userId: string;
}

/**
 * API configuration
 * If customUrl is set, connects to self-hosted instance
 * Otherwise, connects to Bike4Mind main service
 */
export interface ApiConfig {
  customUrl?: string; // URL for self-hosted Bike4Mind instance
}

/**
 * CLI configuration
 */
export interface CliConfig {
  version: string;
  userId: string;
  auth?: AuthTokens; // OAuth authentication tokens for the active environment (optional)
  /**
   * Per-environment auth token cache, keyed by resolved API URL
   * (e.g. "https://app.example.com", "http://localhost:3000").
   * Lets `--dev`/`--prod` flip between environments without forcing a
   * re-login each time you return to one you've already authenticated.
   */
  authByEnv?: Record<string, AuthTokens>;
  defaultModel: string;
  apiConfig?: ApiConfig; // API environment configuration (optional, defaults to production)
  toolApiKeys: {
    openweather?: string;
    serper?: string;
  };
  mcpServers: Array<{
    name: string;
    /** Transport kind. Defaults to 'stdio' when omitted (command-based servers). */
    type?: 'stdio' | 'http';
    command?: string;
    args?: string[];
    /** For 'http' transport: the streamable-HTTP endpoint URL. */
    url?: string;
    /** For 'http' transport: headers sent on every request (e.g. Authorization). */
    headers?: Record<string, string>;
    env: Record<string, string>;
    enabled: boolean;
  }>;
  preferences: {
    maxTokens: number;
    temperature: number;
    autoSave: boolean;
    autoCompact?: boolean; // Enable auto-compact at 80% context usage (default: true)
    autoUpdate?: boolean; // Auto-install newer CLI versions on launch. true = always, false = never, undefined = ask on launch (default)
    theme: 'light' | 'dark';
    exportFormat: 'markdown' | 'json';
    maxIterations: number | null; // null = infinite iterations
    enableSkillTool?: boolean; // Enable AI skill invocation (default: true)
    enableRemoteSkills?: boolean; // Sync skills from B4M web on startup (default: true)
    enableParallelToolExecution?: boolean; // Enable parallel execution of read-only tools (default: false)
    enableDynamicAgentCreation?: boolean; // Enable dynamic agent creation (default: false, experimental)
    enableCoordinatorMode?: boolean; // Enable coordinator mode for complex task decomposition (default: false)
    /** System-prompt variant. 'minimal' is a pi-style short prompt; 'current' is the historical default. */
    promptVariant?: 'current' | 'minimal';
    /** Show the agent's thought steps in the chat trace. Default true. */
    showThoughts?: boolean;
    /**
     * How long a completed sub-agent's conversation history is retained for
     * resume_agent, in ms. Defaults to DEFAULT_SUBAGENT_HISTORY_TTL_MS.
     */
    subagentHistoryTtlMs?: number;
  };
  /** Opt-in feature module toggles */
  features?: {
    tavern?: boolean; // Enable Tavern agent integration (default: false)
  };
  tools: {
    enabled: string[];
    disabled: string[];
    config: Record<string, any>;
  };
  trustedTools?: string[]; // Tools that don't need permission (user has permanently allowed)
  // Sandbox configuration for OS-level filesystem isolation
  sandbox?: SandboxConfig;
  // Subagent configurations
  subagents?: {
    explore?: Partial<SubagentConfig>;
    plan?: Partial<SubagentConfig>;
    review?: Partial<SubagentConfig>;
  };
  /**
   * Additional directories accessible beyond the working directory.
   * Persisted across sessions. Can be added via --add-dir flag or /add-dir command.
   */
  additionalDirectories?: string[];
  /**
   * Ordered list of fallback model IDs to try when the primary model fails.
   * Example: ["claude-sonnet-4-6", "claude-haiku-4-5"] for graceful degradation.
   * Each model is tried in order after the primary model exhausts its retries.
   */
  fallbackModels?: string[];
}

/**
 * Project-level configuration (committed to git)
 * Team-wide settings shared across all developers
 */
export interface ProjectConfig {
  tools?: {
    enabled?: string[];
    denied?: string[]; // Takes precedence over local trusted
    config?: Record<string, any>;
  };
  defaultModel?: string;
  mcpServers?: Array<{
    name: string;
    type?: 'stdio' | 'http';
    command?: string;
    args?: string[];
    url?: string;
    headers?: Record<string, string>;
    env: Record<string, string>;
    enabled: boolean;
  }>;
  preferences?: Partial<CliConfig['preferences']>;
  // Team-wide sandbox configuration
  sandbox?: PartialSandboxConfig;
  // Team-wide subagent configurations
  subagents?: {
    explore?: Partial<SubagentConfig>;
    plan?: Partial<SubagentConfig>;
    review?: Partial<SubagentConfig>;
  };
  /**
   * Additional directories for this project.
   * Relative paths are resolved from project root.
   */
  additionalDirectories?: string[];
}

/**
 * Project-local configuration (not committed, developer-specific)
 * Developer-specific overrides for project settings
 */
export interface ProjectLocalConfig {
  trustedTools?: string[];
  toolApiKeys?: {
    openweather?: string;
    serper?: string;
  };
  preferences?: Partial<CliConfig['preferences']>;
  // Developer-specific sandbox overrides
  sandbox?: PartialSandboxConfig;
  mcpServers?: Array<{
    name: string;
    type?: 'stdio' | 'http';
    command?: string;
    args?: string[];
    url?: string;
    headers?: Record<string, string>;
    env: Record<string, string>;
    enabled: boolean;
  }>;
}

/**
 * Agent configuration - can be simple string or detailed config
 */
export type AgentConfig =
  | string
  | {
      type: string;
      thoroughness?: ThoroughnessLevel;
      config?: Record<string, unknown>;
    };

/**
 * Skill lifecycle hooks
 */
export interface SkillHooks {
  /** Script to run before skill execution */
  'pre-invoke'?: string;
  /** Script to run after successful skill execution */
  'post-invoke'?: string;
  /** Script to run when skill execution fails */
  'on-error'?: string;
}

/**
 * Custom slash command definition
 * Compatible with Claude Code's markdown format
 */
export interface CustomCommand {
  /** Command name (derived from filename without .md extension) */
  name: string;
  /** Display name for the skill (from frontmatter 'name' field) */
  displayName?: string;
  /** Command description (from frontmatter or first line of body) */
  description: string;
  /** Argument hint shown in autocomplete (e.g., "[file] [priority]") */
  argumentHint?: string;
  /** Model override for this command */
  model?: string;
  /** Command body/template with argument substitution support */
  body: string;
  /** Source of the command - `'remote'` indicates the skill was fetched from the
   *  B4M backend via `/api/skills`, not loaded from disk. */
  source: 'global' | 'project' | 'remote';
  /**
   * Full path to the command file for local skills (`source: 'global' | 'project'`).
   * For remote skills (`source: 'remote'`) this is a synthetic
   * `b4m:/api/skills/<id>` URI - there is no on-disk file. Surfaced in
   * `/commands` listings to disambiguate origin; never opened by the file
   * loader.
   */
  filePath: string;
  /** Agent to delegate this command to (if specified) */
  agent?: AgentConfig;
  /** Thoroughness level for agent execution */
  thoroughness?: ThoroughnessLevel;
  /** Variables to pass to the agent for system prompt substitution */
  variables?: Record<string, string>;
  /** Tool patterns to allow during skill execution */
  allowedTools?: string[];
  /** Execution context: 'inline' (default) or 'fork' (runs in subagent) */
  context?: 'fork' | 'inline';
  /** When true, skill is hidden from AI's auto-loading in system prompt */
  disableModelInvocation?: boolean;
  /** When false, skill is hidden from /commands menu but still callable */
  userInvocable?: boolean;
  /** Lifecycle hooks for skill execution */
  hooks?: SkillHooks;
}

/**
 * Frontmatter fields from custom command markdown files
 * Following Claude Code's format specification
 */
export interface CustomCommandFrontmatter {
  /** Display name for the skill */
  name?: string;
  /** Command description */
  description?: string;
  /** Argument hint for autocomplete */
  'argument-hint'?: string;
  /** Model override */
  model?: string;
  /** Agent to delegate this command to */
  agent?: AgentConfig;
  /** Thoroughness level for agent execution */
  thoroughness?: ThoroughnessLevel;
  /** Variables to pass to the agent for system prompt substitution */
  variables?: Record<string, string>;
  /** Tool patterns to allow during skill execution */
  'allowed-tools'?: string[];
  /** Execution context: 'inline' (default) or 'fork' (runs in subagent) */
  context?: 'fork' | 'inline';
  /** When true, skill is hidden from AI's auto-loading in system prompt */
  'disable-model-invocation'?: boolean;
  /** When false, skill is hidden from /commands menu but still callable */
  'user-invocable'?: boolean;
  /** Lifecycle hooks for skill execution */
  hooks?: SkillHooks;
}
