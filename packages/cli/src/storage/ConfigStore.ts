import { promises as fs, existsSync } from 'fs';
import path from 'path';
import { homedir } from 'os';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { ChatModels } from '@bike4mind/common';
import type { AuthTokens, CliConfig, ProjectConfig, ProjectLocalConfig } from './types';
import { getDefaultApiUrl, LOCAL_DEV_URL, getEnvironmentName } from '../utils/apiUrl';
import { DEFAULT_SANDBOX_CONFIG, type PartialSandboxConfig, type SandboxConfig } from '../sandbox/types.js';
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
    maxTokens: z.number(),
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
  // stripped on load; only tavern is a known built-in.
  features: z
    .object({
      tavern: z.boolean().optional(),
    })
    .catchall(z.boolean())
    .optional()
    .prefault({}),
  trustedTools: z.array(z.string()).optional().prefault([]),
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
      enableDynamicAgentCreation: z.boolean().optional(),
      enableCoordinatorMode: z.boolean().optional(),
    })
    .optional(),
  mcpServers: McpServersSchema.optional(),
  sandbox: PartialSandboxConfigSchema,
});

/**
 * Default configuration
 */
const DEFAULT_CONFIG: CliConfig = {
  version: '0.1.0',
  userId: uuidv4(),
  defaultModel: ChatModels.CLAUDE_4_5_SONNET,
  toolApiKeys: {
    openweather: undefined,
    serper: undefined,
  },
  mcpServers: [],
  preferences: {
    maxTokens: 4096,
    temperature: 0.7,
    autoSave: true,
    autoCompact: true,
    // autoUpdate intentionally omitted - undefined means "ask on launch" (consent-first)
    theme: 'dark',
    exportFormat: 'markdown',
    maxIterations: 10,
    enableSkillTool: true,
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

/**
 * Deep-merge sandbox configs. Later values override earlier ones.
 * Arrays (allowedReadPaths, deniedPaths, excludedCommands) are replaced, not concatenated.
 */
function mergeSandboxConfig(
  base: SandboxConfig | undefined,
  override: PartialSandboxConfig | undefined
): SandboxConfig {
  const resolved = base ?? DEFAULT_SANDBOX_CONFIG;
  if (!override) return resolved;

  return {
    enabled: override.enabled ?? resolved.enabled,
    mode: override.mode ?? resolved.mode,
    filesystem: {
      ...resolved.filesystem,
      ...(override.filesystem ?? {}),
    },
    network: {
      ...resolved.network,
      ...(override.network ?? {}),
    },
    excludedCommands: override.excludedCommands ?? resolved.excludedCommands,
    allowUnsandboxedCommands: override.allowUnsandboxedCommands ?? resolved.allowUnsandboxedCommands,
    platform: override.platform ?? resolved.platform,
  };
}

/**
 * Merge configs with priority: global -> project -> local
 * Each layer overrides the previous one
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
    if (project.mcpServers) {
      merged.mcpServers = mergeMcpServers(merged.mcpServers, project.mcpServers);
    }
    if (project.sandbox) {
      merged.sandbox = mergeSandboxConfig(merged.sandbox, project.sandbox);
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
    if (local.mcpServers) {
      merged.mcpServers = mergeMcpServers(merged.mcpServers, local.mcpServers);
    }
    if (local.sandbox) {
      merged.sandbox = mergeSandboxConfig(merged.sandbox, local.sandbox);
    }
  }

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
          globalConfig = { ...DEFAULT_CONFIG };
        } else if (error instanceof z.ZodError) {
          console.error('Global config validation error:', error.issues);
          console.error('Using default configuration');
          globalConfig = { ...DEFAULT_CONFIG };
        } else {
          throw error;
        }
      }

      // Discover project config directory (unless disabled via --no-project-config)
      let projectConfig: ProjectConfig | null = null;
      let projectLocalConfig: ProjectLocalConfig | null = null;
      let mcpJsonServers: NormalizedMcpServer[] | null = null;

      if (process.env.B4M_NO_PROJECT_CONFIG !== '1') {
        this.projectConfigDir = findProjectConfigDir();

        // Load project configs if found
        if (this.projectConfigDir) {
          projectConfig = await loadProjectConfig(this.projectConfigDir);
          projectLocalConfig = await loadProjectLocalConfig(this.projectConfigDir);
          mcpJsonServers = await loadMcpJsonConfig(this.projectConfigDir);

          if (projectConfig) {
            logger.debug(`📁 Project config loaded from: ${this.projectConfigDir}/.bike4mind/`);
          }
          if (mcpJsonServers && mcpJsonServers.length > 0) {
            logger.debug(`📁 Project MCP config loaded from: ${this.projectConfigDir}/.mcp.json`);
          }
        }
      } else {
        this.projectConfigDir = null;
      }

      // Merge configs: .mcp.json -> global -> project -> local
      // Start with global config
      const mergedConfig = mergeConfigs(globalConfig, projectConfig, projectLocalConfig);

      // Merge .mcp.json servers with lowest priority (can be overridden by B4M configs)
      if (mcpJsonServers && mcpJsonServers.length > 0) {
        mergedConfig.mcpServers = mergeMcpServers(mcpJsonServers, mergedConfig.mcpServers);
      }

      // --mcp-config <file>: claude-shape MCP servers injected per-launch (e.g. by
      // a host - HTTP+Bearer with a freshly-minted token). When --strict-mcp-config
      // is set, use ONLY these servers (ignore file-config + .mcp.json). Otherwise
      // merge them with highest priority so the injected server overrides by name.
      const mcpConfigFile = process.env.B4M_MCP_CONFIG_FILE;
      if (mcpConfigFile) {
        const injected = await loadMcpConfigFile(mcpConfigFile);
        if (process.env.B4M_STRICT_MCP_CONFIG === '1') {
          // Strict means strict: the injected set is the ONLY allowed scope. A
          // malformed/missing file (injected === null) yields an empty set, never a
          // silent fall-back to the broader merged config - that would leak the
          // user's other MCP servers into a pane meant to be locked (e.g. YAML).
          mergedConfig.mcpServers = injected ?? [];
        } else if (injected) {
          mergedConfig.mcpServers = mergeMcpServers(mergedConfig.mcpServers, injected);
        }
      }

      this.config = mergedConfig;

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
   * Read the features map straight from the global config file, bypassing the
   * in-memory cache. save() merges over this so concurrent writers (the
   * interactive session vs `b4m plugin add`) don't clobber each other's keys.
   */
  private async readDiskFeatures(): Promise<Record<string, boolean>> {
    try {
      const raw = JSON.parse(await fs.readFile(this.configPath, 'utf-8')) as {
        features?: Record<string, boolean>;
      };
      return raw.features ?? {};
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
  async save(config?: Partial<CliConfig>): Promise<void> {
    await this.init();

    if (config) {
      // Merge with existing config
      const existingConfig = await this.load();
      this.config = {
        ...existingConfig,
        ...config,
        auth: config.auth !== undefined ? config.auth : existingConfig.auth,
        preferences: {
          ...existingConfig.preferences,
          ...(config.preferences || {}),
        },
        tools: {
          ...existingConfig.tools,
          ...(config.tools || {}),
        },
        toolApiKeys: {
          ...existingConfig.toolApiKeys,
          ...(config.toolApiKeys || {}),
        },
        // Merge features against the fresh on-disk map, applying only the keys
        // this caller changed vs its load-time snapshot, so a concurrent writer
        // (e.g. `b4m plugin add` in another process) isn't clobbered - including
        // conflicting edits, not just brand-new keys.
        features: this.mergeFeatures(
          await this.readDiskFeatures(),
          existingConfig.features,
          config.features ?? existingConfig.features
        ),
      };
    }

    if (!this.config) {
      throw new Error('No configuration to save');
    }

    try {
      await fs.writeFile(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');

      // Set secure permissions (0600 - only owner can read/write)
      // This protects auth tokens and API keys from other users
      await fs.chmod(this.configPath, 0o600);
    } catch (error) {
      console.error('Failed to save config:', error);
      throw error;
    }
  }

  /**
   * Reset configuration to defaults
   */
  async reset(): Promise<CliConfig> {
    this.config = { ...DEFAULT_CONFIG, userId: uuidv4() };
    await this.save();
    return this.config;
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
  async update(updates: Partial<CliConfig>): Promise<void> {
    await this.save(updates);
  }

  /**
   * Add MCP server configuration
   */
  async addMcpServer(server: CliConfig['mcpServers'][0]): Promise<void> {
    const config = await this.load();
    // Remove existing server with same name
    config.mcpServers = config.mcpServers.filter(s => s.name !== server.name);
    config.mcpServers.push(server);
    await this.save(config);
  }

  /**
   * Remove MCP server configuration
   */
  async removeMcpServer(name: string): Promise<void> {
    const config = await this.load();
    config.mcpServers = config.mcpServers.filter(s => s.name !== name);
    await this.save(config);
  }

  /**
   * Enable/disable MCP server
   */
  async toggleMcpServer(name: string, enabled: boolean): Promise<void> {
    const config = await this.load();
    const server = config.mcpServers.find(s => s.name === name);
    if (server) {
      server.enabled = enabled;
      await this.save(config);
    }
  }

  /**
   * Add a tool to trusted tools list
   */
  async trustTool(toolName: string): Promise<void> {
    const config = await this.load();
    if (!config.trustedTools) {
      config.trustedTools = [];
    }
    if (!config.trustedTools.includes(toolName)) {
      config.trustedTools.push(toolName);
      await this.save(config);
    }
  }

  /**
   * Remove a tool from trusted tools list
   */
  async untrustTool(toolName: string): Promise<void> {
    const config = await this.load();
    if (config.trustedTools) {
      config.trustedTools = config.trustedTools.filter(t => t !== toolName);
      await this.save(config);
    }
  }

  /**
   * Get list of trusted tools
   */
  async getTrustedTools(): Promise<string[]> {
    const config = await this.load();
    return config.trustedTools || [];
  }

  /**
   * Clear all trusted tools
   */
  async clearTrustedTools(): Promise<void> {
    const config = await this.load();
    config.trustedTools = [];
    await this.save(config);
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
    const config = await this.load();
    config.auth = tokens;
    await this.save(config);
  }

  /**
   * Clear authentication tokens (logout)
   */
  async clearAuthTokens(): Promise<void> {
    const config = await this.load();
    config.auth = undefined;
    await this.save(config);
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
    const config = await this.load();

    if (url === null) {
      // Reset to the build-time default service
      config.apiConfig = undefined;
    } else {
      // Set custom URL for self-hosted instance
      config.apiConfig = { customUrl: url };
    }

    await this.save(config);
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
    const config = await this.load();

    const prevUrl = config.apiConfig?.customUrl || getDefaultApiUrl();
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
      return { url: newUrl, envName, changed: false, authenticated: hasValidAuth(config.auth) };
    }

    // Stash the current environment's token before switching away from it.
    // Keyed by a normalized URL (lowercase, no trailing slash) so trivial input
    // variations like `/set-api https://x.com/` vs `https://X.com` share an entry.
    const authByEnv: Record<string, AuthTokens> = { ...(config.authByEnv || {}) };
    if (config.auth) {
      authByEnv[prevKey] = config.auth;
    } else {
      delete authByEnv[prevKey];
    }

    // Restore the target environment's previously-cached token (if any).
    const restored = authByEnv[newKey];

    config.apiConfig = newApiConfig;
    config.authByEnv = authByEnv;
    config.auth = restored; // undefined → user will be prompted to /login

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
    const config = await this.load();
    if (!config.additionalDirectories) {
      config.additionalDirectories = [];
    }

    // Resolve to absolute path
    const resolvedPath = path.resolve(dirPath);

    // Don't add duplicates
    if (!config.additionalDirectories.includes(resolvedPath)) {
      config.additionalDirectories.push(resolvedPath);
      await this.save(config);
    }
  }

  /**
   * Remove a directory from the allowed directories list
   */
  async removeDirectory(dirPath: string): Promise<void> {
    const config = await this.load();
    if (config.additionalDirectories) {
      // Resolve to absolute path for comparison
      const resolvedPath = path.resolve(dirPath);
      config.additionalDirectories = config.additionalDirectories.filter(d => path.resolve(d) !== resolvedPath);
      await this.save(config);
    }
  }

  /**
   * Get all additional directories (merged from global + project configs)
   * Returns resolved absolute paths
   */
  async getAdditionalDirectories(): Promise<string[]> {
    const config = await this.load();
    const dirs = new Set<string>();

    // Add global config directories
    if (config.additionalDirectories) {
      for (const dir of config.additionalDirectories) {
        dirs.add(path.resolve(dir));
      }
    }

    // Add project config directories
    const projectConfig = await this.loadRawProjectConfig();
    if (projectConfig?.additionalDirectories) {
      // Project directories are relative to project root
      const projectRoot = this.projectConfigDir || process.cwd();
      for (const dir of projectConfig.additionalDirectories) {
        dirs.add(path.resolve(projectRoot, dir));
      }
    }

    return Array.from(dirs);
  }
}
