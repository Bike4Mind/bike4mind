/**
 * The MCP vocabulary that crosses the contextBridge.
 *
 * Credential-free like @shared/auth and @shared/chat, with one wrinkle of its own: a server
 * config CONTAINS secrets (an API key in a stdio child's environment, a bearer token in an
 * HTTP header). Those values live in the main process behind safeStorage and are never sent
 * to the renderer - {@link McpServerState} carries the NAMES of the variables and headers a
 * server has, never the values. The renderer can therefore say "GITHUB_TOKEN is set" and offer
 * to replace it, and cannot read it back.
 */

export type McpTransport = 'stdio' | 'http';

/**
 * Where a server is in its lifecycle.
 *
 * 'failed' is deliberately distinct from 'idle': a server that never started and one that is
 * merely not connected yet look identical in a list that only counts tools, which is the
 * failure mode this whole state exists to prevent.
 */
export type McpServerStatus = 'disabled' | 'idle' | 'connecting' | 'connected' | 'failed';

/** One tool a connected server contributed, as the UI lists it. */
export interface McpToolSummary {
  /** The name the model sees, namespaced by server. See main/chat/mcp/names.ts. */
  name: string;
  /** The name the SERVER knows it by, which is what its own docs will call it. */
  remoteName: string;
}

/** A configured server and what it is doing right now. Safe to hand to the renderer. */
export interface McpServerState {
  id: string;
  name: string;
  transport: McpTransport;
  enabled: boolean;
  status: McpServerStatus;
  /** stdio only. */
  command?: string;
  args?: string[];
  /** http only. */
  url?: string;
  /** Names only - the values never leave the main process. */
  envKeys: string[];
  headerKeys: string[];
  tools: McpToolSummary[];
  /** Why the last connection attempt failed, when it did. */
  error?: string;
  /** The last few lines the stdio child wrote to stderr, which is usually why it failed. */
  stderr?: string;
}

/**
 * A server as the user describes it in the dialog.
 *
 * `env` and `headers` are the only place plaintext secrets travel renderer -> main, which is
 * the same direction and the same trust as typing them into the OS keychain prompt. Omitting
 * either on an update KEEPS what is stored; sending one replaces it wholesale.
 */
export interface McpServerInput {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface McpServersState {
  servers: McpServerState[];
  /**
   * False when the OS has no keychain this app can reach (Linux with no keyring), in which
   * case a server's secrets are held in memory for this run and never written. The dialog says
   * so rather than silently losing them on quit; the vault NEVER falls back to plaintext.
   */
  secretsPersisted: boolean;
}

export type McpMutationResult = { ok: true; state: McpServersState } | { ok: false; error: string };
