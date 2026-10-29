/**
 * Model servers on other machines, as Settings and the picker see them. Credential-free: tokens and
 * header values stay in main (see main/modelServers/ModelServerStore), and only their kind crosses.
 */

export type ModelServerKind = 'ollama' | 'openai-compatible';

/** What this device may do on the server. Only chat is wired so far; pulls and removals need 'manage'. */
export type ModelServerAccess = 'chat' | 'manage';

/** How the server is reached. Only 'http' exists today; an SSH destination is a later variant. */
export type ModelServerTransport = { type: 'http'; baseUrl: string };

export type ModelServerAuthKind = 'none' | 'bearer' | 'header';

/** The credential as typed in Settings. It goes renderer to main once and is never sent back. */
export type ModelServerCredentialInput =
  { type: 'none' } | { type: 'bearer'; token: string } | { type: 'header'; name: string; value: string };

export type ModelServerState = 'unknown' | 'online' | 'unreachable' | 'credentials' | 'refused';

export interface ModelServerHealth {
  state: ModelServerState;
  /** Runtime version when the server reports one. */
  version: string | null;
  latencyMs: number | null;
  /** ISO time of the last check. */
  checkedAt: string | null;
  /** Why it is not online; never contains a credential. */
  error: string | null;
}

/** "This computer" is the record with `local: true`; it is always first and cannot be removed. */
export interface ModelServerView {
  id: string;
  name: string;
  local: boolean;
  kind: ModelServerKind;
  address: string;
  access: ModelServerAccess;
  auth: { type: ModelServerAuthKind; headerName?: string };
  /** False when the credential is kept only until Desktop quits, because this computer has no keyring. */
  credentialsPersisted: boolean;
  /** True when a credential is configured but could not be read back (lost keyring, or session-only after a restart). */
  credentialsMissing: boolean;
  /** Plain http to a private-range address: reachable, but anyone on that network can read the traffic. */
  unencrypted: boolean;
  health: ModelServerHealth;
  /** Model names from the last successful list, kept so a server that is down still shows them. */
  models: string[];
}

export interface ModelServerProbeInput {
  address: string;
  credential: ModelServerCredentialInput;
}

export interface ModelServerProbeResult {
  ok: boolean;
  /** Normalized address the server answered at. */
  address: string | null;
  kind: ModelServerKind | null;
  version: string | null;
  latencyMs: number | null;
  models: number | null;
  /** The server wants credentials, or refused the ones given. */
  needsCredentials: boolean;
  unencrypted: boolean;
  /** A public address that answered without credentials: anyone who finds it can use it. */
  openToAnyone: boolean;
  /** A suggested name, from the host. */
  suggestedName: string | null;
  error: string | null;
}

export interface ModelServerAddInput extends ModelServerProbeInput {
  name: string;
  kind: ModelServerKind;
  access: ModelServerAccess;
  /** Required when the probe said `openToAnyone`. */
  acceptOpen?: boolean;
}

export interface ModelServerUpdateInput {
  name?: string;
  kind?: ModelServerKind;
  access?: ModelServerAccess;
  /** Replaces the stored credential; omitted keeps it. */
  credential?: ModelServerCredentialInput;
}

export type ModelServerMutationResult = { ok: true; servers: ModelServerView[] } | { ok: false; error: string };

/**
 * What the Models screen may do on a server: `chat-only` is the server's "Chat only" setting, and
 * `unsupported` an OpenAI-compatible server, which lists models but has no pull or delete API.
 */
export type ModelServerManagement = 'allowed' | 'chat-only' | 'unsupported';

export function serverManagement(server: Pick<ModelServerView, 'local' | 'kind' | 'access'>): ModelServerManagement {
  if (server.local) return 'allowed';
  if (server.kind !== 'ollama') return 'unsupported';
  return server.access === 'manage' ? 'allowed' : 'chat-only';
}

export const LOCAL_SERVER_ID = 'local';
export const LOCAL_SERVER_NAME = 'This computer';

/** Runtime ids of saved servers, inside `local:<runtime>:<model>` model ids. */
export const SERVER_RUNTIME_PREFIX = 'srv-';

export function serverRuntimeId(serverId: string): string {
  return `${SERVER_RUNTIME_PREFIX}${serverId}`;
}

export function serverIdOfRuntime(runtimeId: string): string | null {
  return runtimeId.startsWith(SERVER_RUNTIME_PREFIX) ? runtimeId.slice(SERVER_RUNTIME_PREFIX.length) : null;
}
