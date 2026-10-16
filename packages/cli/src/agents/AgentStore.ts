/**
 * AgentStore - Loads and manages agent definitions from markdown files
 *
 * Discovers and loads agents from multiple directories with precedence:
 * 1. Project agents (.claude/agents/) - highest priority (Claude Code convention)
 * 2. Project agents (.bike4mind/agents/) - high priority (B4M convention)
 * 3. Global agents (~/.claude/agents/) - medium priority (Claude Code convention)
 * 4. Global agents (~/.bike4mind/agents/) - medium-low priority (B4M convention)
 * 5. Built-in agents (src/agents/defaults/) - lowest priority (CLI defaults)
 *
 * Higher priority agents override lower priority agents with the same name.
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { findMarkdownFiles } from '../utils/findMarkdownFiles.js';
import { parseFrontmatter } from '../utils/parseFrontmatter.js';
import { ChatModels } from '@bike4mind/common';
import type { AgentDefinition, AgentSource, AgentHooks } from './types.js';
import {
  AgentFrontmatterSchema,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_AGENT_MODEL,
  DEFAULT_THOROUGHNESS,
  DEFAULT_RETRY_CONFIG,
} from './types.js';

/**
 * Model ID prefixes that indicate a string is already a full model ID
 * (not an alias that needs resolution)
 */
const FULL_MODEL_ID_PREFIXES = [
  'claude-',
  'gpt-',
  'gemini-',
  'grok-',
  'meta.',
  'anthropic.',
  'us.anthropic.',
  'global.anthropic.',
  'amazon.',
  'ai21.',
  'deepseek',
  'whisper',
  'flux-',
  'sora-',
] as const;

/**
 * Model alias mapping for short names to full model IDs
 *
 * Maps user-friendly aliases to the actual model identifiers used by the API.
 * This allows agent definitions to use simple names like "opus" instead of
 * full model IDs like "claude-opus-4-5-20251101".
 *
 * To add a new model alias:
 * 1. Add the alias as a key (lowercase)
 * 2. Set the value to the full model ID from ChatModels enum
 *
 * The CLI request path never runs resolveDeprecatedModelId, so a target must be
 * an active model with no deprecationDate. A target with a scheduled
 * deprecationDate belongs in SUNSETTING_MODEL_ALIASES; an alias for a retired
 * model points at its successor or moves to RETIRED_MODEL_ALIASES.
 * AgentStore.test.ts enforces this.
 */
