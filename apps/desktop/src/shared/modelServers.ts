/**
 * Model servers on other machines, as Settings and the picker see them. Credential-free: tokens and
 * header values stay in main (see main/modelServers/ModelServerStore), and only their kind crosses.
 */

export type ModelServerKind = 'ollama' | 'openai-compatible';

/** What this device may do on the server. Only chat is wired so far; pulls and removals need 'manage'. */
export type ModelServerAccess = 'chat' | 'manage';

/** How the server is reached: an address, or the system ssh to the far end's Ollama on its loopback. */
export type ModelServerTransport = { type: 'http'; baseUrl: string } | { type: 'ssh'; destination: string };
export type ModelServerTransportType = ModelServerTransport['type'];

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
  transport: ModelServerTransportType;
  /** The URL, or the SSH destination. */
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
  /** Who runs the server and the settings it starts with. */
  launch: ModelServerLaunchView | null;
}

/** OLLAMA_KV_CACHE_TYPE values besides f16 that fit.ts can price; must match the copy in local-models servers. */
export const QUANTIZED_KV_CACHE_TYPES = ['q8_0', 'q4_0'] as const;
export type QuantizedKvCacheType = (typeof QUANTIZED_KV_CACHE_TYPES)[number];

/** OLLAMA_FLASH_ATTENTION or llama-server's --flash-attn when set; unset is auto. */
export type FlashAttention = 'on' | 'off';

/** What Desktop runs for a server it starts on this computer: `ollama serve`, or llama-server in router mode. */
export type LaunchRuntime = 'ollama' | 'llama-server';

/** Settings a server reads only when it starts, so Desktop applies them only to a server it starts. Absent is the default. */
export interface ModelServerLaunchSettings {
  /** Ollama: OLLAMA_KV_CACHE_TYPE for every model; absent is f16. */
  kvCacheType?: QuantizedKvCacheType;
  /** OLLAMA_FLASH_ATTENTION, or llama-server's --flash-attn; absent is auto. */
  flashAttention?: FlashAttention;
  /** llama-server: the program; absent is the one on PATH. */
  binaryPath?: string;
  /** llama-server: the folder of GGUF files it serves. */
  modelsDir?: string;
}

/**
 * Who runs the server at a saved address: `desktop`, one Desktop started and still runs; `other`, anything else that
 * answers there; `none`, nothing answers; `remote`, another machine, an SSH server included.
 */
export type LaunchOwner = 'desktop' | 'other' | 'none' | 'remote';

export interface ModelServerLaunchView {
  runtime: LaunchRuntime;
  owner: LaunchOwner;
  busy: 'starting' | 'stopping' | null;
  /** As saved; they apply on Desktop's next start. */
  settings: ModelServerLaunchSettings;
  /** Desktop's server started with other settings than the saved ones. */
  pendingRestart: boolean;
  /** Nothing answers there, and Desktop has what it needs to start the server. */
  canStart: boolean;
  /** Why Desktop cannot start it, or why its last start or run ended. */
  problem: string | null;
  /** Launch variables read from a server Desktop did not start, by name; null when Desktop cannot read them. */
  observed: Record<string, string> | null;
  /** The KV cache type fit sizes this server's models with. */
  sizingKvCacheType: QuantizedKvCacheType | 'f16';
  /** The flash attention fit sizes this server's models with. */
  sizingFlashAttention: FlashAttention | 'auto';
  /**
   * What the launch form starts from while nothing is saved: the settings last read from an Ollama Desktop did not
   * start here, kept after it stops, and the variables they came from ("OLLAMA_KV_CACHE_TYPE=q8_0").
   */
  prefill: { settings: ModelServerLaunchSettings; from: string } | null;
  /** What answers there, for "This <noun> was not started by Bike4Mind Desktop": "Ollama server", "llama-server". */
  noun: string;
}

/** Why Desktop leaves this server's launch settings alone; null when it applies them. */
export function launchLockedMessage(launch: Pick<ModelServerLaunchView, 'owner' | 'noun'>): string | null {
  if (launch.owner === 'remote')
    return `This ${launch.noun} runs on another machine, so Desktop can't start it or apply these settings.`;
  if (launch.owner === 'other')
    return `This ${launch.noun} was not started by Bike4Mind Desktop, so Desktop can't apply these settings. To use them, stop that server and start it from Desktop.`;
  return null;
}

const MAX_LAUNCH_PATH_CHARS = 1_024;
const ABSOLUTE_PATH = /^(?:\/|[a-z]:[\\/]|\\\\[^\\])/i;

/** The launch fields from an untrusted value; anything malformed is dropped. */
export function readLaunchShape(value: unknown): ModelServerLaunchSettings {
  if (typeof value !== 'object' || value === null) return {};
  const raw = value as Record<string, unknown>;
  const kv = QUANTIZED_KV_CACHE_TYPES.find(type => type === raw.kvCacheType);
  const flash = raw.flashAttention === 'on' || raw.flashAttention === 'off' ? raw.flashAttention : undefined;
  const path = (field: unknown) =>
    typeof field === 'string' && field.trim() ? field.trim().slice(0, MAX_LAUNCH_PATH_CHARS + 1) : undefined;
  const binaryPath = path(raw.binaryPath);
  const modelsDir = path(raw.modelsDir);
  return {
    ...(kv ? { kvCacheType: kv } : {}),
    ...(flash ? { flashAttention: flash } : {}),
    ...(binaryPath ? { binaryPath } : {}),
    ...(modelsDir ? { modelsDir } : {}),
  };
}

