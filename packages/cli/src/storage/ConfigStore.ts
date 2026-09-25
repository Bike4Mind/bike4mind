import { promises as fs, existsSync } from 'fs';
import path from 'path';
import { homedir } from 'os';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { ChatModels } from '@bike4mind/common';
import type { AuthTokens, CliConfig, GlobalConfigPatch, ProjectConfig, ProjectLocalConfig } from './types';
import { getDefaultApiUrl, LOCAL_DEV_URL, getEnvironmentName } from '../utils/apiUrl';
import {
  DEFAULT_SANDBOX_CONFIG,
  type PartialSandboxConfig,
  type SandboxConfig,
  type SandboxMode,
} from '../sandbox/types.js';
import { canTrustTool } from '../config/toolSafety';
import { PROJECT_CONTEXT_FILES } from '../utils/contextLoader';
import { logger } from '../utils/Logger';

/**
 * Zod schema for sandbox filesystem configuration
 */
const SandboxFilesystemSchema = z.object({
  allowedReadPaths: z.array(z.string()).default(DEFAULT_SANDBOX_CONFIG.filesystem.allowedReadPaths),
  deniedPaths: z.array(z.string()).default(DEFAULT_SANDBOX_CONFIG.filesystem.deniedPaths),
  writeOnlyToWorkingDir: z.boolean().default(true),
});

/**
 * Zod schema for sandbox network configuration
 */
const SandboxNetworkSchema = z.object({
  enabled: z.boolean().default(false),
  allowedDomains: z.array(z.string()).default(DEFAULT_SANDBOX_CONFIG.network.allowedDomains),
});

/**
 * Zod schema for sandbox platform configuration
 */
const SandboxPlatformSchema = z.object({
  linux: z
    .object({
      runtime: z.literal('bubblewrap').default('bubblewrap'),
      seccompProfile: z.string().optional(),
    })
    .default({ runtime: 'bubblewrap' }),
  macos: z
    .object({
      runtime: z.literal('seatbelt').default('seatbelt'),
      profileTemplate: z.string().default('default'),
    })
    .default({ runtime: 'seatbelt', profileTemplate: 'default' }),
});

/**
 * Zod schema for full sandbox configuration
 */
const SandboxConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    mode: z.enum(['disabled', 'auto-allow', 'permissions']).default('disabled'),
    filesystem: SandboxFilesystemSchema.default(DEFAULT_SANDBOX_CONFIG.filesystem),
    network: SandboxNetworkSchema.default(DEFAULT_SANDBOX_CONFIG.network),
    excludedCommands: z.array(z.string()).default(DEFAULT_SANDBOX_CONFIG.excludedCommands),
    allowUnsandboxedCommands: z.boolean().default(true),
    platform: SandboxPlatformSchema.default(DEFAULT_SANDBOX_CONFIG.platform),
  })
  .refine(
    config => {
      if (config.enabled && config.mode === 'disabled') return false;
      if (!config.enabled && config.mode !== 'disabled') return false;
      return true;
    },
    {
      message:
        'Sandbox config inconsistency: enabled and mode must agree. If enabled=true, mode must be "auto-allow" or "permissions". If mode="disabled", enabled must be false.',
    }
  );

/**
 * Partial sandbox config schema for project/local overrides
 */
const PartialSandboxConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: z.enum(['disabled', 'auto-allow', 'permissions']).optional(),
    filesystem: z
      .object({
        allowedReadPaths: z.array(z.string()).optional(),
        deniedPaths: z.array(z.string()).optional(),
        writeOnlyToWorkingDir: z.boolean().optional(),
      })
      .optional(),
    network: z
      .object({
        enabled: z.boolean().optional(),
        allowedDomains: z.array(z.string()).optional(),
      })
      .optional(),
    excludedCommands: z.array(z.string()).optional(),
    allowUnsandboxedCommands: z.boolean().optional(),
    platform: SandboxPlatformSchema.optional(),
  })
  .optional();

/**
 * Zod schema for authentication tokens
 */
const AuthTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.string(),
  userId: z.string(),
});

/**
 * Zod schema for API configuration
 */
const ApiConfigSchema = z.object({
  customUrl: z.url().optional(),
});

/**
 * MCP Server schema - individual server configuration
 */
const McpServerSchema = z
  .object({
    name: z.string(),
    type: z.enum(['stdio', 'http']).optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    env: z.record(z.string(), z.string()).prefault({}),
    enabled: z.boolean().prefault(true),
  })
  .superRefine(mcpServerTransportRefine);

/**
 * A valid MCP server is exactly one of:
 *  - stdio: has `command` (spawned child process)
 *  - http:  has `url` (streamable-HTTP endpoint)
 * Rejecting malformed configs at parse time (not connect time) surfaces errors early.
 */
function mcpServerTransportRefine(
  server: { type?: 'stdio' | 'http'; command?: string; url?: string },
  ctx: z.RefinementCtx
): void {
  const hasCommand = typeof server.command === 'string' && server.command.trim() !== '';
  const hasUrl = typeof server.url === 'string' && server.url.trim() !== '';
  if (hasCommand && hasUrl) {
    ctx.addIssue({ code: 'custom', message: 'MCP server cannot set both "command" (stdio) and "url" (http)' });
  } else if (!hasCommand && !hasUrl) {
    ctx.addIssue({ code: 'custom', message: 'MCP server must set either "command" (stdio) or "url" (http)' });
  }
}

/**
 * MCP Servers can be specified in two formats:
 * 1. Array format (B4M native): [{ "name": "...", "command": "...", ... }]
 * 2. Object format (portable): { "name": { "command": "...", ... } }
 */
const McpServersSchema = z.union([
  // Array format (B4M native)
  z.array(McpServerSchema),
  // Object format (portable - compatible with Claude Code)
  z.record(
    z.string(),
    z
      .object({
        type: z.enum(['stdio', 'http']).optional(),
        command: z.string().optional(),
        args: z.array(z.string()).optional(),
        url: z.string().optional(),
        headers: z.record(z.string(), z.string()).optional(),
        env: z.record(z.string(), z.string()).optional(),
        enabled: z.boolean().optional(),
      })
      .superRefine(mcpServerTransportRefine)
  ),
]);

/** Internal array-format MCP server config (carries both stdio and http fields). */
type NormalizedMcpServer = {
  name: string;
  type?: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env: Record<string, string>;
  enabled: boolean;
};

/**
 * Normalize MCP servers to internal array format
 * Accepts both array and object formats
 */
function normalizeMcpServers(servers: z.infer<typeof McpServersSchema>): NormalizedMcpServer[] {
  if (Array.isArray(servers)) {
    // Already in array format
    return servers.map(server => ({
      name: server.name,
      type: server.type,
      command: server.command,
      args: server.args,
      url: server.url,
      headers: server.headers,
      env: server.env || {},
      enabled: server.enabled ?? true,
    }));
  } else {
    // Convert object format to array format
    return Object.entries(servers).map(([name, config]) => ({
      name,
      type: config.type,
      command: config.command,
      args: config.args,
      url: config.url,
      headers: config.headers,
      env: config.env || {},
      enabled: config.enabled ?? true,
    }));
  }
}

/**
 * Zod schema for CliConfig validation
 * Defaults fill missing fields on load (auto-migration)
 */