export const MODEL_ALIASES: Record<string, string> = {
  // Anthropic/Claude Models
  // Short aliases (most common)
  opus: ChatModels.CLAUDE_4_8_OPUS,
  sonnet: ChatModels.CLAUDE_4_5_SONNET,
  haiku: ChatModels.CLAUDE_4_5_HAIKU,

  // Claude-prefixed aliases
  'claude-opus': ChatModels.CLAUDE_4_8_OPUS,
  'claude-sonnet': ChatModels.CLAUDE_4_5_SONNET,
  'claude-haiku': ChatModels.CLAUDE_4_5_HAIKU,

  // Version-specific Claude aliases
  'claude-4.8-opus': ChatModels.CLAUDE_4_8_OPUS,
  'claude-4.7-opus': ChatModels.CLAUDE_4_7_OPUS,
  'claude-4.6-opus': ChatModels.CLAUDE_4_6_OPUS,
  'claude-4.6-sonnet': ChatModels.CLAUDE_4_6_SONNET,
  'claude-4.5-opus': ChatModels.CLAUDE_4_5_OPUS,
  'claude-4.5-sonnet': ChatModels.CLAUDE_4_5_SONNET,
  'claude-4.5-haiku': ChatModels.CLAUDE_4_5_HAIKU,
  'claude-4-opus': ChatModels.CLAUDE_4_OPUS,
  'claude-4-sonnet': ChatModels.CLAUDE_4_6_SONNET,
  'claude-4.1-opus': ChatModels.CLAUDE_4_1_OPUS,
  'claude-3.7-sonnet': ChatModels.CLAUDE_4_6_SONNET,
  'claude-3.5-sonnet': ChatModels.CLAUDE_4_5_SONNET,
  'claude-3.5-haiku': ChatModels.CLAUDE_4_5_HAIKU,
  'claude-3-opus': ChatModels.CLAUDE_4_8_OPUS,

  // OpenAI Models
  // GPT-4 family
  'gpt-4o': ChatModels.GPT4o,
  'gpt-4o-mini': ChatModels.GPT4o_MINI,
  'gpt-4.1': ChatModels.GPT4_1,
  'gpt-4.1-mini': ChatModels.GPT4_1_MINI,

  // GPT-5 family
  'gpt-5': ChatModels.GPT5,
  'gpt-5-mini': ChatModels.GPT5_MINI,
  'gpt-5-nano': ChatModels.GPT5_NANO,
  'gpt-5.1': ChatModels.GPT5_1,
  'gpt-5.2': ChatModels.GPT5_2,
  'gpt-5.4': ChatModels.GPT5_4,
  'gpt-5.4-mini': ChatModels.GPT5_4_MINI,
  'gpt-5.4-nano': ChatModels.GPT5_4_NANO,
  'gpt-5.5': ChatModels.GPT5_5,
  'gpt-5.6-sol': ChatModels.GPT5_6_SOL,
  'gpt-5.6-luna': ChatModels.GPT5_6_LUNA,
  'gpt-5.6-terra': ChatModels.GPT5_6_TERRA,

  // Google Gemini Models
  gemini: ChatModels.GEMINI_3_5_FLASH,
  'gemini-pro': ChatModels.GEMINI_3_1_PRO_PREVIEW,
  'gemini-flash': ChatModels.GEMINI_3_5_FLASH,
  'gemini-flash-lite': ChatModels.GEMINI_3_1_FLASH_LITE,

  // Gemini 3 (preview)
  'gemini-3': ChatModels.GEMINI_3_1_PRO_PREVIEW,
  'gemini-3-pro': ChatModels.GEMINI_3_1_PRO_PREVIEW,
  'gemini-3-flash': ChatModels.GEMINI_3_FLASH_PREVIEW,

  // Gemini 2.5
  'gemini-2.5': ChatModels.GEMINI_3_5_FLASH,
  'gemini-2.5-pro': ChatModels.GEMINI_3_5_FLASH,
  'gemini-2.5-flash': ChatModels.GEMINI_3_1_FLASH_LITE,

  // xAI Grok Models
  grok: ChatModels.GROK_4_5,
  'grok-3': ChatModels.GROK_4_5,
  'grok-3-fast': ChatModels.GROK_4_5,
  'grok-3-mini': ChatModels.GROK_3_MINI,
  'grok-3-mini-fast': ChatModels.GROK_3_MINI,
  'grok-2': ChatModels.GROK_4_5,
  'grok-2-vision': ChatModels.GROK_4_5,

  // DeepSeek Models
  // Bare `deepseek` points at the hosted first-party model; `deepseek-r1` keeps
  // resolving to the local Ollama tag it has always named.
  deepseek: ChatModels.DEEPSEEK_FLASH,
  'deepseek-r1': ChatModels.DEEPSEEK_R1,

  // Llama Models (Ollama local)
  llama: ChatModels.LLAMA3_LOCAL,
  llama3: ChatModels.LLAMA3_LOCAL,
  'llama3.3': ChatModels.LLAMA3_LOCAL,
  tinyllama: ChatModels.TINYLLAMA,
};

/**
 * Aliases whose target is still served but carries a catalog deprecationDate.
 * Each resolves until `retiresOn`, then reports as retired and names `successor`
 * instead of pinning a dead id. AgentStore.test.ts keeps every `retiresOn` equal
 * to the catalog deprecationDate and every `successor` a live MODEL_ALIASES key.
 */
export const SUNSETTING_MODEL_ALIASES: Record<string, { model: string; retiresOn: string; successor: string }> = {
  'gpt-4': { model: ChatModels.GPT4, retiresOn: '2026-10-23', successor: 'gpt-5.5' },
  'gpt-4-turbo': { model: ChatModels.GPT4_TURBO, retiresOn: '2026-10-23', successor: 'gpt-5.5' },
  'gpt-4.1-nano': { model: ChatModels.GPT4_1_NANO, retiresOn: '2026-10-23', successor: 'gpt-5-nano' },
  'o4-mini': { model: ChatModels.O4_MINI, retiresOn: '2026-10-23', successor: 'gpt-5-mini' },
  o3: { model: ChatModels.O3, retiresOn: '2026-12-11', successor: 'gpt-5.5' },
};

/**
 * Aliases for retired models, mapped to the alias to suggest instead. Checked
 * before the full-id passthrough so `gpt-4.5` or `gemini-1.5-pro` warn rather
 * than pin an id the provider no longer serves.
 */
