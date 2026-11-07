import { promises as fs, existsSync } from 'fs';
import { createHash } from 'node:crypto';
import path from 'path';
import { homedir } from 'os';
import { isDeepStrictEqual } from 'node:util';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { ChatModels } from '@bike4mind/common';
import { isAuthTokenValid, normalizeEnvKey, swapActiveEnvAuth } from '@bike4mind/client-auth';
import type { AuthTokens, CliConfig, GlobalConfigPatch, ProjectConfig, ProjectLocalConfig } from './types';
import { getDefaultApiUrl, LOCAL_DEV_URL, getEnvironmentName } from '../utils/apiUrl';
import {
  DEFAULT_SANDBOX_CONFIG,
  type PartialSandboxConfig,
  type SandboxConfig,
  type SandboxMode,
} from '../sandbox/types.js';
import { resolveStaticToolDescriptor } from '../tools/gateway/toolCatalog.js';
import { canTrustTool } from '../tools/gateway/toolPolicy.js';
import { PROJECT_CONTEXT_FILES } from '../utils/contextLoader';
import { escapeTerminalControlChars, sanitizeTerminalText } from '../utils/sanitizeTerminalText.js';
import { logger } from '../utils/Logger';
import { withLockDir, type HeldLock } from './lockDir';

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
    allowContainerSockets: z.boolean().default(false),
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
    allowContainerSockets: z.boolean().optional(),
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
  endpointChosen: z.boolean().optional(),
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
    autoCompact: z.boolean().prefault(true),
    // No prefault: an absent flag means "ask on launch" (consent-first), so the
    // tri-state must survive as undefined rather than being coerced to true/false.
    autoUpdate: z.boolean().optional(),
    theme: z.enum(['light', 'dark']),
    exportFormat: z.enum(['markdown', 'json']),
    maxIterations: z.number().nullable().prefault(10),
    enableSkillTool: z.boolean().prefault(true),
    // Six always-on tools would sit in every completion's schema list; off by
    // default so only users who want persistent tracking pay for them.
    enableWorkItemTools: z.boolean().prefault(false),
    /**
     * When false (or set via the `--no-remote-skills` CLI flag / the
     * `B4M_NO_REMOTE_SKILLS=1` env var), the CLI skips fetching skills from
     * the B4M backend's `/api/skills` endpoint and runs with local files only.
     * Defaults to true so authenticated users get cross-machine skill sync
     * out of the box.
     */
    enableRemoteSkills: z.boolean().prefault(true),
    enableDynamicAgentCreation: z.boolean().prefault(false),
    enableCoordinatorMode: z.boolean().prefault(false),
    // Deliberately absent from the project/local schemas: checking runs the
    // repo's own tsc/eslint (and eslint configs are executable JS), so a cloned
    // repo must not be able to switch it on for whoever opens it.
    postEditDiagnostics: z.boolean().prefault(false),
    /**
     * System-prompt variant. 'current' uses the elaborate behavioral-scaffolding
     * prompt; 'minimal' uses a pi-style short prompt. See packages/cli/src/core/prompts.ts.
     * Defaults to 'current' for backward compatibility; switch via /config or by
     * editing the config file directly.
     */
    promptVariant: z.enum(['current', 'minimal']).prefault('current'),
    showThoughts: z.boolean().optional(),
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
    .prefault({}),
  trustedTools: z.array(z.string()).prefault([]),
  trustedProjects: z.array(z.string()).prefault([]),
  trustedMcpDefinitions: z.record(z.string(), z.array(z.string())).prefault({}),
  sandbox: SandboxConfigSchema.optional(),
  additionalDirectories: z.array(z.string()).prefault([]),
  fallbackModels: z.array(z.string()).optional(),
  ollamaHost: z.string().optional(),
  localDefaultModel: z.string().optional(),
  modelServerCredentials: z.record(z.string(), z.object({ secret: z.string() })).optional(),
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

/** Rewrites the old environment-based API config in place to the current simple form. */
function migrateApiConfig(raw: { apiConfig?: unknown }): void {
  const old = raw.apiConfig;
  if (typeof old !== 'object' || old === null || !('environment' in old)) return;
  const { environment, customUrl } = old as { environment: unknown; customUrl?: unknown };
  // A custom URL is kept for self-hosted instances; every other environment becomes the build-time default service.
  raw.apiConfig = environment === 'custom' && customUrl ? { customUrl } : {};
}

/** The one-time upgrade of a file not yet at CONFIG_SCHEMA_VERSION, in place. */
function upgradeConfig(raw: { preferences?: unknown; version?: unknown }): void {
  // Clear the legacy pinned output budget. Every config written before maxTokens
  // became optional carries this exact value from the old DEFAULT_CONFIG, not from
  // a user decision - and leaving it pinned keeps starving adaptive reasoning models
  // on machines that have merely *run* an older CLI. Only the untouched legacy value
  // is cleared, so a budget the user actually chose (any other number) survives.
  const preferences = raw.preferences as { maxTokens?: unknown } | null | undefined;
  if (typeof preferences === 'object' && preferences?.maxTokens === LEGACY_PINNED_MAX_TOKENS) {
    delete preferences.maxTokens;
  }
  raw.version = CONFIG_SCHEMA_VERSION;
}

/** A refresh lock whose heartbeat stopped this long ago (ms) is abandoned. */
export const REFRESH_LOCK_STALE_MS = 30_000;
export const REFRESH_LOCK_WAIT_MS = 40_000;
const REFRESH_LOCK_POLL_MS = 100;
/** The config write lock is held only from a read of the file to its rename. */
const CONFIG_LOCK_STALE_MS = 10_000;
const CONFIG_LOCK_WAIT_MS = 15_000;
const CONFIG_LOCK_POLL_MS = 10;

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A change that would replace a list or map in the file with a value of another shape, dropping what it holds. */
class ShapeMismatchError extends Error {
  /** Keys from the top of the config down to the value that differs in shape. */
  readonly path: string[] = [];
}

/** A save refused over a file that failed validation; `key` names the top-level setting that caused it, if one did. */
class RefusedSaveError extends Error {
  constructor(
    message: string,
    readonly key?: string
  ) {
    super(message);
  }
}

const shapeOf = (value: unknown) => (Array.isArray(value) ? 'array' : isJsonObject(value) ? 'object' : 'scalar');
const hasOwnKey = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const ownValue = (value: Record<string, unknown>, key: string) => (hasOwnKey(value, key) ? value[key] : undefined);

/**
 * Applies what changed from `base` to `next` onto `target`, a value as the file holds it, and keeps everything else
 * in `target`: keys set or removed in objects, items added or removed in arrays, any other value replaced. Throws
 * ShapeMismatchError rather than replace a `target` of another shape when either is a list or map.
 */
