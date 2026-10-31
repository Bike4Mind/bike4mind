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
  /** Hardware entered in Settings; null when none is. */
  specs: ModelServerSpecs | null;
  /** Set while the server refuses tool calls: why, and how to turn them on. */
  toolsHint?: string;
}

/**
 * Hardware typed in Settings, which fit badges and Curated picks rate against. Memory is in GiB, the unit RAM and
 * GPUs are sold in; bandwidth is in GB/s and nothing rates against it yet. Blank fields are null.
 */
export interface ModelServerSpecs {
  ramGiB: number | null;
  gpuMemoryGiB: number | null;
  bandwidthGBps: number | null;
  /** The GPU uses system RAM, as on Apple silicon. Only for a saved server: this computer's probe says so itself. */
  unified: boolean;
}

export const MAX_SPEC_MEMORY_GIB = 65_536;
export const MAX_SPEC_BANDWIDTH_GBPS = 100_000;

/** Specs that set memory, which is all that changes a rating. */
export function specsRate(specs: ModelServerSpecs | null): specs is ModelServerSpecs {
  return !!specs && (specs.ramGiB !== null || specs.gpuMemoryGiB !== null);
}

/** The four spec fields from an untrusted value; null when it is not an object. Figures are not range-checked. */
export function readSpecsShape(value: unknown): ModelServerSpecs | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const figure = (field: unknown) => (typeof field === 'number' ? field : null);
  return {
    ramGiB: figure(raw.ramGiB),
    gpuMemoryGiB: figure(raw.gpuMemoryGiB),
    bandwidthGBps: figure(raw.bandwidthGBps),
    unified: raw.unified === true,
  };
}

/** Why Settings cannot save these specs; null when it can. A saved server needs RAM, having no probe to fall back on. */
export function specsProblem(specs: ModelServerSpecs, local: boolean): string | null {
  const out = (value: number | null, max: number) =>
    value !== null && !(Number.isFinite(value) && value > 0 && value <= max);
  if (out(specs.ramGiB, MAX_SPEC_MEMORY_GIB))
    return `Enter RAM as a number of GB above 0, up to ${MAX_SPEC_MEMORY_GIB}.`;
  if (out(specs.gpuMemoryGiB, MAX_SPEC_MEMORY_GIB))
    return `Enter GPU memory as a number of GB above 0, up to ${MAX_SPEC_MEMORY_GIB}.`;
  if (out(specs.bandwidthGBps, MAX_SPEC_BANDWIDTH_GBPS))
    return `Enter memory bandwidth as a number of GB/s above 0, up to ${MAX_SPEC_BANDWIDTH_GBPS}.`;
  if (!local && specs.ramGiB === null && (specs.gpuMemoryGiB !== null || specs.bandwidthGBps !== null))
    return 'Enter the RAM too. Desktop needs it to rate models for this server.';
  return null;
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
  /** Replaces the entered hardware; null clears it. The only field "This computer" takes. */
  specs?: ModelServerSpecs | null;
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