export const RETIRED_MODEL_ALIASES: Record<string, string> = {
  'gpt-4.5': 'gpt-5.5',
  o1: 'gpt-5.5',
  'o1-preview': 'gpt-5.5',
  'o1-mini': 'gpt-5-mini',
  'o3-mini': 'gpt-5-mini',
  'gemini-2.0-flash': 'gemini-flash',
  'gemini-1.5-pro': 'gemini-pro',
  'gemini-1.5-flash': 'gemini-flash',
  'gemini-1.5-flash-8b': 'gemini-flash-lite',
};

// Agent frontmatter is user-controlled, so `constructor` or `toString` must not
// resolve through the prototype.
function ownEntry<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/**
 * Get list of all available model aliases for error messages
 */
export function getAvailableModelAliases(now: Date = new Date()): string[] {
  const today = now.toISOString().slice(0, 10);
  const sunsetting = Object.entries(SUNSETTING_MODEL_ALIASES)
    .filter(([, entry]) => today < entry.retiresOn)
    .map(([alias]) => alias);
  return [...Object.keys(MODEL_ALIASES), ...sunsetting].sort();
}

/**
 * Result of model alias resolution
 */
export interface ModelResolutionResult {
  /** The resolved model ID (or default if unknown) */
  model: string;
  /** Whether the model was successfully resolved */
  resolved: boolean;
  /** Warning message if the model was not recognized */
  warning?: string;
}

/**
 * Resolve a model alias to its full model ID
 *
 * @param modelInput - The model alias or full model ID
 * @param agentName - Name of the agent (for warning messages)
 * @param filePath - Path to the agent file (for warning messages)
 * @param now - Clock for sunsetting aliases (injectable for tests)
 * @returns Resolution result with model ID and optional warning
 */
export function resolveModelAlias(
  modelInput: string,
  agentName: string,
  filePath: string,
  now: Date = new Date()
): ModelResolutionResult {
  const normalizedInput = modelInput.toLowerCase();

  const alias = ownEntry(MODEL_ALIASES, normalizedInput);
  if (alias) {
    return { model: alias, resolved: true };
  }

  // Match the alias key or the full id it points at, so the dated id of a
  // sunsetting model retires on the same date as its alias.
  const sunsetting =
    ownEntry(SUNSETTING_MODEL_ALIASES, normalizedInput) ??
    Object.values(SUNSETTING_MODEL_ALIASES).find(entry => entry.model === normalizedInput);
  if (sunsetting && now.toISOString().slice(0, 10) < sunsetting.retiresOn) {
    return { model: sunsetting.model, resolved: true };
  }

  const successor = sunsetting?.successor ?? ownEntry(RETIRED_MODEL_ALIASES, normalizedInput);
  if (successor) {
    return {
      model: DEFAULT_AGENT_MODEL,
      resolved: false,
      warning:
        `Model "${modelInput}" in agent "${agentName}" (${filePath}) is retired. ` +
        `Will inherit the parent or main session model at runtime. Set model: ${successor} to pick its replacement.`,
    };
  }

  // Check if it looks like a full model ID
  const hasDatePattern = /\d{8}|\d{4}-\d{2}-\d{2}/.test(modelInput);
  const hasBedrockSuffix = modelInput.includes(':0');
  const hasKnownPrefix = FULL_MODEL_ID_PREFIXES.some(prefix => modelInput.startsWith(prefix));

  if (hasDatePattern || hasBedrockSuffix || hasKnownPrefix) {
    return { model: modelInput, resolved: true };
  }

  // Unknown alias - return warning and use default model
  const availableAliases = getAvailableModelAliases();
  const suggestions = availableAliases
    .filter(alias => alias.includes(normalizedInput) || normalizedInput.includes(alias))
    .slice(0, 5);

  let warning = `Unknown model "${modelInput}" in agent "${agentName}" (${filePath}). Will inherit the parent or main session model at runtime.\n`;

  if (suggestions.length > 0) {
    warning += `Did you mean: ${suggestions.join(', ')}?\n`;
  }

  warning += `Available aliases: opus, sonnet, haiku, gpt-4o, gemini, grok, etc. Run with --verbose for full list.`;

  return { model: DEFAULT_AGENT_MODEL, resolved: false, warning };
}

/**
 * Store for managing agent definitions
 * Discovers and loads agents from built-in, global, and project directories
 */
export class AgentStore {
  private agents: Map<string, AgentDefinition> = new Map();