const CliConfigSchema = z.object({
  version: z.string(),
  userId: z.string(),
  auth: AuthTokensSchema.optional(),
  authByEnv: z.record(z.string(), AuthTokensSchema).optional(),
  defaultModel: z.string(),
  apiConfig: ApiConfigSchema.optional(),
  toolApiKeys: z
    .object({
      openweather: z.string().optional(),
      serper: z.string().optional(),
    })
    .optional(),
  mcpServers: McpServersSchema,
  preferences: z.object({
    maxTokens: z.number().optional(),
    temperature: z.number(),
    autoSave: z.boolean(),
    autoCompact: z.boolean().optional().prefault(true),
    // No prefault: an absent flag means "ask on launch" (consent-first), so the
    // tri-state must survive as undefined rather than being coerced to true/false.
    autoUpdate: z.boolean().optional(),
    theme: z.enum(['light', 'dark']),
    exportFormat: z.enum(['markdown', 'json']),
    maxIterations: z.number().nullable().prefault(10),
    enableSkillTool: z.boolean().optional().prefault(true),
    // Six always-on tools would sit in every completion's schema list; off by
    // default so only users who want persistent tracking pay for them.
    enableWorkItemTools: z.boolean().optional().prefault(false),
    /**
     * When false (or set via the `--no-remote-skills` CLI flag / the
     * `B4M_NO_REMOTE_SKILLS=1` env var), the CLI skips fetching skills from
     * the B4M backend's `/api/skills` endpoint and runs with local files only.
     * Defaults to true so authenticated users get cross-machine skill sync
     * out of the box.
     */
    enableRemoteSkills: z.boolean().optional().prefault(true),
    enableDynamicAgentCreation: z.boolean().optional().prefault(false),
    enableCoordinatorMode: z.boolean().optional().prefault(false),
    /**
     * System-prompt variant. 'current' uses the elaborate behavioral-scaffolding
     * prompt; 'minimal' uses a pi-style short prompt. See packages/cli/src/core/prompts.ts.
     * Defaults to 'current' for backward compatibility; switch via /config or by
     * editing the config file directly.
     */
    promptVariant: z.enum(['current', 'minimal']).optional().prefault('current'),
    // Retention window for resumable sub-agent history (ms). Absent = use
    // DEFAULT_SUBAGENT_HISTORY_TTL_MS. See AgentHistoryStore / resume_agent.
    subagentHistoryTtlMs: z.number().optional(),
  }),
  tools: z.object({
    enabled: z.array(z.string()),
    disabled: z.array(z.string()),
    config: z.record(z.string(), z.any()),
  }),
  // catchall keeps plugin feature keys (features.<configKey>) from being
  // stripped on load; only tavern is a known built-in. Preprocess strips any
  // non-boolean entry FIRST so one malformed value can't throw a ZodError -
  // which load() turns into discarding the entire config to defaults, and the
  // next save() would then wipe real config (auth, mcpServers).
  features: z
    .preprocess(
      v =>
        v && typeof v === 'object' && !Array.isArray(v)
          ? Object.fromEntries(
              Object.entries(v as Record<string, unknown>).filter(([, val]) => typeof val === 'boolean')
            )
          : v,
      z
        .object({
          tavern: z.boolean().optional(),
          hearth: z.boolean().optional(),
        })
        .catchall(z.boolean())
    )
    .optional()
    .prefault({}),
  trustedTools: z.array(z.string()).optional().prefault([]),
  trustedProjects: z.array(z.string()).optional().prefault([]),
  sandbox: SandboxConfigSchema.optional(),
  additionalDirectories: z.array(z.string()).optional().prefault([]),
  fallbackModels: z.array(z.string()).optional(),
});

/**
 * Zod schema for ProjectConfig validation
 */
const ProjectConfigSchema = z.object({
  tools: z
    .object({
      enabled: z.array(z.string()).optional(),
      denied: z.array(z.string()).optional(),
      config: z.record(z.string(), z.any()).optional(),
    })
    .optional(),
  defaultModel: z.string().optional(),
  mcpServers: McpServersSchema.optional(),
  preferences: z
    .object({
      maxTokens: z.number().optional(),
      temperature: z.number().optional(),
      autoSave: z.boolean().optional(),
      autoCompact: z.boolean().optional(),
      // autoUpdate is intentionally NOT project-overridable: the launch updater
      // reads only the global config, and a cloned repo must not be able to
      // force silent auto-install on whoever opens it.
      theme: z.enum(['light', 'dark']).optional(),
      exportFormat: z.enum(['markdown', 'json']).optional(),
      enableSkillTool: z.boolean().optional(),
      enableWorkItemTools: z.boolean().optional(),
      enableDynamicAgentCreation: z.boolean().optional(),
      enableCoordinatorMode: z.boolean().optional(),
      promptVariant: z.enum(['current', 'minimal']).optional(),
    })
    .optional(),
  sandbox: PartialSandboxConfigSchema,
  additionalDirectories: z.array(z.string()).optional(),
});

/**
 * Zod schema for ProjectLocalConfig validation
 */
const ProjectLocalConfigSchema = z.object({
  trustedTools: z.array(z.string()).optional(),
  toolApiKeys: z
    .object({
      openweather: z.string().optional(),
      serper: z.string().optional(),
    })
    .optional(),
  preferences: z
    .object({
      maxTokens: z.number().optional(),
      temperature: z.number().optional(),
      autoSave: z.boolean().optional(),
      autoCompact: z.boolean().optional(),
      // autoUpdate is intentionally NOT local-overridable (global config only) -
      // see the note in ProjectConfigSchema above.
      theme: z.enum(['light', 'dark']).optional(),
      exportFormat: z.enum(['markdown', 'json']).optional(),
      enableSkillTool: z.boolean().optional(),
      enableWorkItemTools: z.boolean().optional(),
      enableDynamicAgentCreation: z.boolean().optional(),
      enableCoordinatorMode: z.boolean().optional(),
    })
    .optional(),
  mcpServers: McpServersSchema.optional(),
  sandbox: PartialSandboxConfigSchema,
});

/**
 * The output budget every pre-migration config was born with, back when
 * `preferences.maxTokens` was required and DEFAULT_CONFIG supplied this value. It is
 * indistinguishable from a user who deliberately typed 4096, and the migration reverts
 * it either way - acceptable only because the cleanup runs ONCE (see CONFIG_SCHEMA_VERSION):
 * a user who wanted 4096 sets it again and keeps it, while an install that never chose it
 * stops being capped by it. A value-keyed rule with no marker would instead make 4096
 * permanently unrepresentable, even though the /config select still offers it.
 */
const LEGACY_PINNED_MAX_TOKENS = 4096;

/**
 * Schema version of the on-disk config, and the marker that makes the migrations in
 * `load()` one-time. A file stamped with anything else gets the upgrade pass and is
 * rewritten at the current version; a file already at it is left alone. Bump this when
 * adding a migration, and gate the new step on the version it needs to run from.
 */
const CONFIG_SCHEMA_VERSION = '0.2.0';

/**
 * Default configuration
 */
const DEFAULT_CONFIG: CliConfig = {
  version: CONFIG_SCHEMA_VERSION,
  userId: uuidv4(),
  defaultModel: ChatModels.CLAUDE_4_5_SONNET,
  toolApiKeys: {
    openweather: undefined,
    serper: undefined,
  },
  mcpServers: [],
  preferences: {
    // maxTokens intentionally absent - see LEGACY_PINNED_MAX_TOKENS.
    temperature: 0.7,
    autoSave: true,
    autoCompact: true,
    // autoUpdate intentionally omitted - undefined means "ask on launch" (consent-first)
    theme: 'dark',
    exportFormat: 'markdown',
    maxIterations: 10,
    enableSkillTool: true,
    enableWorkItemTools: false,
    enableRemoteSkills: true,
    enableDynamicAgentCreation: false,
    enableCoordinatorMode: false,
    promptVariant: 'current',
  },
  tools: {
    enabled: [],
    disabled: ['blog_publish', 'blog_edit', 'blog_draft'], // Web-only tools
    config: {},
  },
  trustedTools: [], // No tools trusted by default
  trustedProjects: [], // No project roots trusted by default (folder-trust gate)
  additionalDirectories: [], // No additional directories by default
};

