import { McpServerName } from '@bike4mind/common';

/**
 * Environment construction for the MCP stdio child process.
 *
 * The child is spawned from a process that also holds platform credentials - provider API keys,
 * database URIs, signing secrets - so what it inherits is a trust decision, not a convenience.
 * Two rules follow:
 *
 * 1. The child environment is built from an allowlist, never spread from `process.env`. The base
 *    layer is the MCP SDK's own `getDefaultEnvironment()`, which the stdio transport merges
 *    underneath whatever we pass (PATH, HOME, SHELL, TERM, USER on POSIX; the equivalent set on
 *    Windows). Everything above that base comes from the table below.
 * 2. A stored variable is provider data, never runtime configuration. The child is a Node
 *    process, so a key like NODE_OPTIONS is applied by the runtime before a single line of
 *    server code loads: `--require /tmp/x.js` would turn a credential field into arbitrary code
 *    execution inside the child. Those keys are refused rather than dropped quietly.
 *
 * MUST STAY IN SYNC with the `process.env` reads under each server directory
 * (`github/config.ts`, `notion/config.ts`, `atlassian/config.ts`, `linkedin/index.ts`). A
 * variable a server reads but this table omits arrives `undefined`, so add it here in the same
 * change. `childEnv.test.ts` pins that both ways.
 */
export const MCP_SERVER_ENV_KEYS: Readonly<Record<McpServerName, readonly string[]>> = {
  [McpServerName.LinkedIn]: ['LINKEDIN_ACCESS_TOKEN', 'COMPANY_NAME'],
  [McpServerName.Github]: ['GITHUB_ACCESS_TOKEN'],
  [McpServerName.Atlassian]: ['ATLASSIAN_ACCESS_TOKEN', 'ATLASSIAN_CLOUD_ID', 'ATLASSIAN_SITE_URL'],
  [McpServerName.Notion]: [
    'NOTION_ACCESS_TOKEN',
    'NOTION_WORKSPACE_ID',
    'NOTION_WRITE_ENABLED',
    'NOTION_ROOT_PAGE_ID',
    'NOTION_ACCESS_MODE',
    'NOTION_ALLOWED_PAGES',
    'NOTION_EXCLUDED_PAGE_IDS',
    'NOTION_DEBUG',
  ],
};

/**
 * Keys no caller-supplied MCP variable may ever set, whatever the server.
 *
 * These do not configure a server, they steer the runtime hosting it: NODE_* and the loader
 * preload variables execute code before the server starts, npm_* redirects package resolution,
 * PATH decides which binary a custom command resolves to, and the proxy variables silently
 * redirect the child's outbound traffic. Matching is case-insensitive because Windows
 * environment names are.
 */
const FORBIDDEN_ENV_KEY_PATTERNS: readonly RegExp[] = [
  /^NODE_/i,
  /^npm_/i,
  /^ELECTRON_RUN_AS_NODE$/i,
  /^LD_/i,
  /^DYLD_/i,
  /^PATH$/i,
  /^PATHEXT$/i,
  /^(HTTP|HTTPS|ALL|NO|FTP)_PROXY$/i,
  /^GLOBAL_AGENT_/i,
];

export interface McpEnvVariable {
  key: string;
  value: string;
}

/** True when `key` controls the child runtime rather than the MCP server running inside it. */
export function isForbiddenMcpEnvKey(key: string): boolean {
  const normalized = key.trim();
  return FORBIDDEN_ENV_KEY_PATTERNS.some(pattern => pattern.test(normalized));
}

/** The forbidden keys present in `envVariables`, in input order. Empty when the set is clean. */
export function findForbiddenMcpEnvKeys(envVariables: readonly { key: string }[]): string[] {
  return envVariables.filter(variable => isForbiddenMcpEnvKey(variable.key)).map(variable => variable.key);
}

export interface McpChildEnv {
  /** Variables to layer on top of the SDK's default environment. */
  env: Record<string, string>;
  /** Keys the caller supplied that were withheld from the child. Names only - values are secret. */
  droppedKeys: string[];
}

export interface BuildMcpChildEnvOptions {
  /** The server the variables were configured for. */
  serverName: string;
  envVariables: readonly McpEnvVariable[];
  /**
   * True when the child is an arbitrary command the caller supplied rather than one of this
   * package's bundled server scripts. `MCP_SERVER_ENV_KEYS` describes what *our* server for a
   * given name reads, so it says nothing about someone else's program - a CLI config may well
   * point `name: "github"` at the upstream Docker image, which wants `GITHUB_TOKEN`.
   */
  hasCustomCommand?: boolean;
}

/**
 * Build the environment for a stdio MCP child.
 *
 * A bundled server gets exactly its declared variables. A caller-defined command has no declared
 * contract to check against, so it gets everything except the keys that would steer its runtime.
 */
export function buildMcpChildEnv({
  serverName,
  envVariables,
  hasCustomCommand = false,
}: BuildMcpChildEnvOptions): McpChildEnv {
  const declaredKeys = hasCustomCommand
    ? undefined
    : (MCP_SERVER_ENV_KEYS as Record<string, readonly string[] | undefined>)[serverName];
  const isAllowed = declaredKeys
    ? (key: string) => declaredKeys.includes(key)
    : (key: string) => !isForbiddenMcpEnvKey(key);

  const env: Record<string, string> = {};
  const droppedKeys: string[] = [];

  for (const { key, value } of envVariables) {
    if (!isAllowed(key)) {
      droppedKeys.push(key);
      continue;
    }
    env[key] = value;
  }

  return { env, droppedKeys };
}