  private builtinAgentsDir: string;
  private globalB4MAgentsDir: string;
  private globalClaudeAgentsDir: string;
  private projectB4MAgentsDir: string;
  private projectClaudeAgentsDir: string;
  private projectRoot: string;
  /**
   * Whether the project root is trusted. When false, project agent directories
   * are NOT scanned (folder-trust gate) - only built-in and global agents load.
   * Defaults FALSE (fail-safe): a caller that forgets `setProjectTrusted` gets
   * the safe posture, never a silent trust of repo agents.
   */
  private projectTrusted = false;

  /**
   * Creates a new AgentStore
   *
   * @param builtinDir - Directory containing built-in agent definitions
   * @param projectRoot - Root of the project (defaults to cwd)
   */
  constructor(builtinDir: string, projectRoot?: string) {
    const root = projectRoot || process.cwd();
    this.projectRoot = root;
    const home = os.homedir();

    // Built-in agents shipped with CLI
    this.builtinAgentsDir = builtinDir;

    // Global agents (two conventions)
    this.globalB4MAgentsDir = path.join(home, '.bike4mind', 'agents');
    this.globalClaudeAgentsDir = path.join(home, '.claude', 'agents');

    // Project agents (two conventions)
    this.projectB4MAgentsDir = path.join(root, '.bike4mind', 'agents');
    this.projectClaudeAgentsDir = path.join(root, '.claude', 'agents');
  }

  /**
   * Load all agents from all directories
   * Precedence (lowest to highest):
   * 1. builtin
   * 2. global ~/.bike4mind/agents/
   * 3. global ~/.claude/agents/
   * 4. project .bike4mind/agents/
   * 5. project .claude/agents/
   */
  async loadAgents(): Promise<void> {
    this.agents.clear();

    // Load in order of precedence (lowest first, so higher can override)
    await this.loadAgentsFromDirectory(this.builtinAgentsDir, 'builtin');
    await this.loadAgentsFromDirectory(this.globalB4MAgentsDir, 'global');
    await this.loadAgentsFromDirectory(this.globalClaudeAgentsDir, 'global');
    // Project agents load ONLY for a trusted project root (folder-trust gate).
    if (this.projectTrusted) {
      await this.loadAgentsFromDirectory(this.projectB4MAgentsDir, 'project');
      await this.loadAgentsFromDirectory(this.projectClaudeAgentsDir, 'project');
    }
  }

  /**
   * Set whether the project root is trusted. When false, `loadAgents()` skips
   * the project agent directories. Call before `loadAgents()`.
   */
  setProjectTrusted(trusted: boolean): void {
    this.projectTrusted = trusted;
  }