/**
 * Find project config directory by searching up the directory tree
 * Looks for git repository root (.git directory)
 * Falls back to current working directory if no git repo found
 */
function findProjectConfigDir(startDir: string = process.cwd()): string | null {
  let currentDir = startDir;
  const { root } = path.parse(currentDir);

  // Search up the directory tree for .git directory
  while (currentDir !== root) {
    const gitPath = path.join(currentDir, '.git');
    try {
      if (existsSync(gitPath)) {
        return currentDir;
      }
    } catch {
      // Continue searching
    }
    currentDir = path.dirname(currentDir);
  }

  // No git repo found, use current working directory as fallback
  return process.cwd();
}

/**
 * Canonicalize a path via realpath, returning null if it doesn't exist or can't
 * be resolved. Used so a symlinked or relative project root is compared against
 * the trust set by its real location, and a resolve failure fails safe
 * (untrusted) rather than crashing the launch.
 */
async function safeRealpath(p: string): Promise<string | null> {
  try {
    return await fs.realpath(p);
  } catch {
    return null;
  }
}

/**
 * Load project config from .bike4mind/config.json
 * Returns null if file doesn't exist (this is normal - config.json is optional)
 */
async function loadProjectConfig(projectDir: string): Promise<ProjectConfig | null> {
  const configPath = path.join(projectDir, '.bike4mind', 'config.json');
  try {
    const data = await fs.readFile(configPath, 'utf-8');
    const rawConfig = JSON.parse(data);
    const validated = ProjectConfigSchema.parse(rawConfig);

    // Normalize mcpServers to array format if present
    const result: ProjectConfig = {
      ...validated,
      mcpServers: validated.mcpServers ? normalizeMcpServers(validated.mcpServers) : undefined,
    };

    return result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // File doesn't exist - this is normal, config.json is optional
      return null;
    }
    if (error instanceof z.ZodError) {
      console.error('Project config validation error:', error.issues);
      return null;
    }
    console.error('Failed to load project config:', error);
    return null;
  }
}

/**
 * Load project-local config from .bike4mind/local.json
 */
async function loadProjectLocalConfig(projectDir: string): Promise<ProjectLocalConfig | null> {
  const configPath = path.join(projectDir, '.bike4mind', 'local.json');
  try {
    const data = await fs.readFile(configPath, 'utf-8');
    const rawConfig = JSON.parse(data);
    const validated = ProjectLocalConfigSchema.parse(rawConfig);

    // Normalize mcpServers to array format if present
    const result: ProjectLocalConfig = {
      ...validated,
      mcpServers: validated.mcpServers ? normalizeMcpServers(validated.mcpServers) : undefined,
    };

    return result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    if (error instanceof z.ZodError) {
      console.error('Project local config validation error:', error.issues);
      return null;
    }
    console.error('Failed to load project local config:', error);
    return null;
  }
}

/**
 * Zod schema for .mcp.json format (project-level MCP server configuration)
 * Supports both array and object formats for flexibility
 */
const McpJsonConfigSchema = z.object({
  mcpServers: McpServersSchema,
});

/**
 * Load project MCP configuration from .mcp.json
 * Returns null if file doesn't exist (this is normal - .mcp.json is optional)
 *
 * Supports both formats:
 * - Object format: { "mcpServers": { "name": { "command": "...", ... } } }
 * - Array format: { "mcpServers": [{ "name": "...", "command": "...", ... }] }
 */
async function loadMcpJsonConfig(projectDir: string): Promise<NormalizedMcpServer[] | null> {
  const mcpConfigPath = path.join(projectDir, '.mcp.json');
  try {
    const data = await fs.readFile(mcpConfigPath, 'utf-8');
    const rawConfig = JSON.parse(data);
    const validated = McpJsonConfigSchema.parse(rawConfig);

    // Normalize to array format for internal use
    const servers = normalizeMcpServers(validated.mcpServers);

    return servers;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // File doesn't exist - this is normal, .mcp.json is optional
      return null;
    }
    if (error instanceof z.ZodError) {
      console.error('.mcp.json validation error:', error.issues);
      return null;
    }
    console.error('Failed to load .mcp.json:', error);
    return null;
  }
}

/**
 * Load an explicit `--mcp-config <file>` (claude shape: `{ "mcpServers": {...} }`).
 * Unlike `.mcp.json` this is an absolute path passed at launch, not project-relative.
 * Returns null on missing/malformed file (a bad config must not brick the launch).
 */
async function loadMcpConfigFile(filePath: string): Promise<NormalizedMcpServer[] | null> {
  try {
    const data = await fs.readFile(filePath, 'utf-8');
    const rawConfig = JSON.parse(data);
    const validated = McpJsonConfigSchema.parse(rawConfig);
    return normalizeMcpServers(validated.mcpServers);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      console.error(`--mcp-config file not found: ${filePath}`);
      return null;
    }
    if (error instanceof z.ZodError) {
      console.error('--mcp-config validation error:', error.issues);
      return null;
    }
    console.error('Failed to load --mcp-config file:', error);
    return null;
  }
}

/**
 * Merge MCP servers from multiple configs
 * Later configs can override earlier ones by name
 */
function mergeMcpServers(...serverArrays: (NormalizedMcpServer[] | undefined)[]): NormalizedMcpServer[] {
  const serverMap = new Map<string, NormalizedMcpServer>();

  for (const servers of serverArrays) {
    if (servers) {
      for (const server of servers) {
        serverMap.set(server.name, server);
      }
    }
  }

  return Array.from(serverMap.values());
}

/** Sandbox modes ordered from weakest to strongest posture. */
const SANDBOX_MODE_RANK: Record<SandboxMode, number> = { disabled: 0, 'auto-allow': 1, permissions: 2 };

function intersectStrings(a: string[], b: string[]): string[] {
  const set = new Set(a);
  return b.filter(x => set.has(x));
}

function unionStrings(a: string[], b: string[]): string[] {
  return Array.from(new Set([...a, ...b]));
}

/** True when `target` is `root` itself or nested under it (no `..` escape). */
function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Merge a repo-sourced sandbox override onto the user's base posture so it can
 * only ever TIGHTEN it, never loosen it. A repo layer may enable the sandbox,
 * raise the mode (disabled < auto-allow < permissions) but never select
 * auto-allow itself, add denied paths, narrow read paths / domains / excluded
 * commands, turn the network filter on, and force allowUnsandboxedCommands off.
 * Every loosening value is ignored with a warning. `platform` is ignored.
 */