export function sameLaunch(a: ModelServerLaunchSettings, b: ModelServerLaunchSettings): boolean {
  return (
    a.kvCacheType === b.kvCacheType &&
    a.flashAttention === b.flashAttention &&
    a.binaryPath === b.binaryPath &&
    a.modelsDir === b.modelsDir
  );
}

/** Why Desktop cannot save or start with these settings; null when it can. */
export function launchSettingsProblem(settings: ModelServerLaunchSettings, runtime: LaunchRuntime): string | null {
  if (runtime === 'ollama' && (settings.binaryPath || settings.modelsDir))
    return 'Desktop finds Ollama itself and uses its own models folder.';
  if (runtime === 'llama-server' && settings.kvCacheType) return 'The KV cache type applies to Ollama servers only.';
  if (settings.kvCacheType && settings.flashAttention === 'off')
    return `A ${settings.kvCacheType} KV cache needs flash attention. Set flash attention to Auto or On.`;
  for (const [path, what] of [
    [settings.binaryPath, 'llama-server'],
    [settings.modelsDir, 'the models folder'],
  ] as const) {
    if (path !== undefined && (path.length > MAX_LAUNCH_PATH_CHARS || !ABSOLUTE_PATH.test(path)))
      return `Enter the full path to ${what}.`;
  }
  return null;
}

/**
 * Hardware typed in Settings, which fit badges and Curated picks rate against. Memory is in GiB, the unit RAM and
 * GPUs are sold in; bandwidth is in GB/s and sets the reply speed estimate, which orders Curated picks within a fit
 * class but never changes the rating. Blank fields are null.
 */
export interface ModelServerSpecs {
  ramGiB: number | null;
  gpuMemoryGiB: number | null;
  bandwidthGBps: number | null;
  /** The GPU uses system RAM, as on Apple silicon. Only for a saved server: this computer's probe says so itself. */
  unified: boolean;
  /**
   * A remote or SSH Ollama's OLLAMA_KV_CACHE_TYPE, which its API does not report and Desktop cannot set; absent is
   * f16. A server Desktop can start keeps its cache type in launch settings instead.
   */
  kvCacheType?: QuantizedKvCacheType;
}

export const MAX_SPEC_MEMORY_GIB = 65_536;
export const MAX_SPEC_BANDWIDTH_GBPS = 100_000;

/** Specs that set memory, which is all that changes a rating. */
export function specsRate(specs: ModelServerSpecs | null): specs is ModelServerSpecs {
  return !!specs && (specs.ramGiB !== null || specs.gpuMemoryGiB !== null);
}

/** The spec fields from an untrusted value; null when it is not an object. Figures are not range-checked. */
export function readSpecsShape(value: unknown): ModelServerSpecs | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const figure = (field: unknown) => (typeof field === 'number' ? field : null);
  const kv = QUANTIZED_KV_CACHE_TYPES.find(type => type === raw.kvCacheType);
  return {
    ramGiB: figure(raw.ramGiB),
    gpuMemoryGiB: figure(raw.gpuMemoryGiB),
    bandwidthGBps: figure(raw.bandwidthGBps),
    unified: raw.unified === true,
    ...(kv ? { kvCacheType: kv } : {}),
  };
}

/** No figure and no cache type, which is stored as no specs. */
export function specsBlank(specs: ModelServerSpecs): boolean {
  return specs.ramGiB === null && specs.gpuMemoryGiB === null && specs.bandwidthGBps === null && !specs.kvCacheType;
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
  if (
    !local &&
    specs.ramGiB === null &&
    (specs.gpuMemoryGiB !== null || specs.bandwidthGBps !== null || specs.kvCacheType !== undefined)
  )
    return 'Enter the RAM too. Desktop needs it to rate models for this server.';
  return null;
}

export interface ModelServerProbeInput {
  /** A URL, or with `transport: 'ssh'` an SSH destination (`user@host` or a Host alias). */
  address: string;
  credential: ModelServerCredentialInput;
  /** Defaults to 'http'. An SSH server takes no credential: ssh signs in with the user's keys. */
  transport?: ModelServerTransportType;
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
  /** Nothing answers at this address on this computer, so it can be saved for Desktop to start a server there. */
  launchable?: boolean;
}

export interface ModelServerAddInput extends ModelServerProbeInput {
  name: string;
  kind: ModelServerKind;
  access: ModelServerAccess;
  /** Required when the probe said `openToAnyone`. */
  acceptOpen?: boolean;
  /** Save a `launchable` address that does not answer yet, for Desktop to start a server there. */
  launch?: boolean;
}

export interface ModelServerUpdateInput {
  name?: string;
  kind?: ModelServerKind;
  access?: ModelServerAccess;
  /** Replaces the stored credential; omitted keeps it. */
  credential?: ModelServerCredentialInput;
  /** Replaces the entered hardware; null clears it. "This computer" takes only this and `launch`. */
  specs?: ModelServerSpecs | null;
  /** Replaces the launch settings, which apply on Desktop's next start of the server. */
  launch?: ModelServerLaunchSettings;
}

export type ModelServerMutationResult = { ok: true; servers: ModelServerView[] } | { ok: false; error: string };

export type ModelServerLaunchAction = 'start' | 'stop' | 'restart';

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