  /**
   * Recursively load agents from a directory
   */
  private async loadAgentsFromDirectory(directory: string, source: AgentSource): Promise<void> {
    try {
      const stats = await fs.stat(directory);
      if (!stats.isDirectory()) {
        return;
      }

      // Project agent dirs live inside the (untrusted) clone: refuse a symlink
      // whose target escapes the project root. Global/builtin dirs stay unconstrained.
      const files = await findMarkdownFiles(directory, source === 'project' ? this.projectRoot : undefined);

      for (const filePath of files) {
        try {
          const agent = await this.parseAgentFile(filePath, source);
          this.agents.set(agent.name, agent);
        } catch (error) {
          console.warn(
            `Failed to load agent from ${filePath}:`,
            error instanceof Error ? error.message : String(error)
          );
        }
      }
    } catch (error) {
      // Directory doesn't exist - silently ignore
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`Error accessing agents directory ${directory}`);
      }
    }
  }

  /**
   * Parse a single agent markdown file
   */
  private async parseAgentFile(filePath: string, source: AgentSource): Promise<AgentDefinition> {
    const content = await fs.readFile(filePath, 'utf-8');
    const { data: frontmatter, content: body } = parseFrontmatter(content);

    const parsed = AgentFrontmatterSchema.parse(frontmatter);

    const name = path.basename(filePath, '.md');

    const modelInput = parsed.model || DEFAULT_AGENT_MODEL;
    const resolution = resolveModelAlias(modelInput, name, filePath);

    if (!resolution.resolved && resolution.warning) {
      console.warn(`\n⚠️  ${resolution.warning}\n`);
    }

    return {
      name,
      description: parsed.description,
      model: resolution.model,
      systemPrompt: body.trim(),
      allowedTools: parsed['allowed-tools'],
      deniedTools: parsed['denied-tools'],
      skills: parsed.skills,
      maxIterations: {
        quick: parsed['max-iterations']?.quick ?? DEFAULT_MAX_ITERATIONS.quick,
        medium: parsed['max-iterations']?.medium ?? DEFAULT_MAX_ITERATIONS.medium,
        very_thorough: parsed['max-iterations']?.very_thorough ?? DEFAULT_MAX_ITERATIONS.very_thorough,
      },
      defaultThoroughness: parsed['default-thoroughness'] || DEFAULT_THOROUGHNESS,
      defaultVariables: parsed.variables,
      hooks: parsed.hooks as AgentHooks | undefined,
      source,
      filePath,
      modelResolved: resolution.resolved,
      retry: {
        maxRetries: parsed.retry?.maxRetries ?? DEFAULT_RETRY_CONFIG.maxRetries,
        initialDelayMs: parsed.retry?.initialDelay ?? DEFAULT_RETRY_CONFIG.initialDelayMs,
      },
      sharedContext: parsed['shared-context'],
    };
  }

  /**
   * Get an agent by name
   */
  getAgent(name: string): AgentDefinition | undefined {
    return this.agents.get(name);
  }

  /**
   * Get all loaded agents
   */
  getAllAgents(): AgentDefinition[] {
    return Array.from(this.agents.values());
  }

  /**
   * Get available agent names (for autocomplete/validation)
   */
  getAgentNames(): string[] {
    return Array.from(this.agents.keys());
  }

  /**
   * Get agents by source
   */
  getAgentsBySource(source: AgentSource): AgentDefinition[] {
    return this.getAllAgents().filter(agent => agent.source === source);
  }

  /**
   * Check if an agent exists
   */
  hasAgent(name: string): boolean {
    return this.agents.has(name);
  }

  /**
   * Get the number of loaded agents
   */
  getAgentCount(): number {
    return this.agents.size;
  }

  /**
   * Reload all agents
   */
  async reloadAgents(): Promise<void> {
    await this.loadAgents();
  }

  /**
   * Creates a new agent file from a template
   *
   * @param name - Agent name
   * @param isGlobal - If true, creates in global directory, otherwise project directory
   * @param useClaude - If true, uses .claude/agents/ convention, otherwise .bike4mind/agents/
   * @returns Path to the created file
   */
  async createAgentFile(name: string, isGlobal: boolean = false, useClaude: boolean = true): Promise<string> {
    // Default to Claude Code convention (.claude/agents/)
    const targetDir = isGlobal
      ? useClaude
        ? this.globalClaudeAgentsDir
        : this.globalB4MAgentsDir
      : useClaude
        ? this.projectClaudeAgentsDir
        : this.projectB4MAgentsDir;
    const filePath = path.join(targetDir, `${name}.md`);

    // Check if file already exists
    try {
      await fs.access(filePath);
      throw new Error(`Agent file already exists: ${filePath}`);
    } catch (error) {
      // File doesn't exist, continue
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    await fs.mkdir(targetDir, { recursive: true });

    const template = `---
description: ${name} agent description
model: ${ChatModels.CLAUDE_4_5_HAIKU}
allowed-tools:
  - file_read
  - grep_search
  - glob_files
  - bash_execute
denied-tools:
  - create_file
  - edit_file
  - delete_file
max-iterations:
  quick: 2
  medium: 5
  very_thorough: 10
default-thoroughness: medium
---

You are a ${name} specialist. Your job is to [describe primary task].

## Focus Areas
- [Area 1]
- [Area 2]
- [Area 3]

## Instructions
1. [Step 1]
2. [Step 2]
3. [Step 3]

## Output Format
Describe the expected output format here.
`;

    await fs.writeFile(filePath, template, 'utf-8');

    return filePath;
  }

  /**
   * Get summary of loaded agents by source (single-pass iteration)
   */
  getSummary(): { builtin: number; global: number; project: number; total: number } {
    let builtin = 0;
    let global = 0;
    let project = 0;

    for (const agent of this.agents.values()) {
      if (agent.source === 'builtin') builtin++;
      else if (agent.source === 'global') global++;
      else project++;
    }

    return { builtin, global, project, total: this.agents.size };
  }

  /**
   * Generates a markdown "Phone Book" of available agents and their schemas.
   * This MUST be injected into the System Prompt of the parent agent.
   */
  getDirectoryContext(): string {
    if (this.agents.size === 0) {
      return 'No sub-agents are currently available.';
    }

    let context = 'Use `agent_delegate` for complex tasks requiring specialized analysis.\n';

    for (const [name, def] of this.agents) {
      context += ` - **${name}**: ${def.description}\n`;
    }
    return context;
  }
}