function applyChanges(
  target: unknown,
  base: unknown,
  next: unknown,
  explicit: Record<string, unknown> | boolean = false
): unknown {
  if (explicit === false && isDeepStrictEqual(base, next)) return target;
  // An empty map or list filled in where there was none is not a change.
  const empty = (isJsonObject(next) && Object.keys(next).length === 0) || (Array.isArray(next) && next.length === 0);
  if (base === undefined && target === undefined && empty) return undefined;
  if (target !== undefined && shapeOf(target) !== shapeOf(next)) throw new ShapeMismatchError();
  if (explicit === true) return next;
  if (isJsonObject(next)) {
    const from = isJsonObject(base) ? base : {};
    // No prototype, so keys such as __proto__ read from the file stay plain data.
    const out: Record<string, unknown> = Object.create(null);
    if (isJsonObject(target)) for (const key of Object.keys(target)) out[key] = target[key];
    const requestedKeys = isJsonObject(explicit) ? Object.keys(explicit) : [];
    for (const key of new Set([...Object.keys(from), ...Object.keys(next), ...requestedKeys])) {
      const nextValue = ownValue(next, key);
      const requested = isJsonObject(explicit) && hasOwnKey(explicit, key);
      if (nextValue === undefined) {
        if (requested || ownValue(from, key) !== undefined) delete out[key];
        continue;
      }
      let value: unknown;
      try {
        const intent = requested ? (isJsonObject(explicit[key]) ? explicit[key] : true) : false;
        value = applyChanges(out[key], ownValue(from, key), nextValue, intent);
      } catch (error) {
        if (error instanceof ShapeMismatchError) error.path.unshift(key);
        throw error;
      }
      if (value === undefined) delete out[key];
      else out[key] = value;
    }
    return out;
  }
  if (Array.isArray(next) && Array.isArray(target)) {
    const from = Array.isArray(base) ? base : [];
    const has = (list: unknown[], item: unknown) => list.some(entry => isDeepStrictEqual(entry, item));
    const kept = target.filter(item => has(next, item) || !has(from, item));
    return [...kept, ...next.filter(item => !has(from, item) && !has(kept, item))];
  }
  return next;
}

/** Sets `server` in the file's mcpServers, array or name-keyed map, replacing any entry with its name. */
function upsertRawMcpServer(raw: Record<string, unknown>, server: CliConfig['mcpServers'][0]): boolean {
  const servers = raw.mcpServers;
  if (servers === undefined) {
    raw.mcpServers = [server];
  } else if (Array.isArray(servers)) {
    raw.mcpServers = [...servers.filter(entry => !(isJsonObject(entry) && entry.name === server.name)), server];
  } else if (isJsonObject(servers)) {
    const { name, ...entry } = server;
    Object.defineProperty(servers, name, { value: entry, enumerable: true, configurable: true, writable: true });
  } else {
    throw new ShapeMismatchError();
  }
  return true;
}

/** Removes the server named `name` from the file's mcpServers, array or name-keyed map. */
function removeRawMcpServer(raw: Record<string, unknown>, name: string): boolean {
  const servers = raw.mcpServers;
  if (Array.isArray(servers)) {
    const kept = servers.filter(entry => !(isJsonObject(entry) && entry.name === name));
    raw.mcpServers = kept;
    return kept.length !== servers.length;
  }
  if (isJsonObject(servers) && hasOwnKey(servers, name)) {
    delete servers[name];
    return true;
  }
  return false;
}

/** The file's own entry for the server named `name` in mcpServers, array or name-keyed map. */
function rawMcpServerEntry(raw: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
  const servers = raw.mcpServers;
  const entry = Array.isArray(servers)
    ? servers.find(item => isJsonObject(item) && item.name === name)
    : isJsonObject(servers)
      ? ownValue(servers, name)
      : undefined;
  return isJsonObject(entry) ? entry : undefined;
}

/** Sets `enabled` on the server named `name` in the file's mcpServers; false when the file has no such server. */
function setRawMcpServerEnabled(raw: Record<string, unknown>, name: string, enabled: boolean): boolean {
  const entry = rawMcpServerEntry(raw, name);
  if (!entry) return false;
  entry.enabled = enabled;
  return true;
}

/** Drops the items `drop` matches from the file's list at `key`; a value that is not a list is left alone. */
function removeRawListItems(raw: Record<string, unknown>, key: string, drop: (item: unknown) => boolean): boolean {
  const list = raw[key];
  if (!Array.isArray(list)) return false;
  const kept = list.filter(item => !drop(item));
  raw[key] = kept;
  return kept.length !== list.length;
}

/** The sign-in and backend fields as written to the file; read from it, each may be in any shape. */
interface DiskAuthFields {
  auth: unknown;
  authByEnv: unknown;
  apiConfig: unknown;
}

interface GlobalWriteOptions {
  clearFeatures?: boolean;
  authFields?: DiskAuthFields;
  /** Applies the write to memory once the file holds it, before the steps after the rename that can fail. */
  onCommit?: () => void;
}

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
    postEditDiagnostics: false,
    promptVariant: 'current',
  },
  tools: {
    enabled: [],
    disabled: ['blog_publish', 'blog_edit', 'blog_draft'], // Web-only tools
    config: {},
  },
  trustedTools: [], // No tools trusted by default
  trustedProjects: [], // No project roots trusted by default (folder-trust gate)
  trustedMcpDefinitions: {}, // No repo MCP definitions approved by default
  additionalDirectories: [], // No additional directories by default
};

/**
 * Find project config directory by searching up the directory tree
 * Looks for git repository root (.git directory)
 * Falls back to current working directory if no git repo found
 */
function findProjectConfigDir(startDir: string | null = currentWorkingDir()): string | null {
  if (startDir === null) return null;
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
  return currentWorkingDir();
}

