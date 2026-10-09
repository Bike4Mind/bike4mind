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
  /** Set when the assistant added the server from a conversation, rather than the user in Customize. */
  addedBy?: McpServerProvenance;
}

/** Where an assistant-added server came from. Metadata, not a secret: stored in plaintext. */
export interface McpServerProvenance {
  sessionId: string;
  sessionTitle: string;
  addedAt: string;
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

/**
 * The assistant's server tools, as both processes see them. Adding a server and changing one
 * ride a card of their own (see McpServerRequestCard) that only a click can answer.
 */
export const MCP_ADD_SERVER_TOOL_NAME = 'mcp_add_server';
export const MCP_UPDATE_SERVER_TOOL_NAME = 'mcp_update_server';

export function isMcpConfigToolName(name: string): boolean {
  return name === MCP_ADD_SERVER_TOOL_NAME || name === MCP_UPDATE_SERVER_TOOL_NAME;
}

/** One secret the card asks the user to type: its name, and the model's note on what it is. */
export interface McpSecretKey {
  name: string;
  description?: string;
}

/**
 * What an add or update card shows, as main normalized it. This is the call's input on the wire
 * and in the transcript, so it carries key NAMES and never a value.
 */
export interface McpServerRequest {
  /** The server's id, on an update. */
  serverId?: string;
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  env_keys: McpSecretKey[];
  header_keys: McpSecretKey[];
  /** On an update: the listed keys that already hold a value, which a blank field keeps. */
  stored_keys?: string[];
  reason: string;
}

/**
 * What became of the card. 'saved' carries the server id; the model never supplies this, main
 * sets it after the click.
 */
export type McpServerRequestOutcome =
  { status: 'saved'; serverId: string } | { status: 'declined' } | { status: 'cancelled' };

export function parseMcpRequestOutcome(value: unknown): McpServerRequestOutcome | null {
  if (typeof value !== 'object' || value === null) return null;
  const { status, serverId } = value as { status?: unknown; serverId?: unknown };
  if (status === 'saved') return typeof serverId === 'string' && serverId ? { status, serverId } : null;
  return status === 'declined' || status === 'cancelled' ? { status } : null;
}

export function parseMcpServerRequest(input: Record<string, unknown>): McpServerRequest | null {
  const { name, transport, reason } = input;
  if (typeof name !== 'string' || typeof reason !== 'string') return null;
  if (transport !== 'stdio' && transport !== 'http') return null;
  const keys = (value: unknown): McpSecretKey[] =>
    Array.isArray(value)
      ? value.flatMap(entry =>
          typeof entry === 'object' && entry !== null && typeof (entry as McpSecretKey).name === 'string'
            ? [
                {
                  name: (entry as McpSecretKey).name,
                  ...(typeof (entry as McpSecretKey).description === 'string'
                    ? { description: (entry as McpSecretKey).description }
                    : {}),
                },
              ]
            : []
        )
      : [];
  return {
    ...(typeof input.serverId === 'string' ? { serverId: input.serverId } : {}),
    name,
    transport,
    ...(typeof input.command === 'string' ? { command: input.command } : {}),
    ...(Array.isArray(input.args) ? { args: input.args.filter((arg): arg is string => typeof arg === 'string') } : {}),
    ...(typeof input.url === 'string' ? { url: input.url } : {}),
    env_keys: keys(input.env_keys),
    header_keys: keys(input.header_keys),
    ...(Array.isArray(input.stored_keys)
      ? { stored_keys: input.stored_keys.filter((key): key is string => typeof key === 'string') }
      : {}),
    reason,
  };
}