function tightenSandbox(base: SandboxConfig | undefined, repo: PartialSandboxConfig | undefined): SandboxConfig {
  const b = base ?? DEFAULT_SANDBOX_CONFIG;
  if (!repo) return b;
  const warn = (what: string) => logger.warn(`Ignoring repo sandbox override that would loosen posture: ${what}`);

  const result: SandboxConfig = {
    ...b,
    filesystem: { ...b.filesystem },
    network: { ...b.network },
  };

  if (repo.enabled === true) result.enabled = true;
  else if (repo.enabled === false && b.enabled) warn('sandbox.enabled=false');

  if (repo.mode !== undefined) {
    if (repo.mode === 'auto-allow') warn('sandbox.mode=auto-allow');
    else if (SANDBOX_MODE_RANK[repo.mode] >= SANDBOX_MODE_RANK[b.mode]) result.mode = repo.mode;
    else warn(`sandbox.mode=${repo.mode} weaker than ${b.mode}`);
  }

  if (repo.filesystem) {
    const fsr = repo.filesystem;
    if (fsr.deniedPaths) result.filesystem.deniedPaths = unionStrings(result.filesystem.deniedPaths, fsr.deniedPaths);
    if (fsr.allowedReadPaths)
      result.filesystem.allowedReadPaths = intersectStrings(result.filesystem.allowedReadPaths, fsr.allowedReadPaths);
    if (fsr.writeOnlyToWorkingDir === true) result.filesystem.writeOnlyToWorkingDir = true;
    else if (fsr.writeOnlyToWorkingDir === false && b.filesystem.writeOnlyToWorkingDir)
      warn('filesystem.writeOnlyToWorkingDir=false');
  }

  if (repo.network) {
    const nr = repo.network;
    if (nr.enabled === true) result.network.enabled = true;
    else if (nr.enabled === false && b.network.enabled) warn('network.enabled=false');
    if (nr.allowedDomains)
      result.network.allowedDomains = intersectStrings(result.network.allowedDomains, nr.allowedDomains);
  }

  if (repo.excludedCommands) result.excludedCommands = intersectStrings(result.excludedCommands, repo.excludedCommands);

  if (repo.allowUnsandboxedCommands === false) result.allowUnsandboxedCommands = false;
  else if (repo.allowUnsandboxedCommands === true && !b.allowUnsandboxedCommands) warn('allowUnsandboxedCommands=true');

  // Keep enabled/mode consistent for the schema refine: an enabled sandbox needs
  // a non-disabled mode (default to the strictest), and a disabled one needs
  // mode 'disabled'. This also means a repo cannot enable the sandbox by mode
  // alone - it must set enabled:true, and then never gets auto-allow.
  if (result.enabled && result.mode === 'disabled') result.mode = 'permissions';
  if (!result.enabled) result.mode = 'disabled';

  return result;
}

/**
 * Fold repo-sourced MCP servers under the global set so a repo entry can never
 * REPLACE a same-named global server. Global definitions always win; repo
 * entries only fill names global does not already use. Later repo layers win
 * over earlier ones for names global does not define.
 */
function mergeMcpServersGlobalWins(
  global: NormalizedMcpServer[] | undefined,
  ...repoLayers: (NormalizedMcpServer[] | null | undefined)[]
): NormalizedMcpServer[] {
  const byName = new Map<string, NormalizedMcpServer>();
  for (const layer of repoLayers) {
    if (!layer) continue;
    for (const server of layer) byName.set(server.name, server);
  }
  if (global) {
    for (const server of global) byName.set(server.name, server);
  }
  return Array.from(byName.values());
}

/**
 * Merge configs with priority: global -> project -> local, with the invariant
 * that repo layers may only TIGHTEN the user's global security posture, never
 * loosen it. Sandbox goes through `tightenSandbox`; the repo `trustedTools`
 * union is filtered to tools that can actually be trusted and aren't globally
 * disabled; and any tool a repo tries to re-enable while it is disabled is
 * dropped. `mcpServers` is NOT merged here - callers fold repo servers in via
 * `mergeMcpServersGlobalWins` where all repo layers are visible together.
 */
function mergeConfigs(global: CliConfig, project: ProjectConfig | null, local: ProjectLocalConfig | null): CliConfig {
  const merged: CliConfig = { ...global };

  // Merge project config
  if (project) {
    if (project.defaultModel) {
      merged.defaultModel = project.defaultModel;
    }
    if (project.preferences) {
      merged.preferences = {
        ...merged.preferences,
        ...project.preferences,
      };
    }
    if (project.tools) {
      merged.tools = {
        ...merged.tools,
        enabled: [...(merged.tools.enabled || []), ...(project.tools.enabled || [])],
        disabled: [...merged.tools.disabled, ...(project.tools.denied || [])],
        config: {
          ...merged.tools.config,
          ...project.tools.config,
        },
      };
    }
    if (project.sandbox) {
      merged.sandbox = tightenSandbox(merged.sandbox, project.sandbox);
    }
  }

  // Merge local config
  if (local) {
    if (local.trustedTools) {
      const trustedSet = new Set([...(merged.trustedTools || []), ...local.trustedTools]);
      merged.trustedTools = Array.from(trustedSet);
    }
    if (local.toolApiKeys) {
      merged.toolApiKeys = {
        ...merged.toolApiKeys,
        ...local.toolApiKeys,
      };
    }
    if (local.preferences) {
      merged.preferences = {
        ...merged.preferences,
        ...local.preferences,
      };
    }
    if (local.sandbox) {
      merged.sandbox = tightenSandbox(merged.sandbox, local.sandbox);
    }
  }

  // Never-loosen for tools: a repo cannot re-enable a globally-disabled tool,
  // and a repo-contributed trusted tool must be one that can actually be
  // trusted and isn't disabled. (Global's own trustedTools are left untouched.)
  const disabledSet = new Set(merged.tools.disabled);
  merged.tools = { ...merged.tools, enabled: merged.tools.enabled.filter(t => !disabledSet.has(t)) };
  const globalTrusted = new Set(global.trustedTools || []);
  merged.trustedTools = (merged.trustedTools || []).filter(
    t => globalTrusted.has(t) || (canTrustTool(t) && !disabledSet.has(t))
  );

  return merged;
}

/**
 * Normalize an API URL for use as an `authByEnv` cache key.
 *
 * Without normalization, `/set-api https://x.com` and `/set-api https://x.com/`
 * (or `HTTPS://X.com`) would create separate cache entries, defeating the
 * per-environment token reuse on a later `--dev` / `--prod` switch.
 */
function normalizeEnvKey(url: string): string {
  return url.toLowerCase().replace(/\/+$/, '');
}

/**
 * Treat an auth token as "authenticated" only when it has an `expiresAt` in
 * the future. The startup flow auto-refreshes expired tokens anyway, but
 * without this check the launch banner would briefly claim a saved login is
 * being reused when it's actually about to trigger a re-auth.
 */
function hasValidAuth(auth: AuthTokens | undefined): boolean {
  if (!auth) return false;
  const expiresAt = new Date(auth.expiresAt);
  return expiresAt > new Date();
}

/**
 * Manages CLI configuration stored as JSON
 */
export class ConfigStore {
  private configPath: string;
  private config: CliConfig | null = null;
  private projectConfigDir: string | null = null;
  /**
   * The un-merged, validated GLOBAL config (the disk truth for
   * ~/.bike4mind/config.json). `save()` persists only from here so repo layers
   * are never laundered into the global file; `this.config` is the merged
   * effective config used for reads during the session.
   */
  private globalConfig: CliConfig | null = null;
  /** Canonicalized (realpath'd) discovered project root, or null. */
  private projectRealPath: string | null = null;
  /** Whether the discovered project root is in the global `trustedProjects`. */
  private projectTrusted = false;
  // Raw repo layers, loaded ONLY when the project is trusted. Kept so trust
  // changes can re-merge without re-reading the global config file.
  private rawProjectConfig: ProjectConfig | null = null;
  private rawProjectLocalConfig: ProjectLocalConfig | null = null;
  private rawMcpJsonServers: NormalizedMcpServer[] | null = null;

  constructor(configPath?: string) {
    this.configPath = configPath || path.join(homedir(), '.bike4mind', 'config.json');
  }