/** The working directory, or null when it was removed after this process started in it. */
function currentWorkingDir(): string | null {
  try {
    return process.cwd();
  } catch {
    return null;
  }
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
 * commands, turn the network filter on, and force allowUnsandboxedCommands and
 * allowContainerSockets off.
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

  if (repo.allowContainerSockets === false) result.allowContainerSockets = false;
  else if (repo.allowContainerSockets === true && !b.allowContainerSockets) warn('allowContainerSockets=true');

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
 * Approval fingerprint of a repo MCP server: sha256 over every field that
 * decides what gets spawned (full env/header VALUES included, so a changed
 * token re-prompts). Only the hash is persisted. Distinct from
 * McpManager.hashServerConfig, a truncated cache key that ignores headers.
 */
export function fingerprintMcpServer(s: NormalizedMcpServer): string {
  const sortKeys = (o: Record<string, string> | undefined) =>
    Object.fromEntries(Object.entries(o ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const { name, type, command, args, url } = s;
  return createHash('sha256')
    .update(JSON.stringify({ name, type, command, args, url, env: sortKeys(s.env), headers: sortKeys(s.headers) }))
    .digest('hex');
}

/** Env keys whose values change what code a spawned process runs; shown to the user at approval. */
const LOADER_ENV_KEY = /^(PATH|NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|RUBYOPT|PERL5OPT|PERL5LIB|LD_.*|DYLD_.*|PYTHON.*)$/i;

/**
 * A repo MCP server awaiting approval. Carries env/header KEYS, plus values only
 * for loader-style env keys (envValues); secrets and header values never leave the store.
 */
export interface PendingMcpApproval {
  name: string;
  /** fingerprintMcpServer() of the definition shown; approval persists exactly this. */
  fingerprint: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  envKeys: string[];
  envValues: Record<string, string>;
  headerKeys: string[];
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
  // Resolved without a catalog instance: config merges before any catalog exists, so a
  // registered (feature/plugin) tool resolves as unknown here.
  const disabledSet = new Set(merged.tools.disabled);
  merged.tools = { ...merged.tools, enabled: merged.tools.enabled.filter(t => !disabledSet.has(t)) };
  const globalTrusted = new Set(global.trustedTools || []);
  merged.trustedTools = (merged.trustedTools || []).filter(
    t => globalTrusted.has(t) || (canTrustTool(resolveStaticToolDescriptor(t)) && !disabledSet.has(t))
  );

  return merged;
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
  private serial: Promise<unknown> = Promise.resolve();
  /** The config write lock while this store holds it; checked right before each rename onto the file. */
  private configLock: HeldLock | null = null;
  /**
   * Set when the global snapshot is DEFAULT_CONFIG standing in for a file that failed validation: the snapshot as of
   * the last load or save, so a save writes only what changed since onto the file's own JSON.
   */
  private fallbackBase: CliConfig | null = null;
  /** Canonicalized (realpath'd) discovered project root, or null. */
  private projectRealPath: string | null = null;
  /** Whether the discovered project root is in the global `trustedProjects`. */
  private projectTrusted = false;
  // Raw repo layers, loaded ONLY when the project is trusted. Kept so trust
  // changes can re-merge without re-reading the global config file.
  private rawProjectConfig: ProjectConfig | null = null;
  private rawProjectLocalConfig: ProjectLocalConfig | null = null;
  private rawMcpJsonServers: NormalizedMcpServer[] | null = null;
  // Repo MCP servers whose exact definition isn't approved for this root; held
  // out of config.mcpServers so no spawn path can start them.
  private pendingMcpApprovals: NormalizedMcpServer[] = [];
  private pendingMcpWarned = false;
  // Names of the MCP servers the last merge took from --mcp-config and from the trusted project's layers.
  private injectedMcpNames = new Set<string>();
  private projectMcpNames = new Set<string>();

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
      let globalFailedValidation = false;

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
        let rawConfig;
        try {
          rawConfig = JSON.parse(data);
        } catch {
          // The parser's message can quote the file's bytes, which may include a saved token.
          throw new Error(`Could not load ${this.configPath}: it is not valid JSON.`);
        }

        migrateApiConfig(rawConfig);

        // One-time upgrade pass, gated on the version stamp so each step runs against a
        // given file exactly once and is then written back at the current version. Without
        // the stamp a value-keyed step is not a migration at all but a standing rule, and
        // the user can never hold the value it rewrites.
        if (rawConfig.version !== CONFIG_SCHEMA_VERSION) {
          upgradeConfig(rawConfig);

          // A failed write (read-only home, etc.) is non-fatal: the in-memory result of this
          // pass still applies to the current session and the stamp simply stays behind, so
          // the migration retries on the next launch rather than being silently skipped.
          try {
            rawConfig = (await this.writeUpgradedConfig()) ?? rawConfig;
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
          globalFailedValidation = true;
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
      this.fallbackBase = globalFailedValidation ? structuredClone(globalConfig) : null;

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
    // Repo servers spawn only once their exact definition is approved for this
    // root. Names global defines are dropped first: they never spawn, so they're
    // never pending either.
    const globalNames = new Set((global.mcpServers ?? []).map(s => s.name));
    const repoServers = mergeMcpServersGlobalWins(undefined, mcpJson, project?.mcpServers, local?.mcpServers).filter(
      s => !globalNames.has(s.name)
    );
    this.projectMcpNames = new Set(repoServers.map(s => s.name));
    this.injectedMcpNames = new Set();
    const approved = new Set((this.projectRealPath && global.trustedMcpDefinitions?.[this.projectRealPath]) || []);
    const approvedRepo: NormalizedMcpServer[] = [];
    this.pendingMcpApprovals = [];
    for (const s of repoServers) {
      // Disabled servers never spawn, so there is nothing to approve.
      if (!s.enabled) {
        approvedRepo.push(s);
        continue;
      }
      (approved.has(fingerprintMcpServer(s)) ? approvedRepo : this.pendingMcpApprovals).push(s);
    }
    merged.mcpServers = mergeMcpServersGlobalWins(global.mcpServers, approvedRepo);

    const mcpConfigFile = process.env.B4M_MCP_CONFIG_FILE;
    if (mcpConfigFile) {
      const injected = await loadMcpConfigFile(mcpConfigFile);
      this.injectedMcpNames = new Set((injected ?? []).map(s => s.name));
      if (process.env.B4M_STRICT_MCP_CONFIG === '1') {
        // Strict means strict: the injected set is the ONLY allowed scope. A
        // malformed/missing file (injected === null) yields an empty set, never
        // a silent fall-back to the broader merged config.
        merged.mcpServers = injected ?? [];
        this.pendingMcpApprovals = [];
      } else if (injected) {
        merged.mcpServers = mergeMcpServers(merged.mcpServers, injected);
        // An injected name replaces the repo one, so that repo def never spawns.
        const injectedNames = new Set(injected.map(s => s.name));
        this.pendingMcpApprovals = this.pendingMcpApprovals.filter(s => !injectedNames.has(s.name));
      }
    }

    return merged;
  }

  /** Repo MCP servers held back pending approval of their exact definition. */
  getPendingMcpApprovals(): PendingMcpApproval[] {
    return this.pendingMcpApprovals.map(s => ({
      name: s.name,
      fingerprint: fingerprintMcpServer(s),
      transport: s.type ?? (s.url ? 'http' : 'stdio'),
      command: s.command,
      args: s.args,
      url: s.url,
      envKeys: Object.keys(s.env ?? {}),
      envValues: Object.fromEntries(Object.entries(s.env ?? {}).filter(([k]) => LOADER_ENV_KEY.test(k))),
      headerKeys: Object.keys(s.headers ?? {}),
    }));
  }

  /**
   * Approve pending repo MCP servers for the current (trusted) root. Persists the
   * fingerprints the user was SHOWN, not a re-read by name, so a definition that
   * changed while the prompt was open stays pending.
   */
  async approveMcpServers(servers: Pick<PendingMcpApproval, 'fingerprint'>[]): Promise<void> {
    await this.load();
    const root = this.projectRealPath;
    if (!root || !this.projectTrusted) return;

    const g = this.globalConfig!;
    const defs = (g.trustedMcpDefinitions ??= {});
    defs[root] = [...new Set([...(defs[root] ?? []), ...servers.map(s => s.fingerprint)])];
    await this.save();
  }

  /** Warn once (stderr) about repo MCP servers skipped for lack of approval. */
  warnPendingMcpApprovals(): void {
    if (this.pendingMcpWarned || this.pendingMcpApprovals.length === 0) return;
    this.pendingMcpWarned = true;
    const names = sanitizeTerminalText(this.pendingMcpApprovals.map(s => s.name).join(', '));
    const root = escapeTerminalControlChars(this.projectRealPath ?? '').replace(/\n/g, '\\n');
    logger.warn(
      `Skipping ${this.pendingMcpApprovals.length} unapproved repo MCP server(s): ${names}. ` +
        `Run b4m interactively in ${root} to approve them.`
    );
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

    await this.save();

    // Trusting the current root loads its layers, only once the trust is saved. B4M_NO_PROJECT_CONFIG still forces
    // project config off entirely.
    if (target === this.projectRealPath && this.projectConfigDir && process.env.B4M_NO_PROJECT_CONFIG !== '1') {
      this.projectTrusted = true;
      await this.loadProjectLayers();
      this.config = await this.computeMerged();
    }
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

    const untrust = (config: CliConfig) => {
      config.trustedProjects = (config.trustedProjects || []).filter(p => p !== target);
      if (config.trustedMcpDefinitions) delete config.trustedMcpDefinitions[target];
    };
    untrust(this.globalConfig!);

    if (target === this.projectRealPath) {
      this.projectTrusted = false;
      this.rawProjectConfig = null;
      this.rawProjectLocalConfig = null;
      this.rawMcpJsonServers = null;
    }

    const revoked = await this.patchInFallback(untrust, raw => {
      const dropped = removeRawListItems(raw, 'trustedProjects', p => p === target);
      const definitions = raw.trustedMcpDefinitions;
      if (!isJsonObject(definitions) || !hasOwnKey(definitions, target)) return dropped;
      delete definitions[target];
      return true;
    });
    if (revoked) return;
    await this.save();
  }

  /**
   * Read the features map straight from the global config file, bypassing the
   * in-memory cache. save() merges over this so concurrent writers (the
   * interactive session vs `b4m plugin add`) don't clobber each other's keys.
   */
  private async readDiskFeatures(): Promise<Record<string, boolean>> {
    // A file that could not be read throws: read as empty, the merge would drop every feature key.
    const text = await this.readConfigText();
    const raw = text === null ? null : this.parseConfigText(text);
    const features = raw?.features;
    if (!isJsonObject(features)) return {};
    // Return only boolean entries so callers that write this back (e.g.
    // switchApiEnvironment) or merge over it can't reintroduce a bogus value.
    return Object.fromEntries(Object.entries(features).filter(([, v]) => typeof v === 'boolean')) as Record<
      string,
      boolean
    >;
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
   * `b4m models` writes defaultModel, ollamaHost and localDefaultModel from its own process, so like features
   * they are taken from disk unless this caller's patch sets them.
   */
  private async mergeModelFields(
    next: CliConfig,
    snapshot: CliConfig,
    patch: GlobalConfigPatch | undefined
  ): Promise<CliConfig> {
    const text = await this.readConfigText();
    const disk = text === null ? null : this.parseConfigText(text);
    if (!disk) return next;
    // A patch naming a key sets it; a whole config spread back (it carries `version`) only sets what it changed.
    const wholeConfig = patch !== undefined && Object.prototype.hasOwnProperty.call(patch, 'version');
    const changed = (key: 'defaultModel' | 'ollamaHost' | 'localDefaultModel') =>
      patch !== undefined &&
      Object.prototype.hasOwnProperty.call(patch, key) &&
      (!wholeConfig || patch[key] !== snapshot[key]);
    const optional = (key: 'ollamaHost' | 'localDefaultModel') =>
      changed(key) || (disk[key] !== undefined && typeof disk[key] !== 'string')
        ? next[key]
        : (disk[key] as string | undefined);
    const credentials = CliConfigSchema.shape.modelServerCredentials.safeParse(disk.modelServerCredentials);
    return {
      ...next,
      defaultModel:
        changed('defaultModel') || typeof disk.defaultModel !== 'string' ? next.defaultModel : disk.defaultModel,
      ollamaHost: optional('ollamaHost'),
      localDefaultModel: optional('localDefaultModel'),
      modelServerCredentials:
        patch !== undefined &&
        Object.prototype.hasOwnProperty.call(patch, 'modelServerCredentials') &&
        (!wholeConfig || patch.modelServerCredentials !== snapshot.modelServerCredentials)
          ? next.modelServerCredentials
          : credentials.success
            ? credentials.data
            : next.modelServerCredentials,
    };
  }

  /** The saved credentials as the file has them now, not as this store loaded them. */
  async readModelServerCredentials(): Promise<Record<string, { secret: string }>> {
    try {
      return await this.readModelServerCredentialsStrict();
    } catch (error) {
      logger.debug(
        `Could not read model server credentials: ${error instanceof Error ? error.message : String(error)}`
      );
      return {};
    }
  }

  /** Throws when the file exists but cannot be read, so a write never replaces credentials it failed to read. */
  private async readModelServerCredentialsStrict(): Promise<Record<string, { secret: string }>> {
    let text: string;
    try {
      text = await fs.readFile(this.configPath, 'utf-8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {};
      throw error;
    }
    const raw = this.parseConfigText(text);
    const parsed = z.object({ modelServerCredentials: CliConfigSchema.shape.modelServerCredentials }).safeParse(raw);
    if (!parsed.success) throw new Error(`${this.configPath} has malformed model server credentials.`);
    return parsed.data.modelServerCredentials ?? {};
  }

  /** Writes through a 0600 temp file and a rename, so a reader in another process never sees a half-written file. */
  private async writeConfigFile(contents: string): Promise<void> {
    // Rename onto the link's target, so a symlinked config stays a symlink.
    const target = await fs.realpath(this.configPath).catch(() => this.configPath);
    const temp = `${target}.${process.pid}.${uuidv4()}.tmp`;
    try {
      await fs.writeFile(temp, contents, { encoding: 'utf-8', mode: 0o600 });
      if (!this.configLock) throw new Error(`Refusing to write ${this.configPath} without holding its write lock`);
      await this.configLock.assertHeld();
      await fs.rename(temp, target);
    } catch (error) {
      await fs.rm(temp, { force: true });
      throw error;
    }
  }

  /**
   * Writes the upgraded file under the config write lock, from a fresh read so a save another process made since
   * load() read the file is kept. Returns what it wrote, or null when the file is gone or not a JSON object.
   */
  private async writeUpgradedConfig(): Promise<Record<string, unknown> | null> {
    return this.withConfigWriteLock(async () => {
      const text = await this.readConfigText();
      const raw = text === null ? null : this.parseConfigText(text);
      if (!raw) return null;
      migrateApiConfig(raw);
      if (raw.version !== CONFIG_SCHEMA_VERSION) {
        upgradeConfig(raw);
        // A file this build cannot validate is left as it is; load() then runs on defaults without saving over it.
        if (CliConfigSchema.safeParse(raw).success) await this.writeConfigFile(JSON.stringify(raw, null, 2));
      }
      return raw;
    });
  }

  /** Reloads from the file so the write below carries what other processes saved (a refreshed sign-in token). */
  private async reloadFromDisk(): Promise<void> {
    this.config = null;
    this.globalConfig = null;
    await this.load();
  }

  /** Read-modify-write against the file, so a login in another terminal is not undone. */
  async setModelServerCredential(serverId: string, secret: string): Promise<void> {
    await this.updateModelServerCredentials(current => ({ ...current, [serverId]: { secret } }));
  }

  async clearModelServerCredential(serverId: string): Promise<void> {
    await this.load();
    const clear = (config: CliConfig) => {
      const saved = config.modelServerCredentials;
      if (!saved || !hasOwnKey(saved, serverId)) return;
      const { [serverId]: dropped, ...kept } = saved;
      void dropped;
      config.modelServerCredentials = kept;
    };
    if (this.fallbackBase) clear(this.globalConfig!);
    const clearInFile = (raw: Record<string, unknown>) => {
      const credentials = raw.modelServerCredentials;
      if (!isJsonObject(credentials) || !hasOwnKey(credentials, serverId)) return false;
      delete credentials[serverId];
      return true;
    };
    if (await this.patchInFallback(clear, clearInFile)) return;
    await this.updateModelServerCredentials(current => {
      const { [serverId]: removed, ...rest } = current;
      void removed;
      return rest;
    });
  }

  private async updateModelServerCredentials(
    change: (current: Record<string, { secret: string }>) => Record<string, { secret: string }>
  ): Promise<void> {
    // Reloaded inside exclusive(), so no other write in this store sees the config emptied mid-reload.
    await this.lockedWrite(
      async () => {
        const next = change(await this.readModelServerCredentialsStrict());
        await this.writeGlobal({ modelServerCredentials: next });
      },
      () => this.reloadFromDisk()
    );
  }

  /**
   * Save configuration to disk
   */
  async save(config?: GlobalConfigPatch): Promise<void> {
    await this.exclusive(() => this.persistGlobal(config));
  }

  /** Serializes this store's reads and writes of the config file, so one never interleaves with another. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.serial.then(work, work);
    this.serial = run.catch(() => undefined);
    return run;
  }

  /**
   * Runs a read-modify-write of the config file under exclusive() and then the config write lock. Lock order
   * everywhere: the refresh lock, then exclusive(), then the config write lock. Loading (which may reset and write)
   * happens before the write lock is taken, since that lock is not reentrant.
   */
  private lockedWrite<T>(work: () => Promise<T>, prepare?: () => Promise<void>): Promise<T> {
    return this.exclusive(async () => {
      if (prepare) await prepare();
      if (!this.globalConfig) await this.load();
      await this.init();
      return this.withConfigWriteLock(work);
    });
  }

  private withConfigWriteLock<T>(work: () => Promise<T>): Promise<T> {
    return withLockDir(
      path.join(path.dirname(this.configPath), 'config.json.lock'),
      async held => {
        this.configLock = held;
        try {
          return await work();
        } finally {
          this.configLock = null;
        }
      },
      {
        waitMs: CONFIG_LOCK_WAIT_MS,
        staleMs: CONFIG_LOCK_STALE_MS,
        pollMs: CONFIG_LOCK_POLL_MS,
        heldMessage: 'Another b4m process is still saving settings',
      }
    );
  }

  /**
   * The sign-in and backend fields as the file holds them now; another process may have signed in or switched
   * since this store loaded. No file, or JSON that is not an object, means none are set. A file that cannot be read
   * or parsed rejects, so a save never writes this store's copy over a sign-in it failed to read. A field in an
   * unexpected shape is returned as found, so a write carries it through unchanged.
   */
  private async diskAuthFields(): Promise<DiskAuthFields> {
    const text = await this.readConfigText();
    const disk = text === null ? null : this.parseConfigText(text);
    return { auth: disk?.auth, authByEnv: disk?.authByEnv, apiConfig: disk?.apiConfig };
  }

  /**
   * Writes the global layer. The sign-in and backend fields are written as the file holds them, so a stale or
   * signed-out process cannot undo another's sign-in; only `authFields` writers (a backend change, a reset) set them.
   */
  private async persistGlobal(config?: GlobalConfigPatch, opts?: GlobalWriteOptions): Promise<void> {
    await this.init();

    // Ensure the global snapshot exists (first save on a fresh store).
    if (!this.globalConfig) {
      await this.load();
    }
    await this.withConfigWriteLock(() => this.writeGlobal(config, opts));
  }

  /** persistGlobal's read-modify-write of the file; the caller holds the config write lock. */
  private async writeGlobal(config?: GlobalConfigPatch, opts?: GlobalWriteOptions): Promise<void> {
    const fallbackBase = this.fallbackBase;
    let staged = fallbackBase ? structuredClone(this.globalConfig!) : null;
    try {
      await this.writeGlobalLayer(config, opts, snapshot => {
        if (fallbackBase) staged = structuredClone(snapshot);
      });
    } catch (error) {
      // A change that did not reach a file that failed validation is dropped, so later saves do not carry it again.
      if (fallbackBase && staged && this.fallbackBase === fallbackBase) {
        await this.rollBackTo(fallbackBase, staged, error instanceof RefusedSaveError ? error.key : undefined);
      }
      throw error;
    }
  }

  /**
   * Undoes what a failed write staged: each top-level key (only `onlyKey` when the refusal named one) that differs
   * from `base` and still holds the value the write tried to save. A key another caller changed since is theirs and
   * is left alone, as are the sign-in and backend fields, which writers patch into the file directly.
   */
  private async rollBackTo(base: CliConfig, staged: CliConfig, onlyKey?: string): Promise<void> {
    const current = this.globalConfig as unknown as Record<string, unknown> | null;
    if (!current) return;
    const from = base as unknown as Record<string, unknown>;
    const tried = staged as unknown as Record<string, unknown>;
    for (const key of new Set([...Object.keys(from), ...Object.keys(current)])) {
      if (key === 'auth' || key === 'authByEnv' || key === 'apiConfig') continue;
      if (onlyKey !== undefined && key !== onlyKey) continue;
      const now = ownValue(current, key);
      if (isDeepStrictEqual(ownValue(from, key), now) || !isDeepStrictEqual(ownValue(tried, key), now)) continue;
      if (ownValue(from, key) === undefined) delete current[key];
      else current[key] = structuredClone(from[key]);
    }
    try {
      this.config = await this.computeMerged();
    } catch {
      // The merged view is rebuilt on the next successful save.
    }
  }

  private async writeGlobalLayer(
    config: GlobalConfigPatch | undefined,
    opts: GlobalWriteOptions | undefined,
    onStaged: (snapshot: CliConfig) => void
  ): Promise<void> {
    const global = this.globalConfig!;
    const authFields = opts?.authFields ?? (this.fallbackBase ? undefined : await this.diskAuthFields());
    let explicitPatch: Record<string, unknown> | undefined;

    if (config) {
      // The security-critical, repo-launderable fields never flow through a
      // generic save(): the structural sets (mcpServers / trustedTools /
      // additionalDirectories / trustedProjects / trustedMcpDefinitions) and the
      // security-posture fields (tools / sandbox) change ONLY via their dedicated mutators (addMcpServer,
      // trustTool, saveSandboxConfig, trustProject, ...). Stripping them here - a
      // runtime allowlist on top of the GlobalConfigPatch type - means even a
      // caller that casts past the type and spreads the merged effective config
      // can't re-launder THOSE fields into ~/.bike4mind/config.json. It does NOT
      // guard defaultModel / preferences / toolApiKeys, which stay writable (that
      // is what /model and /config edit): callers must pass user-changed values,
      // not the merged rest - see buildGlobalConfigPatch.
      const {
        auth,
        authByEnv,
        apiConfig,
        mcpServers,
        trustedTools,
        additionalDirectories,
        trustedProjects,
        trustedMcpDefinitions,
        tools,
        sandbox,
        ...rest
      } = config as Partial<CliConfig>;
      void auth;
      void authByEnv;
      void apiConfig;
      void mcpServers;
      void trustedTools;
      void additionalDirectories;
      void trustedProjects;
      void trustedMcpDefinitions;
      void tools;
      void sandbox;
      if (!hasOwnKey(rest, 'version')) {
        explicitPatch = { ...rest };
        // These two fields are merged, so an absent object does not request their replacement.
        if (!config.preferences) delete explicitPatch.preferences;
        if (!config.toolApiKeys) delete explicitPatch.toolApiKeys;
      }

      this.globalConfig = {
        ...global,
        ...rest,
        auth: global.auth,
        authByEnv: global.authByEnv,
        apiConfig: global.apiConfig,
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
    // Memory already holds the patch, so a failed read below must still roll it back.
    if (this.fallbackBase) onStaged(structuredClone(this.globalConfig));
    if (!opts?.clearFeatures) {
      this.globalConfig = await this.mergeModelFields(this.globalConfig, global, config);
    }
    // Over a file that failed validation the base must match what was written, so a change made while this write is
    // in flight stays out of it and is saved by its own write.
    const staged = this.fallbackBase ? structuredClone(this.globalConfig) : this.globalConfig;
    onStaged(staged);
    const contents = this.fallbackBase
      ? await this.mergeOverInvalidConfig(this.fallbackBase, staged, opts?.authFields, explicitPatch)
      : { ...this.globalConfig, ...authFields };

    try {
      // Persist ONLY the global layer, never the merged effective config.
      await this.writeConfigFile(JSON.stringify(contents, null, 2));
    } catch (error) {
      console.error('Failed to save config:', error);
      throw error;
    }

    // The file holds the write from here on, so memory follows it even when a step below fails.
    if (this.fallbackBase) this.fallbackBase = staged;
    opts?.onCommit?.();
    const failures: unknown[] = [];
    try {
      // Set secure permissions (0600 - only owner can read/write)
      // This protects auth tokens and API keys from other users
      await fs.chmod(this.configPath, 0o600);
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.refreshMerged();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      console.error('Failed to save config:', failures[0]);
      throw failures[0];
    }
  }

  /**
   * The file contents for a save while the snapshot stands in for a file that failed validation: the file's own
   * JSON, unknown and invalid keys included, with only what this process changed since `base` applied, so none of
   * the defaults behind the snapshot reach the file. The caller holds the config write lock.
   */
  private async mergeOverInvalidConfig(
    base: CliConfig,
    next: CliConfig,
    authFields: DiskAuthFields | undefined,
    explicitPatch: Record<string, unknown> | undefined
  ): Promise<Record<string, unknown>> {
    let text: string | null;
    let raw: Record<string, unknown> | null = null;
    try {
      text = await this.readConfigText();
      if (text !== null) raw = this.parseConfigText(text);
    } catch {
      text = '';
    }
    if (text === null) {
      // The file is gone, so there is nothing left to keep.
      this.fallbackBase = null;
      return { ...next, ...(authFields ?? (await this.diskAuthFields())) };
    }
    if (!raw) throw this.invalidConfigError();
    const { auth: _baseAuth, authByEnv: _baseByEnv, apiConfig: _baseApi, ...from } = base;
    const { auth: _auth, authByEnv: _byEnv, apiConfig: _api, ...to } = next;
    // As JSON, so an in-memory item with an undefined key matches the same item read from the file.
    const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
    let merged: Record<string, unknown>;
    try {
      // Narrow patches express user intent even when the chosen value equals a fallback default.
      // Whole-config saves still persist only their differences from the snapshot.
      merged = applyChanges(raw, asJson(from), asJson(to), explicitPatch ?? false) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof ShapeMismatchError) throw this.invalidConfigError(error.path[0]);
      throw error;
    }
    if (authFields) {
      for (const key of ['auth', 'authByEnv', 'apiConfig'] as const) {
        if (authFields[key] === undefined) delete merged[key];
        else merged[key] = authFields[key];
      }
    }
    return merged;
  }

  /** Rebuilds the merged view; on failure drops it, so the next load() rebuilds it from the file. */
  private async refreshMerged(): Promise<void> {
    try {
      this.config = await this.computeMerged();
    } catch (error) {
      this.config = null;
      throw error;
    }
  }

  private invalidConfigError(key?: string): Error {
    return new RefusedSaveError(
      `Could not save settings: ${this.configPath} failed validation, so it was left unchanged. Fix the file, or remove it to start over.`,
      key
    );
  }

  /**
   * While the snapshot stands in for a file that failed validation, applies `mutate` to the file's own JSON in place
   * of a save, then `change` (the same change, idempotent) to the snapshot and its base so a later save does not
   * apply it again. Returns false when not in that state or when there is no file, for the caller to save as usual.
   */
  private async patchInFallback(
    change: (config: CliConfig) => void,
    mutate: (raw: Record<string, unknown>) => boolean
  ): Promise<boolean> {
    if (!this.fallbackBase) return false;
    try {
      return await this.exclusive(async () => {
        const patched = await this.withConfigWriteLock(() =>
          this.patchConfigText(mutate, () => this.invalidConfigError())
        );
        if (!patched) return false;
        // Only this change goes into the base, so other changes still pending in memory are saved by their own writes.
        if (this.fallbackBase) change(this.fallbackBase);
        if (this.globalConfig) change(this.globalConfig);
        await this.refreshMerged();
        return true;
      });
    } catch (error) {
      if (error instanceof ShapeMismatchError) throw this.invalidConfigError();
      throw error;
    }
  }

  /**
   * Reset configuration to defaults
   */
  async reset(): Promise<CliConfig> {
    // structuredClone so reset never shares DEFAULT_CONFIG's mutable arrays.
    this.globalConfig = { ...structuredClone(DEFAULT_CONFIG), userId: uuidv4() };
    this.fallbackBase = null;
    this.projectTrusted = false;
    this.rawProjectConfig = null;
    this.rawProjectLocalConfig = null;
    this.rawMcpJsonServers = null;
    // clearFeatures: a reset must wipe the on-disk feature map too, not inherit it
    // via save()'s concurrent-writer disk-merge (reached e.g. from load()'s
    // corrupt-config recovery path). Not serialized: load() calls this, and a serialized write may call load().
    const g = this.globalConfig;
    await this.persistGlobal(undefined, {
      clearFeatures: true,
      authFields: { auth: g.auth, authByEnv: g.authByEnv, apiConfig: g.apiConfig },
    });
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
    // Remove existing server with same name, then add (operates on GLOBAL only).
    const upsert = (config: CliConfig) => {
      config.mcpServers = [...config.mcpServers.filter(s => s.name !== server.name), structuredClone(server)];
    };
    upsert(this.globalConfig!);
    if (await this.patchInFallback(upsert, raw => upsertRawMcpServer(raw, server))) return;
    await this.save();
  }

  /**
   * Remove MCP server configuration
   */
  async removeMcpServer(name: string): Promise<void> {
    await this.load();
    const remove = (config: CliConfig) => {
      config.mcpServers = config.mcpServers.filter(s => s.name !== name);
    };
    remove(this.globalConfig!);
    if (await this.patchInFallback(remove, raw => removeRawMcpServer(raw, name))) return;
    await this.save();
  }

  /**
   * Enable/disable an MCP server saved in the user config. Rejects naming the server's source when the user config
   * does not save it; `injectedStillApplies` says --mcp-config also defines it, so its definition stays in effect.
   */
  async toggleMcpServer(name: string, enabled: boolean): Promise<{ injectedStillApplies: boolean }> {
    await this.load();
    const notSaved = () => {
      if (this.injectedMcpNames.has(name)) {
        return new Error(
          `MCP server "${name}" comes from --mcp-config, not ${this.configPath}; enable or disable it in that file.`
        );
      }
      if (this.projectMcpNames.has(name)) {
        return new Error(
          `MCP server "${name}" comes from this project's config, not ${this.configPath}; enable or disable it there.`
        );
      }
      return new Error(`MCP server "${name}" was not found in ${this.configPath}.`);
    };
    const result = { injectedStillApplies: this.injectedMcpNames.has(name) };
    const toggle = (config: CliConfig) => {
      const server = config.mcpServers.find(s => s.name === name);
      if (server) server.enabled = enabled;
    };
    const toggleInFile = (raw: Record<string, unknown>) => {
      if (!setRawMcpServerEnabled(raw, name, enabled)) throw notSaved();
      return true;
    };
    if (await this.patchInFallback(toggle, toggleInFile)) return result;
    const server = this.globalConfig!.mcpServers.find(s => s.name === name);
    if (!server) throw notSaved();
    server.enabled = enabled;
    await this.save();
    return result;
  }

  /**
   * The MCP server `name` as enable/disable sees it: the user config's own entry when it saves one, read from the
   * file itself when that fails validation, otherwise the server in effect. Null when there is none.
   */
  async findMcpServer(name: string): Promise<{ enabled: boolean } | null> {
    const config = await this.load();
    const saved = this.globalConfig!.mcpServers.find(s => s.name === name);
    if (saved) return { enabled: saved.enabled };
    if (this.fallbackBase) {
      const text = await this.readConfigText();
      const raw = text === null ? null : this.parseConfigText(text);
      const entry = raw ? rawMcpServerEntry(raw, name) : undefined;
      if (entry) return { enabled: entry.enabled !== false };
    }
    const effective = config.mcpServers.find(s => s.name === name);
    return effective ? { enabled: effective.enabled } : null;
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
      const untrust = (config: CliConfig) => {
        config.trustedTools = (config.trustedTools || []).filter(t => t !== toolName);
      };
      untrust(g);
      const revoke = (raw: Record<string, unknown>) => removeRawListItems(raw, 'trustedTools', t => t === toolName);
      if (await this.patchInFallback(untrust, revoke)) return;
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
    const clear = (config: CliConfig) => {
      config.trustedTools = [];
    };
    clear(this.globalConfig!);
    const revokeAll = (raw: Record<string, unknown>) => removeRawListItems(raw, 'trustedTools', () => true);
    if (await this.patchInFallback(clear, revokeAll)) return;
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
   * Save the sign-in for this process's backend, leaving the rest of the file as another process may have left it.
   * With `expectedRefreshToken`, saves only while the saved sign-in still holds that token; resolves whether it saved.
   */
  async setAuthTokens(tokens: AuthTokens, expectedRefreshToken?: string): Promise<boolean> {
    return this.saveAuthSlot(tokens, expectedRefreshToken);
  }

  /**
   * Clear the sign-in for this process's backend (logout), leaving other backends' sign-ins alone. With
   * `expectedRefreshToken`, clears only while the saved sign-in still holds that token, so a newer one is kept.
   * Resolves whether it cleared.
   */
  async clearAuthTokens(expectedRefreshToken?: string): Promise<boolean> {
    return this.saveAuthSlot(undefined, expectedRefreshToken);
  }

  /**
   * Write only this process's sign-in slot into the file as it is now: `auth` when the file's active backend
   * is this process's, otherwise `authByEnv[<this backend>]`. Another process's backend switch and sign-in survive.
   */
  private async saveAuthSlot(tokens: AuthTokens | undefined, expectedRefreshToken?: string): Promise<boolean> {
    await this.load();
    return this.lockedWrite(() => this.writeAuthSlot(tokens, expectedRefreshToken));
  }

  private async writeAuthSlot(tokens: AuthTokens | undefined, expectedRefreshToken?: string): Promise<boolean> {
    const text = await this.readConfigText();
    if (text === null) {
      if (expectedRefreshToken !== undefined) return false;
      const g = this.globalConfig!;
      await this.writeGlobal(undefined, {
        authFields: { auth: tokens, authByEnv: g.authByEnv, apiConfig: g.apiConfig },
        onCommit: () => {
          this.globalConfig!.auth = tokens;
        },
      });
      return true;
    }
    const file = this.parseConfigText(text);
    if (!file) throw new Error(`Could not save the sign-in to ${this.configPath}: it does not hold a JSON object`);
    const myKey = this.envKey();
    const mySlotInAuth = this.fileEnvKey(file) === myKey;
    const byEnv: Record<string, unknown> =
      typeof file.authByEnv === 'object' && file.authByEnv !== null && !Array.isArray(file.authByEnv)
        ? { ...file.authByEnv }
        : {};
    if (expectedRefreshToken !== undefined) {
      const held: unknown = mySlotInAuth
        ? file.auth
        : Object.prototype.hasOwnProperty.call(byEnv, myKey)
          ? byEnv[myKey]
          : undefined;
      const heldRefresh =
        typeof held === 'object' && held !== null ? (held as { refreshToken?: unknown }).refreshToken : undefined;
      if (heldRefresh !== expectedRefreshToken) return false;
    }
    if (mySlotInAuth) {
      if (tokens) file.auth = tokens;
      else delete file.auth;
    } else {
      if (tokens) byEnv[myKey] = tokens;
      else delete byEnv[myKey];
      file.authByEnv = byEnv;
    }
    await this.writeConfigFile(JSON.stringify(file, null, 2));
    this.globalConfig!.auth = tokens;
    if (this.config) this.config.auth = tokens;
    return true;
  }

  private envKey(): string {
    return normalizeEnvKey(this.globalConfig!.apiConfig?.customUrl || getDefaultApiUrl());
  }

  private fileEnvKey(file: Record<string, unknown>): string {
    const apiConfig = file.apiConfig as { customUrl?: unknown } | undefined;
    const url =
      typeof apiConfig?.customUrl === 'string' && apiConfig.customUrl ? apiConfig.customUrl : getDefaultApiUrl();
    return normalizeEnvKey(url);
  }

  /** The config file's text, or null when there is none. Errors name the file and the error code only. */
  private async readConfigText(): Promise<string | null> {
    try {
      return await fs.readFile(this.configPath, 'utf-8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return null;
      throw new Error(`Could not read ${this.configPath}: ${code ?? 'read failed'}`);
    }
  }

  /** The parsed config file, or null when it is not an object. Never echoes the file's bytes in an error. */
  private parseConfigText(text: string): Record<string, unknown> | null {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      const position = error instanceof Error ? /position (\d+)/.exec(error.message)?.[1] : undefined;
      throw new Error(
        `Could not read ${this.configPath}: not valid JSON${position ? ` (at position ${position})` : ''}`
      );
    }
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  }

  /**
   * The saved sign-in as the file holds it now, which another b4m process may have refreshed or cleared since
   * this store loaded; later reads return it too. The token refresh reads through this before it saves or clears.
   */
  async reloadAuthTokens(): Promise<AuthTokens | null> {
    await this.load();
    return this.exclusive(async () => {
      if (!this.globalConfig) await this.load();
      const text = await this.readConfigText();
      const auth = text === null ? undefined : this.authForEnv(text, this.envKey());
      this.globalConfig!.auth = auth;
      if (this.config) this.config.auth = auth;
      return auth ?? null;
    });
  }

  /**
   * Run `work` holding the sign-in refresh lock shared by every b4m process using this config
   * directory. Waits at most `waitMs`, then rejects without running `work`. Rejects after `work` when another
   * process took the lock over meanwhile; a refresh guards its own save with a compare-and-set.
   */
  async withRefreshLock<T>(work: () => Promise<T>, waitMs = REFRESH_LOCK_WAIT_MS): Promise<T> {
    return withLockDir(path.join(path.dirname(this.configPath), 'auth-refresh.lock'), () => work(), {
      waitMs,
      staleMs: REFRESH_LOCK_STALE_MS,
      pollMs: REFRESH_LOCK_POLL_MS,
      heldMessage: 'Another b4m process is still refreshing the sign-in',
    });
  }

  /** The sign-in `text` (the config file) holds for the environment keyed `envKey`, without echoing its bytes in errors. */
  private authForEnv(text: string, envKey: string): AuthTokens | undefined {
    const file = this.parseConfigText(text);
    if (!file) return undefined;
    let candidate: unknown;
    if (this.fileEnvKey(file) === envKey) {
      candidate = file.auth;
    } else if (
      typeof file.authByEnv === 'object' &&
      file.authByEnv !== null &&
      Object.prototype.hasOwnProperty.call(file.authByEnv, envKey)
    ) {
      candidate = (file.authByEnv as Record<string, unknown>)[envKey];
    }
    if (candidate === undefined) return undefined;
    const parsed = AuthTokensSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new Error(`Could not read the saved sign-in from ${this.configPath}: it is not in the expected shape`);
    }
    return parsed.data;
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
    await this.writeCustomApiUrl(url, false);
  }

  /**
   * Points the CLI at `url` (null: the build-time default service) and drops the active sign-in, which belongs to
   * the old origin, in the same write, so a failure never leaves the old backend's tokens next to the new URL.
   */
  async setCustomApiUrlSignedOut(url: string | null): Promise<void> {
    await this.writeCustomApiUrl(url, true);
  }

  private async writeCustomApiUrl(url: string | null, signOut: boolean): Promise<void> {
    await this.load();
    await this.lockedWrite(async () => {
      const apiConfig = url === null ? { endpointChosen: true } : { customUrl: url, endpointChosen: true };
      const disk = await this.diskAuthFields();
      await this.writeGlobal(undefined, {
        authFields: { ...disk, apiConfig, ...(signOut ? { auth: undefined } : {}) },
        // writeGlobal replaced the snapshot object; update the new one only now the file holds the change.
        onCommit: () => {
          const g = this.globalConfig!;
          g.apiConfig = apiConfig;
          if (signOut) g.auth = undefined;
        },
      });
    });
  }

  /** Record that a backend was chosen, so the first-run picker is not shown again. */
  async markEndpointChosen(): Promise<void> {
    await this.load();
    if (this.globalConfig!.apiConfig?.endpointChosen) return;
    await this.lockedWrite(async () => {
      // Patched in the raw file, so it also lands on a config this build cannot validate (startup calls this).
      const patched = await this.patchConfigText(raw => {
        const onDisk = isJsonObject(raw.apiConfig) ? raw.apiConfig : {};
        if (onDisk.endpointChosen === true) return false;
        raw.apiConfig = { ...onDisk, endpointChosen: true };
        return true;
      });
      const choose = () => {
        const g = this.globalConfig!;
        g.apiConfig = { ...g.apiConfig, endpointChosen: true };
        if (this.config) this.config.apiConfig = g.apiConfig;
      };
      if (patched) {
        choose();
        return;
      }
      // With no file left, this process's sign-in and backend are the current ones, as for a first sign-in.
      const g = this.globalConfig!;
      await this.writeGlobal(undefined, {
        authFields: { auth: g.auth, authByEnv: g.authByEnv, apiConfig: { ...g.apiConfig, endpointChosen: true } },
        onCommit: choose,
      });
    });
  }

  /**
   * Saves the launch auto-update choice by setting only `preferences.autoUpdate` in the raw file, without load()'s
   * schema pass, so a config this build cannot validate (one written by a newer b4m) keeps every other key. Rejects
   * when the file cannot be read or does not hold a JSON object.
   */
  async saveAutoUpdatePreference(value: boolean): Promise<void> {
    await this.init();
    const patched = await this.exclusive(() =>
      this.withConfigWriteLock(() =>
        this.patchConfigText(raw => {
          const preferences = raw.preferences ?? {};
          if (!isJsonObject(preferences)) {
            throw new Error(
              `Could not save the auto-update choice: preferences in ${this.configPath} is not an object`
            );
          }
          raw.preferences = { ...preferences, autoUpdate: value };
          return true;
        })
      )
    );
    if (!patched) {
      await this.save({ preferences: { autoUpdate: value } });
      return;
    }
    if (this.globalConfig) this.globalConfig.preferences.autoUpdate = value;
    if (this.config) this.config.preferences.autoUpdate = value;
  }

  /**
   * Applies `mutate` to the config file's raw JSON and writes it back when `mutate` returns true. The caller holds
   * the config write lock. Returns false when there is no file; rejects when it cannot be read or is not an object.
   */
  private async patchConfigText(
    mutate: (raw: Record<string, unknown>) => boolean,
    notAnObject = () => new Error(`Could not update ${this.configPath}: it does not hold a JSON object`)
  ): Promise<boolean> {
    const text = await this.readConfigText();
    if (text === null) return false;
    const raw = this.parseConfigText(text);
    if (!raw) throw notAnObject();
    if (mutate(raw)) await this.writeConfigFile(JSON.stringify(raw, null, 2));
    return true;
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
    let newUrl: string;
    let newApiConfig: CliConfig['apiConfig'];
    if (target === 'prod') {
      newUrl = getDefaultApiUrl();
      newApiConfig = { endpointChosen: true };
    } else if (target === 'dev') {
      newUrl = LOCAL_DEV_URL;
      newApiConfig = { customUrl: LOCAL_DEV_URL, endpointChosen: true };
    } else {
      newUrl = target.customUrl;
      newApiConfig = { customUrl: target.customUrl, endpointChosen: true };
    }
    const envName = getEnvironmentName(newApiConfig);

    return this.lockedWrite(async () => {
      const g = this.globalConfig!;
      const wasHere = normalizeEnvKey(g.apiConfig?.customUrl || getDefaultApiUrl()) === normalizeEnvKey(newUrl);
      // The swap starts from the file, which another process may have switched or signed in since this one loaded.
      const disk = await this.diskAuthFields();
      const auth = AuthTokensSchema.optional().safeParse(disk.auth);
      const authByEnv = z.record(z.string(), AuthTokensSchema).optional().safeParse(disk.authByEnv);
      if (!auth.success || !authByEnv.success) {
        throw new Error(
          `Could not switch backend: the saved sign-in in ${this.configPath} is not in the expected shape`
        );
      }
      const onDisk = ApiConfigSchema.optional().safeParse(disk.apiConfig);
      const diskApi = onDisk.success ? onDisk.data : undefined;
      const swap = swapActiveEnvAuth(
        { auth: auth.data, authByEnv: authByEnv.data },
        diskApi?.customUrl || getDefaultApiUrl(),
        newUrl
      );
      const apiConfig = swap.changed || !diskApi?.endpointChosen ? newApiConfig : diskApi;
      const nextAuthByEnv = swap.changed ? swap.authByEnv : authByEnv.data;
      // Memory follows only once the file holds the switch; writeGlobal replaced the snapshot object.
      const follow = () => {
        const next = this.globalConfig!;
        next.apiConfig = apiConfig;
        next.authByEnv = nextAuthByEnv;
        next.auth = swap.auth; // undefined -> user will be prompted to /login
      };
      if (swap.changed || !diskApi?.endpointChosen) {
        await this.writeGlobal(undefined, {
          authFields: { auth: swap.auth, authByEnv: nextAuthByEnv, apiConfig },
          onCommit: follow,
        });
      } else {
        follow();
        await this.refreshMerged();
      }
      return { url: newUrl, envName, changed: !wasHere, authenticated: isAuthTokenValid(swap.auth) };
    });
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
      const remove = (config: CliConfig) => {
        config.additionalDirectories = (config.additionalDirectories || []).filter(
          d => path.resolve(d) !== resolvedPath
        );
      };
      remove(g);
      const removed = (d: unknown) => typeof d === 'string' && path.resolve(d) === resolvedPath;
      const revoke = (raw: Record<string, unknown>) => removeRawListItems(raw, 'additionalDirectories', removed);
      if (await this.patchInFallback(remove, revoke)) return;
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