  /**
   * Initialize config directory
   */
  private async init(): Promise<void> {
    const dir = path.dirname(this.configPath);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      console.error('Failed to initialize config directory:', error);
      throw error;
    }
  }

  /**
   * Load configuration from disk with Zod validation
   * Merges global -> project -> local configs
   */
  async load(): Promise<CliConfig> {
    if (this.config) {
      return this.config;
    }

    try {
      // Load global config
      let globalConfig: CliConfig;

      try {
        // Check file permissions for security
        try {
          const stats = await fs.stat(this.configPath);
          const mode = stats.mode & 0o777; // Get permission bits

          // Warn if permissions are too open (not 0600)
          if (mode !== 0o600) {
            console.warn(`⚠️  Config file has insecure permissions (${mode.toString(8)}). Setting to 0600...`);
            await fs.chmod(this.configPath, 0o600);
          }
        } catch (statError) {
          // File doesn't exist yet, that's fine
        }

        const data = await fs.readFile(this.configPath, 'utf-8');
        const rawConfig = JSON.parse(data);

        // Auto-migrate old environment-based API config to new simple format
        if (rawConfig.apiConfig && 'environment' in rawConfig.apiConfig) {
          const oldApiConfig = rawConfig.apiConfig as { environment: string; customUrl?: string };

          // Migrate to new format
          if (oldApiConfig.environment === 'custom' && oldApiConfig.customUrl) {
            // Keep custom URL for self-hosted instances
            rawConfig.apiConfig = { customUrl: oldApiConfig.customUrl };
          } else {
            // All other environments (production/staging/preview/local) become the default service
            rawConfig.apiConfig = {}; // No customUrl = use the build-time default service
          }
        }

        // One-time upgrade pass, gated on the version stamp so each step runs against a
        // given file exactly once and is then written back at the current version. Without
        // the stamp a value-keyed step is not a migration at all but a standing rule, and
        // the user can never hold the value it rewrites.
        if (rawConfig.version !== CONFIG_SCHEMA_VERSION) {
          // Clear the legacy pinned output budget. Every config written before maxTokens
          // became optional carries this exact value from the old DEFAULT_CONFIG, not from
          // a user decision - and leaving it pinned keeps starving adaptive reasoning models
          // on machines that have merely *run* an older CLI. Only the untouched legacy value
          // is cleared, so a budget the user actually chose (any other number) survives.
          if (rawConfig.preferences?.maxTokens === LEGACY_PINNED_MAX_TOKENS) {
            delete rawConfig.preferences.maxTokens;
          }
          rawConfig.version = CONFIG_SCHEMA_VERSION;

          // A failed write (read-only home, etc.) is non-fatal: the in-memory result of this
          // pass still applies to the current session and the stamp simply stays behind, so
          // the migration retries on the next launch rather than being silently skipped.
          try {
            await fs.writeFile(this.configPath, JSON.stringify(rawConfig, null, 2), 'utf-8');
          } catch {
            // Intentionally ignored - see above.
          }
        }

        // Validate with Zod - this auto-migrates missing fields
        const validated = CliConfigSchema.parse(rawConfig);

        // Normalize mcpServers to array format
        const normalizedMcpServers = normalizeMcpServers(validated.mcpServers);

        // Merge with defaults to ensure all fields exist
        globalConfig = {
          ...DEFAULT_CONFIG,
          ...validated,
          auth: validated.auth, // Explicitly preserve auth field
          mcpServers: normalizedMcpServers,
          preferences: {
            ...DEFAULT_CONFIG.preferences,
            ...validated.preferences,
          },
          tools: {
            ...DEFAULT_CONFIG.tools,
            ...validated.tools,
          },
          toolApiKeys: {
            ...DEFAULT_CONFIG.toolApiKeys,
            ...(validated.toolApiKeys || {}),
          },
          trustedTools: validated.trustedTools || [],
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          // Global config doesn't exist, use defaults
          // structuredClone, not a spread: a shallow spread would share
          // DEFAULT_CONFIG's mutable arrays (trustedTools/trustedProjects/...),
          // so a later trustTool()/trustProject() would mutate the module
          // singleton and leak into the next default config.
          globalConfig = structuredClone(DEFAULT_CONFIG);
        } else if (error instanceof z.ZodError) {
          console.error('Global config validation error:', error.issues);
          console.error('Using default configuration');
          // structuredClone, not a spread: a shallow spread would share
          // DEFAULT_CONFIG's mutable arrays (trustedTools/trustedProjects/...),
          // so a later trustTool()/trustProject() would mutate the module
          // singleton and leak into the next default config.
          globalConfig = structuredClone(DEFAULT_CONFIG);
        } else {
          throw error;
        }
      }

      // Keep the un-merged global as the disk-truth snapshot: save() persists
      // ONLY from here, never from the merged effective config, so repo layers
      // can't be laundered into ~/.bike4mind/config.json.
      this.globalConfig = globalConfig;

      // Reset per-load project state, then discover + realpath the project root.
      this.projectConfigDir = null;
      this.projectRealPath = null;
      this.projectTrusted = false;
      this.rawProjectConfig = null;
      this.rawProjectLocalConfig = null;
      this.rawMcpJsonServers = null;

      if (process.env.B4M_NO_PROJECT_CONFIG !== '1') {
        this.projectConfigDir = findProjectConfigDir();
        if (this.projectConfigDir) {
          // Canonicalize so a symlinked/relative cwd can't dodge the trust set.
          this.projectRealPath = (await safeRealpath(this.projectConfigDir)) ?? this.projectConfigDir;
          this.projectTrusted = (globalConfig.trustedProjects || []).includes(this.projectRealPath);

          // Repo-committed config/local/.mcp.json load ONLY for a trusted root.
          // Until the folder is trusted they stay inert: not merged, and their
          // MCP servers never reach config.mcpServers (so none can spawn).
          if (this.projectTrusted) {
            const loaded = await this.loadProjectLayers();
            if (loaded.hasConfig) {
              logger.debug(`📁 Project config loaded from: ${this.projectConfigDir}/.bike4mind/`);
            }
            if (loaded.mcpCount > 0) {
              logger.debug(`📁 Project MCP config loaded from: ${this.projectConfigDir}/.mcp.json`);
            }
          }
        }
      }

      this.config = await this.computeMerged();
      return this.config;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Config doesn't exist, create default
        return this.reset();
      }

      // Log Zod validation errors clearly
      if (error instanceof z.ZodError) {
        console.error('Config validation error:', error.issues);
        console.error('Resetting to default configuration');
        return this.reset();
      }

      console.error('Failed to load config:', error);
      throw error;
    }
  }

  /**
   * Load the raw repo config layers for the current project root. Called only
   * for a trusted root; stores them on `this` so trust changes can re-merge
   * without re-reading the global config file.
   */
  private async loadProjectLayers(): Promise<{ hasConfig: boolean; mcpCount: number }> {
    if (!this.projectConfigDir) return { hasConfig: false, mcpCount: 0 };
    this.rawProjectConfig = await loadProjectConfig(this.projectConfigDir);
    this.rawProjectLocalConfig = await loadProjectLocalConfig(this.projectConfigDir);
    this.rawMcpJsonServers = await loadMcpJsonConfig(this.projectConfigDir);
    return { hasConfig: !!this.rawProjectConfig, mcpCount: this.rawMcpJsonServers?.length ?? 0 };
  }

  /**
   * Build the merged effective config from the global layer plus the raw repo
   * layers - but only when the project is trusted, so an untrusted root
   * contributes nothing. Repo MCP servers are folded in global-wins (a repo
   * name can never replace a global server); an explicit `--mcp-config` is host-
   * injected (not repo-sourced) and keeps its override-by-name / strict scope.
   */
  private async computeMerged(): Promise<CliConfig> {
    const global = this.globalConfig!;
    const project = this.projectTrusted ? this.rawProjectConfig : null;
    const local = this.projectTrusted ? this.rawProjectLocalConfig : null;
    const mcpJson = this.projectTrusted ? this.rawMcpJsonServers : null;

    const merged = mergeConfigs(global, project, local);
    merged.mcpServers = mergeMcpServersGlobalWins(global.mcpServers, mcpJson, project?.mcpServers, local?.mcpServers);

    const mcpConfigFile = process.env.B4M_MCP_CONFIG_FILE;
    if (mcpConfigFile) {
      const injected = await loadMcpConfigFile(mcpConfigFile);
      if (process.env.B4M_STRICT_MCP_CONFIG === '1') {
        // Strict means strict: the injected set is the ONLY allowed scope. A
        // malformed/missing file (injected === null) yields an empty set, never
        // a silent fall-back to the broader merged config.
        merged.mcpServers = injected ?? [];
      } else if (injected) {
        merged.mcpServers = mergeMcpServers(merged.mcpServers, injected);
      }
    }

    return merged;
  }

  /** Whether the current project root is trusted (folder-trust gate). */
  isProjectTrusted(): boolean {
    return this.projectTrusted;
  }

  /** Canonicalized project root discovered this session, or null. */
  getProjectRealPath(): string | null {
    return this.projectRealPath;
  }

  /** The realpath'd roots the user has explicitly trusted. */
  getTrustedProjects(): string[] {
    return this.globalConfig?.trustedProjects ? [...this.globalConfig.trustedProjects] : [];
  }

  /**
   * Whether the current project root ships any repo-committed b4m files that the
   * trust gate governs. Used to decide whether the startup trust prompt is even
   * worth showing (nothing to gate = no prompt).
   */
  projectHasB4mFiles(): boolean {
    const root = this.projectConfigDir;
    if (!root) return false;
    const candidates = [
      ['.bike4mind', 'config.json'],
      ['.bike4mind', 'local.json'],
      ['.bike4mind', 'agents'],
      ['.bike4mind', 'commands'],
      ['.mcp.json'],
      ['.claude', 'agents'],
      ['.claude', 'skills'],
      ['.claude', 'commands'],
      // Plain context files (CLAUDE.md etc.) are trust-gated too - they steer the
      // agent, so a context-only repo must still trigger the trust prompt rather
      // than silently loading (or, once gated, silently dropping) its context.
      ...PROJECT_CONTEXT_FILES.map(name => [name]),
    ];
    return candidates.some(parts => existsSync(path.join(root, ...parts)));
  }

  /**
   * Trust a project root (default: the current one). Persists the realpath'd
   * root to the global `trustedProjects` and, when it's the current root, loads
   * its repo layers and re-merges so they take effect for this session.
   */
  async trustProject(root?: string): Promise<boolean> {
    await this.load();
    const target = root ? await safeRealpath(root) : this.projectRealPath;
    if (!target) return false;

    const g = this.globalConfig!;
    if (!g.trustedProjects) g.trustedProjects = [];
    if (!g.trustedProjects.includes(target)) g.trustedProjects.push(target);

    // Trusting the current root: load its layers so the re-merge in save() picks
    // them up. B4M_NO_PROJECT_CONFIG still forces project config off entirely.
    if (target === this.projectRealPath && this.projectConfigDir && process.env.B4M_NO_PROJECT_CONFIG !== '1') {
      this.projectTrusted = true;
      await this.loadProjectLayers();
    }

    await this.save();
    return true;
  }

  /**
   * Revoke trust for a project root (default: the current one). Next launch
   * re-prompts and repo layers stay inert until re-trusted. Revoking the current
   * root drops its raw layers so nothing repo-sourced survives in this session.
   */
  async untrustProject(root?: string): Promise<void> {
    await this.load();
    const target = root ? await safeRealpath(root) : this.projectRealPath;
    if (!target) return;

    const g = this.globalConfig!;
    g.trustedProjects = (g.trustedProjects || []).filter(p => p !== target);

    if (target === this.projectRealPath) {
      this.projectTrusted = false;
      this.rawProjectConfig = null;
      this.rawProjectLocalConfig = null;
      this.rawMcpJsonServers = null;
    }

    await this.save();
  }

  /**
   * Read the features map straight from the global config file, bypassing the
   * in-memory cache. save() merges over this so concurrent writers (the
   * interactive session vs `b4m plugin add`) don't clobber each other's keys.
   */
  private async readDiskFeatures(): Promise<Record<string, boolean>> {
    try {
      const raw = JSON.parse(await fs.readFile(this.configPath, 'utf-8')) as {
        features?: Record<string, unknown>;
      };
      // Return only boolean entries so callers that write this back (e.g.
      // switchApiEnvironment) or merge over it can't reintroduce a bogus value.
      return Object.fromEntries(Object.entries(raw.features ?? {}).filter(([, v]) => typeof v === 'boolean')) as Record<
        string,
        boolean
      >;
    } catch {
      return {};
    }
  }

  /**
   * Merge a features save against the current on-disk map. Start from disk and
   * apply only the keys the caller actually CHANGED relative to the snapshot it
   * loaded - so a concurrent writer's edit to a key this caller didn't touch
   * survives, and a key this caller removed is dropped. This is what makes the
   * cross-process guarantee hold even for conflicting edits, not just new keys.
   */
  private mergeFeatures(
    disk: Record<string, boolean>,
    snapshot: Record<string, boolean | undefined> | undefined,
    incoming: Record<string, boolean | undefined> | undefined
  ): Record<string, boolean> {
    const base = snapshot ?? {};
    const next = incoming ?? base;
    const has = (o: Record<string, boolean | undefined>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
    const merged: Record<string, boolean> = { ...disk };
    // Keys the caller added or flipped vs its load-time snapshot win. Own-key
    // checks only (never the prototype chain) so a key like 'toString' can't
    // read as "already present".
    for (const key of Object.keys(next)) {
      const value = next[key];
      if (value !== undefined && (!has(base, key) || base[key] !== value)) {
        merged[key] = value;
      }
    }
    // Keys the caller intentionally removed (present at load, absent now) go.
    for (const key of Object.keys(base)) {
      if (!has(next, key)) {
        delete merged[key];
      }
    }
    return merged;
  }

  /**
   * Save configuration to disk
   */
  async save(config?: GlobalConfigPatch, opts?: { clearFeatures?: boolean }): Promise<void> {
    await this.init();

    // Ensure the global snapshot exists (first save on a fresh store).
    if (!this.globalConfig) {
      await this.load();
    }
    const global = this.globalConfig!;

    if (config) {
      // The security-critical, repo-launderable fields never flow through a
      // generic save(): the structural sets (mcpServers / trustedTools /
      // additionalDirectories / trustedProjects) and the security-posture fields
      // (tools / sandbox) change ONLY via their dedicated mutators (addMcpServer,
      // trustTool, saveSandboxConfig, trustProject, ...). Stripping them here - a
      // runtime allowlist on top of the GlobalConfigPatch type - means even a
      // caller that casts past the type and spreads the merged effective config
      // can't re-launder THOSE fields into ~/.bike4mind/config.json. It does NOT
      // guard defaultModel / preferences / toolApiKeys, which stay writable (that
      // is what /model and /config edit): callers must pass user-changed values,
      // not the merged rest - see buildGlobalConfigPatch.
      const { mcpServers, trustedTools, additionalDirectories, trustedProjects, tools, sandbox, ...rest } =
        config as Partial<CliConfig>;
      void mcpServers;
      void trustedTools;
      void additionalDirectories;
      void trustedProjects;
      void tools;
      void sandbox;

      this.globalConfig = {
        ...global,
        ...rest,
        auth: 'auth' in config ? config.auth : global.auth,
        preferences: {
          ...global.preferences,
          ...(config.preferences || {}),
        },
        toolApiKeys: {
          ...global.toolApiKeys,
          ...(config.toolApiKeys || {}),
        },
        // Merge features against the fresh on-disk map, applying only the keys
        // this caller changed vs its load-time snapshot, so a concurrent writer
        // (e.g. `b4m plugin add` in another process) isn't clobbered - including
        // conflicting edits, not just brand-new keys.
        features: opts?.clearFeatures
          ? {}
          : this.mergeFeatures(await this.readDiskFeatures(), global.features, config.features ?? global.features),
      };
    } else {
      // No-arg save persists the global layer a mutator just changed in place;
      // refresh features from disk so a concurrent writer isn't reverted - unless
      // this is a reset, which intentionally wipes the feature map.
      this.globalConfig = { ...global, features: opts?.clearFeatures ? {} : await this.readDiskFeatures() };
    }

    try {
      // Persist ONLY the global layer, never the merged effective config.
      await fs.writeFile(this.configPath, JSON.stringify(this.globalConfig, null, 2), 'utf-8');

      // Set secure permissions (0600 - only owner can read/write)
      // This protects auth tokens and API keys from other users
      await fs.chmod(this.configPath, 0o600);
    } catch (error) {
      console.error('Failed to save config:', error);
      throw error;
    }

    // Refresh the merged effective config from the freshly-persisted global.
    this.config = await this.computeMerged();
  }

  /**
   * Reset configuration to defaults
   */
  async reset(): Promise<CliConfig> {
    // structuredClone so reset never shares DEFAULT_CONFIG's mutable arrays.
    this.globalConfig = { ...structuredClone(DEFAULT_CONFIG), userId: uuidv4() };
    this.projectTrusted = false;
    this.rawProjectConfig = null;
    this.rawProjectLocalConfig = null;
    this.rawMcpJsonServers = null;
    // clearFeatures: a reset must wipe the on-disk feature map too, not inherit it
    // via save()'s concurrent-writer disk-merge (reached e.g. from load()'s
    // corrupt-config recovery path).
    await this.save(undefined, { clearFeatures: true });
    return this.config!;
  }

  /**
   * Get current configuration
   */
  async get(): Promise<CliConfig> {
    return this.load();
  }

  /**
   * Update a specific configuration value
   */
  async update(updates: GlobalConfigPatch): Promise<void> {
    await this.save(updates);
  }

  /**
   * Persist a sandbox config to the GLOBAL layer (the `/sandbox` handlers' path).
   * Sandbox is excluded from the generic `save()` allowlist so it flows only
   * through here - a merged-config save() can never launder a repo-tightened
   * sandbox into the user's global default.
   */
  async saveSandboxConfig(sandbox: SandboxConfig): Promise<void> {
    await this.load();
    // Clone at the boundary: callers pass the orchestrator's live config object, so
    // aliasing it into globalConfig would make a later unrelated save() serialize
    // whatever in-memory sandbox state has since mutated.
    this.globalConfig!.sandbox = structuredClone(sandbox);
    await this.save();
  }

  /**
   * Add MCP server configuration
   */
  async addMcpServer(server: CliConfig['mcpServers'][0]): Promise<void> {
    await this.load();
    const g = this.globalConfig!;
    // Remove existing server with same name, then add (operates on GLOBAL only).
    g.mcpServers = g.mcpServers.filter(s => s.name !== server.name);
    g.mcpServers.push(server);
    await this.save();
  }

  /**
   * Remove MCP server configuration
   */
  async removeMcpServer(name: string): Promise<void> {
    await this.load();
    const g = this.globalConfig!;
    g.mcpServers = g.mcpServers.filter(s => s.name !== name);
    await this.save();
  }

  /**
   * Enable/disable MCP server
   */
  async toggleMcpServer(name: string, enabled: boolean): Promise<void> {
    await this.load();
    const g = this.globalConfig!;
    const server = g.mcpServers.find(s => s.name === name);
    if (server) {
      server.enabled = enabled;
      await this.save();
    }
  }

  /**
   * Add a tool to trusted tools list
   */
  async trustTool(toolName: string): Promise<void> {
    await this.load();
    const g = this.globalConfig!;
    if (!g.trustedTools) {
      g.trustedTools = [];
    }
    if (!g.trustedTools.includes(toolName)) {
      g.trustedTools.push(toolName);
      await this.save();
    }
  }

  /**
   * Remove a tool from trusted tools list
   */
  async untrustTool(toolName: string): Promise<void> {
    await this.load();
    const g = this.globalConfig!;
    if (g.trustedTools) {
      g.trustedTools = g.trustedTools.filter(t => t !== toolName);
      await this.save();
    }
  }

  /**
   * Get list of trusted tools (merged effective view)
   */
  async getTrustedTools(): Promise<string[]> {
    const config = await this.load();
    return config.trustedTools || [];
  }

  /**
   * Clear all trusted tools
   */
  async clearTrustedTools(): Promise<void> {
    await this.load();
    this.globalConfig!.trustedTools = [];
    await this.save();
  }

  /**
   * Get authentication tokens
   */
  async getAuthTokens(): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresAt: string;
    userId: string;
  } | null> {
    const config = await this.load();
    return config.auth || null;
  }

  /**
   * Set authentication tokens
   */
  async setAuthTokens(tokens: {
    accessToken: string;
    refreshToken: string;
    expiresAt: string;
    userId: string;
  }): Promise<void> {
    await this.load();
    this.globalConfig!.auth = tokens;
    await this.save();
  }

  /**
   * Clear authentication tokens (logout)
   */
  async clearAuthTokens(): Promise<void> {
    await this.load();
    this.globalConfig!.auth = undefined;
    await this.save();
  }

  /**
   * Check if user is authenticated
   */
  async isAuthenticated(): Promise<boolean> {
    const tokens = await this.getAuthTokens();
    if (!tokens) return false;

    // Check if token is expired
    const expiresAt = new Date(tokens.expiresAt);
    return expiresAt > new Date();
  }

  /**
   * Get API configuration
   */
  async getApiConfig(): Promise<CliConfig['apiConfig']> {
    const config = await this.load();
    return config.apiConfig;
  }

  /**
   * Set custom API URL for a self-hosted instance.
   * Pass null to reset to the build-time default service.
   */
  async setCustomApiUrl(url: string | null): Promise<void> {
    await this.load();
    // Reset to the build-time default service (null) or set a self-hosted URL.
    this.globalConfig!.apiConfig = url === null ? undefined : { customUrl: url };
    await this.save();
  }

  /**
   * Switch the active API environment, caching auth tokens per-environment so
   * flipping between `--dev` and `--prod` doesn't force a re-login each time you
   * return to an environment you've already authenticated.
   *
   * Targets:
   *  - 'prod'              -> the build-time default service (clears customUrl)
   *  - 'dev'               -> local dev server (http://localhost:3000)
   *  - { customUrl: '...' }  -> arbitrary self-hosted URL
   *
   * Mutates the cached config in place and persists via `save()` (no argument)
   * so the write bypasses save()'s field-merge - `save(config)` would otherwise
   * preserve the previous `auth` and defeat the per-env swap.
   */
  async switchApiEnvironment(
    target: 'dev' | 'prod' | { customUrl: string }
  ): Promise<{ url: string; envName: string; changed: boolean; authenticated: boolean }> {
    await this.load();
    const g = this.globalConfig!;

    const prevUrl = g.apiConfig?.customUrl || getDefaultApiUrl();
    const prevKey = normalizeEnvKey(prevUrl);

    let newUrl: string;
    let newApiConfig: CliConfig['apiConfig'];
    if (target === 'prod') {
      newUrl = getDefaultApiUrl();
      newApiConfig = undefined;
    } else if (target === 'dev') {
      newUrl = LOCAL_DEV_URL;
      newApiConfig = { customUrl: LOCAL_DEV_URL };
    } else {
      newUrl = target.customUrl;
      newApiConfig = { customUrl: target.customUrl };
    }
    const newKey = normalizeEnvKey(newUrl);

    const envName = getEnvironmentName(newApiConfig);

    // No-op when already pointed at the requested environment - leave auth alone.
    if (prevKey === newKey) {
      return { url: newUrl, envName, changed: false, authenticated: hasValidAuth(g.auth) };
    }

    // Stash the current environment's token before switching away from it.
    // Keyed by a normalized URL (lowercase, no trailing slash) so trivial input
    // variations like `/set-api https://x.com/` vs `https://X.com` share an entry.
    const authByEnv: Record<string, AuthTokens> = { ...(g.authByEnv || {}) };
    if (g.auth) {
      authByEnv[prevKey] = g.auth;
    } else {
      delete authByEnv[prevKey];
    }

    // Restore the target environment's previously-cached token (if any).
    const restored = authByEnv[newKey];

    g.apiConfig = newApiConfig;
    g.authByEnv = authByEnv;
    g.auth = restored; // undefined → user will be prompted to /login

    // No-arg save() persists these global mutations and refreshes features from
    // disk, so a concurrent `b4m plugin add` isn't reverted by this switch.
    await this.save();

    return { url: newUrl, envName, changed: true, authenticated: hasValidAuth(restored) };
  }

  /**
   * Get project config directory (if any)
   */
  getProjectConfigDir(): string | null {
    return this.projectConfigDir;
  }

  /**
   * Initialize project config directory
   * Creates .bike4mind/ directory and ensures local.json is gitignored
   * Does NOT auto-create config.json (user creates that manually)
   */
  async initProjectConfig(): Promise<void> {
    const projectDir = this.projectConfigDir || findProjectConfigDir();
    if (!projectDir) {
      return; // No project directory found
    }

    const configDir = path.join(projectDir, '.bike4mind');

    // Create .bike4mind directory
    await fs.mkdir(configDir, { recursive: true });

    // Ensure .gitignore includes local.json
    await this.ensureGitignore(projectDir);
  }

  /**
   * Ensure .gitignore includes .bike4mind/local.json
   */
  private async ensureGitignore(projectDir: string): Promise<void> {
    const gitignorePath = path.join(projectDir, '.gitignore');
    const entryToAdd = '.bike4mind/local.json';

    try {
      // Read existing .gitignore
      let gitignoreContent = '';
      try {
        gitignoreContent = await fs.readFile(gitignorePath, 'utf-8');
      } catch {
        // .gitignore doesn't exist, that's fine
      }

      // Check if entry already exists
      if (gitignoreContent.includes(entryToAdd)) {
        return;
      }

      // Add entry to .gitignore
      const newContent =
        gitignoreContent.trim() +
        (gitignoreContent ? '\n' : '') +
        `\n# Bike4Mind local config (developer-specific)\n${entryToAdd}\n`;
      await fs.writeFile(gitignorePath, newContent, 'utf-8');
      console.log(`✅ Added ${entryToAdd} to .gitignore`);
    } catch (error) {
      console.warn(`⚠️  Failed to update .gitignore:`, error);
    }
  }

  /**
   * Save project config to .bike4mind/config.json
   */
  async saveProjectConfig(config: ProjectConfig, projectDir?: string): Promise<void> {
    const targetDir = projectDir || this.projectConfigDir || process.cwd();
    const configPath = path.join(targetDir, '.bike4mind', 'config.json');

    // Ensure directory exists
    await fs.mkdir(path.dirname(configPath), { recursive: true });

    // Validate with Zod
    const validated = ProjectConfigSchema.parse(config);

    // Write config
    await fs.writeFile(configPath, JSON.stringify(validated, null, 2), 'utf-8');
    console.log(`✅ Saved project config to: ${configPath}`);
  }

  /**
   * Save project-local config to .bike4mind/local.json
   */
  async saveProjectLocalConfig(config: ProjectLocalConfig, projectDir?: string): Promise<void> {
    const targetDir = projectDir || this.projectConfigDir || process.cwd();
    const configPath = path.join(targetDir, '.bike4mind', 'local.json');

    // Ensure directory exists
    await fs.mkdir(path.dirname(configPath), { recursive: true });

    // Validate with Zod
    const validated = ProjectLocalConfigSchema.parse(config);

    // Write config
    await fs.writeFile(configPath, JSON.stringify(validated, null, 2), 'utf-8');

    // Set secure permissions (0600 - only owner can read/write)
    await fs.chmod(configPath, 0o600);

    console.log(`✅ Saved project-local config to: ${configPath}`);
  }

  /**
   * Load raw project config (without merging)
   */
  async loadRawProjectConfig(): Promise<ProjectConfig | null> {
    if (!this.projectConfigDir) {
      return null;
    }
    return loadProjectConfig(this.projectConfigDir);
  }

  /**
   * Load raw project-local config (without merging)
   */
  async loadRawProjectLocalConfig(): Promise<ProjectLocalConfig | null> {
    if (!this.projectConfigDir) {
      return null;
    }
    return loadProjectLocalConfig(this.projectConfigDir);
  }

  /**
   * Add a directory to the allowed directories list
   * Persists to global config
   */
  async addDirectory(dirPath: string): Promise<void> {
    await this.load();
    const g = this.globalConfig!;
    if (!g.additionalDirectories) {
      g.additionalDirectories = [];
    }

    // Resolve to absolute path
    const resolvedPath = path.resolve(dirPath);

    // Don't add duplicates
    if (!g.additionalDirectories.includes(resolvedPath)) {
      g.additionalDirectories.push(resolvedPath);
      await this.save();
    }
  }

  /**
   * Remove a directory from the allowed directories list
   */
  async removeDirectory(dirPath: string): Promise<void> {
    await this.load();
    const g = this.globalConfig!;
    if (g.additionalDirectories) {
      // Resolve to absolute path for comparison
      const resolvedPath = path.resolve(dirPath);
      g.additionalDirectories = g.additionalDirectories.filter(d => path.resolve(d) !== resolvedPath);
      await this.save();
    }
  }

  /**
   * Get all additional directories (global config + trusted-project config).
   * Returns resolved absolute paths. Project-declared directories are included
   * ONLY when the project is trusted, and each must resolve inside the project
   * root (a repo cannot widen file access beyond its own tree).
   */
  async getAdditionalDirectories(): Promise<string[]> {
    await this.load();
    const g = this.globalConfig!;
    const dirs = new Set<string>();

    // Global config directories are the user's own - no containment check.
    if (g.additionalDirectories) {
      for (const dir of g.additionalDirectories) {
        dirs.add(path.resolve(dir));
      }
    }

    // Project config directories: trusted-only, and confined to the project root.
    if (this.projectTrusted && this.rawProjectConfig?.additionalDirectories) {
      const projectRoot = this.projectRealPath || this.projectConfigDir;
      if (projectRoot) {
        for (const dir of this.rawProjectConfig.additionalDirectories) {
          const resolved = path.resolve(projectRoot, dir);
          // Canonicalize before the containment check: a committed symlink
          // (e.g. `evil -> /`) passes the textual isWithin() on its logical path
          // but escapes once resolved. safeRealpath returning null (missing /
          // unresolvable) fails safe - the entry is dropped. The realpath'd path
          // is what we hand downstream, so pathValidation can't re-expand it.
          const real = await safeRealpath(resolved);
          if (real && isWithin(projectRoot, real)) {
            dirs.add(real);
          } else {
            logger.warn(`Ignoring project additionalDirectory outside project root: ${dir}`);
          }
        }
      }
    }

    return Array.from(dirs);
  }
}
