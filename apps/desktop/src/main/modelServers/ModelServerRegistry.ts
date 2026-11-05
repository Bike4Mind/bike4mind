import dns from 'node:dns';
import { isIP } from 'node:net';
import {
  OllamaRuntime,
  OpenAICompatibleRuntime,
  PullIdleTimeoutError,
  RuntimeConnectionError,
  RuntimeHttpError,
  type FetchLike,
  type LocalRuntime,
  type OllamaEnvironment,
  type OpenAICompatibleProduct,
} from '@bike4mind/local-models';
import {
  answersWithoutCredentials,
  createServerFetch,
  createSshFetch,
  describeFailure,
  DROP_CODES,
  errorCode,
  leastTrusted,
  parseServerAddress,
  probeServer,
  redactServerResponse,
  scopeOfIp,
  parseSshDestination,
  ServerRedirectError,
  ServerTransportError,
  SSH_OLLAMA_URL,
  SSH_PROBE_TIMEOUT_MS,
  sshDestinationProblem,
  suggestServerName,
  suggestSshName,
  transportVerdict,
  type AddressScope,
  type ParsedAddress,
  type ServerEndpoint,
  type SshEndpoint,
} from '@bike4mind/local-models/servers';
import { localBackend, localModelId, type ChatModelOption } from '@shared/chat';
import {
  launchLockedMessage,
  launchSettingsProblem,
  LOCAL_SERVER_ID,
  LOCAL_SERVER_NAME,
  sameLaunch,
  serverIdOfRuntime,
  serverManagement,
  serverRuntimeId,
  type LaunchOwner,
  type LaunchRuntime,
  type ModelServerAddInput,
  type ModelServerHealth,
  type ModelServerLaunchSettings,
  type ModelServerLaunchView,
  type ModelServerProbeInput,
  type ModelServerProbeResult,
  type ModelServerSpecs,
  type ModelServerUpdateInput,
  type ModelServerView,
  type QuantizedKvCacheType,
} from '@shared/modelServers';
import type { LocalChat } from '../chat/localChat';
import { OllamaLocal, type LoadSettingsReader } from '../chat/OllamaLocal';
import type { ModelHubServer } from '../models/ModelHubService';
import { ServerCredentialsError, ServerForbiddenError, ServerUnreachableError } from './errors';
import { LocalServerSupervisor, type Launchers } from './LocalServerSupervisor';
import { withLocalNetworkHint } from './localNetworkHint';
import { loopbackPortFree } from './loopbackPort';
import { credentialHeaders, type ModelServerRecord, type ModelServerStore } from './ModelServerStore';
import { observedKvCacheType, observedLaunchVars } from './observedOllama';
import { OpenAICompatibleChat } from './OpenAICompatibleChat';

export const LOCAL_OLLAMA_URL = 'http://127.0.0.1:11434';
const LOCAL_TIMEOUT_MS = 1_500;
/** Background recheck while the app runs. */
export const HEALTH_INTERVAL_MS = 60_000;
const RECHECK_AFTER_MS = 10_000;
const OBSERVE_TTL_MS = 5 * 60_000;
/** `dns.lookup` has no timeout of its own and can hang on a slow resolver. */
const RESOLVE_TIMEOUT_MS = 5_000;
/** How long a picker load waits on a down server's check before listing its last models. */
export const PICKER_CHECK_WAIT_MS = 2_000;
/**
 * How long a picker load waits on an online server's model list before showing its last names, disabled. A LAN
 * Ollama lists in well under a second; this leaves room for an SSH server's connection setup.
 */
export const PICKER_LIST_WAIT_MS = 3_000;
/** Counted from the last late-listing notice too, so the reload a notice causes starts no new slow listing. */
export const LISTED_FRESH_MS = 5_000;

interface ServerClient extends LocalChat {
  listModels(): Promise<ChatModelOption[]>;
  toolsHint?(): string | null;
  recheckTools?(model: string | undefined): Promise<void>;
}

interface Entry {
  record: ModelServerRecord;
  /** For an SSH server, the far end's loopback Ollama. */
  parsed: ParsedAddress;
  /** The SSH destination; null for a server reached by address. */
  ssh: string | null;
  scope: AddressScope | null;
  fetch: FetchLike;
  client: ServerClient;
  /** What the Models screen lists, pulls and removes through, over the same fetch as chat. */
  runtime: LocalRuntime;
  health: ModelServerHealth;
  product: OpenAICompatibleProduct | null;
  /** From the last listing, so a conversation saved on an alias still finds its model while the server is down. */
  aliasIds?: ReadonlyMap<string, string[]>;
  /** The listing in flight, shared by the picker and health checks. */
  slot?: Slot;
  /** Sequence number of the last listing started. */
  listSeq: number;
  /** Listings numbered below this started before a pull or removal and change nothing when they land. */
  floor: number;
  /** A listing that finished after a caller was given pending rows, served instead of a new listing while fresh. */
  kept?: { models: ChatModelOption[]; at: number };
}

type Listing = { ok: true; models: ChatModelOption[] } | { ok: false; error: unknown };

export interface ModelListOptions {
  /** The server a turn runs on: the read waits out its listing, and every other server keeps the picker's wait. */
  untilListed?: string;
}

interface Slot {
  seq: number;
  promise: Promise<Listing>;
  /** A caller was given pending rows for this listing, so its result is kept and announced when it lands. */
  reported: boolean;
  /** A models() call waits on this listing, so its failure marks the server down; a health check's alone does not. */
  picker: boolean;
}

export interface ModelServerRegistryDeps {
  store: ModelServerStore;
  logger: { debug(message: string): void; warn(message: string): void };
  /** Called with the full list whenever a server or its health changes. */
  changed?(servers: ModelServerView[]): void;
  /** A server was added, saved or removed, or its tools changed, so a model list read before now is out of date. */
  edited?(): void;
  /** The picker should list again: a server was removed, or its listing outlasted the picker's wait and finished. */
  listedLate?(serverId: string): void;
  /** Resolves a host name to its addresses; defaults to `dns.lookup` with `all: true`. */
  resolve?(host: string): Promise<string[]>;
  fetchFor?(endpoint: ServerEndpoint): FetchLike;
  /** For servers reached over SSH; defaults to the system ssh (createSshFetch). */
  sshFetchFor?(endpoint: SshEndpoint): FetchLike;
  /** For "This computer"; defaults to the global fetch. */
  localFetch?: FetchLike;
  now?(): number;
  /** This computer's entered hardware was loaded or changed, so whatever was sized from its probe is stale. */
  localSpecsChanged?(): void;
  /** Defaults to `process.platform`; decides whether a LAN failure gets the macOS Local Network hint. */
  platform?: NodeJS.Platform;
  /** Each model's load settings from the Models screen, which every request for it carries. */
  loadSettings?: LoadSettingsReader;
  /** How Desktop finds and starts the servers it runs; defaults to this computer's own (hostLaunchers). */
  launchers?: Launchers;
  /** The launch variables of the Ollama at `url` on this computer; null when they cannot be read, as without this. */
  readOllamaEnv?(url: string): Promise<OllamaEnvironment | null>;
  /** Whether Desktop could start a server on 127.0.0.1:port now; defaults to trying to bind it (loopbackPortFree). */
  portFree?(port: number): Promise<boolean>;
}

/** Where Desktop can start a server for a saved address, and what it runs there. */
interface LaunchTarget {
  runtime: LaunchRuntime;
  /** Null for another machine or an SSH server, which Desktop never starts. */
  port: number | null;
  health: ModelServerHealth;
  product: OpenAICompatibleProduct | null;
  /** Where readOllamaSettings looks for the process. */
  url: string;
}

interface LaunchState {
  /** Read from an Ollama Desktop did not start; null when unreadable. */
  observed: Record<string, string> | null;
  observedAt: number;
  observedVersion: string | null;
  /** The cache type sizing last used, so a change can expire what was sized with the old one. */
  sizedWith: QuantizedKvCacheType | undefined;
}

const UNKNOWN_HEALTH: ModelServerHealth = {
  state: 'unknown',
  version: null,
  latencyMs: null,
  checkedAt: null,
  error: null,
};

/**
 * The saved model servers: one chat client per server keyed by `srv-<id>`, their health, and the
 * add/test/remove flow Settings drives. "This computer" is reported here too but chats through the
 * app's own OllamaLocal, unchanged.
 */
export class ModelServerRegistry {
  private readonly entries = new Map<string, Entry>();
  private localHealth: ModelServerHealth = { ...UNKNOWN_HEALTH };
  private localSpecs: ModelServerSpecs | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private loaded: Promise<void> | null = null;
  private readonly savedListeners = new Set<(id: string) => void>();
  private readonly checking = new WeakMap<Entry, Promise<Listing | undefined>>();
  private lateNoticeAt = 0;
  private readonly supervisor: LocalServerSupervisor;
  private readonly launchStates = new Map<string, LaunchState>();

  constructor(private readonly deps: ModelServerRegistryDeps) {
    this.supervisor = new LocalServerSupervisor({
      launchers: deps.launchers,
      logger: deps.logger,
      changed: id => this.launchChanged(id),
    });
  }

  private get platform(): NodeJS.Platform {
    return this.deps.platform ?? process.platform;
  }

  /** Calls `listener` with a server's id after its saved settings change or it is removed. */
  onServerSaved(listener: (id: string) => void): () => void {
    this.savedListeners.add(listener);
    return () => this.savedListeners.delete(listener);
  }

  /** Loads the saved servers and starts the background recheck. */
  start(): Promise<void> {
    const loaded = this.load();
    void loaded.then(() => this.checkAll());
    this.timer ??= setInterval(() => void this.checkAll(), HEALTH_INTERVAL_MS);
    this.timer.unref?.();
    return loaded;
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async views(): Promise<ModelServerView[]> {
    await this.load();
    const local: ModelServerView = {
      id: LOCAL_SERVER_ID,
      name: LOCAL_SERVER_NAME,
      local: true,
      kind: 'ollama',
      transport: 'http',
      address: LOCAL_OLLAMA_URL,
      access: 'manage',
      auth: { type: 'none' },
      credentialsPersisted: true,
      credentialsMissing: false,
      unencrypted: false,
      health: this.localHealth,
      models: [],
      specs: this.localSpecs,
      launch: this.launchView(LOCAL_SERVER_ID),
    };
    return [local, ...[...this.entries.values()].map(entry => this.view(entry))];
  }

  /** Hardware entered in Settings for a server or this computer; null before the list loads. */
  specs(id: string): ModelServerSpecs | null {
    if (id === LOCAL_SERVER_ID) return this.localSpecs;
    return this.entries.get(id)?.record.specs ?? null;
  }

  /**
   * The OLLAMA_KV_CACHE_TYPE the Ollama at `id` runs with, which fit sizes its cache with; undefined is f16. Known for
   * one Desktop started, and for another on this computer whose settings could be read.
   */
  kvCacheType(id: string): QuantizedKvCacheType | undefined {
    const owned = this.supervisor.owned(id);
    if (owned) return owned.runtime === 'ollama' ? owned.settings.kvCacheType : undefined;
    const observed = this.launchStates.get(id)?.observed;
    return observed && this.ownerOf(id) === 'other' ? observedKvCacheType(observed) : undefined;
  }

  localKvCacheType(): QuantizedKvCacheType | undefined {
    return this.kvCacheType(LOCAL_SERVER_ID);
  }

  /** Starts a server at this server's address on this computer, with its saved launch settings. */
  async startServer(id: string): Promise<ModelServerView[]> {
    await this.load();
    await this.check(id);
    const target = this.launchTarget(id);
    if (!target) throw new Error('That model server is no longer saved.');
    const owner = this.ownerOf(id);
    if (target.port === null || owner === 'remote') throw new Error(launchRefusal(owner, nounOf(target)));
    if (owner === 'desktop') throw new Error(`Desktop already runs this ${nounOf(target)}.`);
    if (owner === 'other') throw new Error(`Something already answers at 127.0.0.1:${target.port}. Stop it first.`);
    const settings = this.launchSettings(id);
    const problem = launchSettingsProblem(settings, target.runtime);
    if (problem) throw new Error(problem);
    await this.supervisor.start(id, { runtime: target.runtime, port: target.port, settings });
    return this.check(id);
  }

  /** Stops the server Desktop runs for `id`; one Desktop did not start is left alone. */
  async stopServer(id: string): Promise<ModelServerView[]> {
    await this.load();
    const owner = this.ownerOf(id);
    if (owner !== 'desktop') {
      const target = this.launchTarget(id);
      throw new Error(target ? launchRefusal(owner, nounOf(target)) : 'That model server is no longer saved.');
    }
    await this.supervisor.stop(id);
    return this.check(id);
  }

  /** Stops and starts the server Desktop runs for `id`, so it picks up the saved launch settings. */
  async restartServer(id: string): Promise<ModelServerView[]> {
    await this.stopServer(id);
    return this.startServer(id);
  }

  /** Every server Desktop started, before quitting. */
  stopLocalServers(): Promise<void> {
    return this.supervisor.stopAll();
  }

  /** Tests an address or SSH destination without saving it. */
  async probe(input: ModelServerProbeInput): Promise<ModelServerProbeResult> {
    if (input.transport === 'ssh') return this.probeSsh(input.address);
    const parsed = parseServerAddress(input.address);
    if (!parsed) {
      return failed(
        parseSshDestination(input.address)?.includes('@')
          ? 'This looks like an SSH destination. Choose SSH above, then test again.'
          : 'Enter an address like https://host, http://192.168.1.5:11434 or host:port.'
      );
    }
    if (isLocalOllama(parsed)) {
      return failed(
        `${new URL(parsed.baseUrl).host} is ${LOCAL_SERVER_NAME}, which is already listed. To reach another machine through an SSH tunnel, forward a different local port, such as 21434.`
      );
    }
    let headers: Record<string, string> | null;
    try {
      headers = credentialHeaders(input.credential);
    } catch (err) {
      return failed(err instanceof Error ? err.message : String(err));
    }
    const scope = await this.scopeOf(parsed.host);
    if (!scope) return failed(`Could not find ${parsed.host}. Check the name, or use its IP address.`);
    const verdict = transportVerdict(parsed.protocol, scope, !!headers);
    if (!verdict.ok) return failed(verdict.reason);
    const label = parsed.host;
    const fetch = this.fetchFor({ origin: parsed.origin, label, credentialHeaders: () => headers });
    const outcome = await probeServer(fetch, parsed.baseUrl, label, this.now);
    const base = {
      address: parsed.baseUrl,
      unencrypted: verdict.unencrypted,
      suggestedName: suggestServerName(parsed),
    };
    if (outcome.auth) {
      return failed(headers ? `${label} refused these credentials.` : `${label} asks for credentials.`, {
        ...base,
        needsCredentials: true,
        kind: outcome.kind,
      });
    }
    if (!outcome.kind) {
      // Some servers answer 403, not 401, when the token is missing.
      const hint = outcome.forbidden && !headers ? ' If this server needs an API key, enter it and test again.' : '';
      // The system code tells a declined macOS Local Network permission (EHOSTUNREACH) apart from a down server.
      if (outcome.code) this.deps.logger.warn(`MODEL SERVERS: testing ${label} (${scope}) failed with ${outcome.code}`);
      const port = launchPort(parsed);
      // A closed port may time out instead of refusing (WSL mirrored networking), so binding it decides.
      const launchable = port !== null && (await (this.deps.portFree ?? loopbackPortFree)(port));
      return failed(
        withLocalNetworkHint(
          `${outcome.error ?? `${label} did not answer as Ollama or an OpenAI-compatible server.`}${hint}`,
          outcome.code,
          scope,
          this.platform
        ),
        { ...base, ...(launchable ? { launchable } : {}) }
      );
    }
    let openToAnyone = false;
    if (scope === 'public') {
      openToAnyone = headers
        ? await answersWithoutCredentials(
            this.fetchFor({ origin: parsed.origin, label, credentialHeaders: () => null }),
            parsed.baseUrl,
            outcome.kind
          )
        : true;
    }
    return {
      ok: true,
      ...base,
      kind: outcome.kind,
      version: outcome.version,
      latencyMs: outcome.latencyMs,
      models: outcome.models,
      needsCredentials: false,
      openToAnyone,
      error: null,
    };
  }

  /** An SSH server is always Ollama on the far end's loopback, so only the connection is in question. */
  private async probeSsh(address: string): Promise<ModelServerProbeResult> {
    const problem = sshDestinationProblem(address);
    if (problem) return failed(problem);
    const destination = address.trim();
    const base = { address: destination, suggestedName: suggestSshName(destination) };
    const fetch = this.sshFetchFor({ destination, label: destination, app: 'Desktop' });
    const outcome = await probeServer(fetch, SSH_OLLAMA_URL, destination, this.now, 'ollama', SSH_PROBE_TIMEOUT_MS);
    if (outcome.kind !== 'ollama') {
      return failed(outcome.error ?? `${destination} did not answer as Ollama at 127.0.0.1:11434.`, base);
    }
    return {
      ok: true,
      ...base,
      kind: 'ollama',
      version: outcome.version,
      latencyMs: outcome.latencyMs,
      models: outcome.models,
      needsCredentials: false,
      unencrypted: false,
      openToAnyone: false,
      error: null,
    };
  }

  async add(input: ModelServerAddInput): Promise<ModelServerView[]> {
    await this.load();
    const probe = await this.probe(input);
    // Nothing answers yet at an address Desktop can start a server on.
    const launching = input.launch === true && probe.launchable === true;
    if ((!probe.ok && !launching) || !probe.address) throw new Error(probe.error ?? 'The server did not answer.');
    if (probe.openToAnyone && !input.acceptOpen) {
      throw new Error('This server answers anyone on the internet. Confirm that before saving it.');
    }
    const ssh = input.transport === 'ssh';
    const record = await this.deps.store.add(
      {
        name: input.name,
        kind: ssh ? 'ollama' : input.kind,
        transport: ssh ? { type: 'ssh', destination: probe.address } : { type: 'http', baseUrl: probe.address },
        access: input.access,
      },
      ssh ? { type: 'none' } : input.credential
    );
    const entry = this.build(record);
    this.entries.set(record.id, entry);
    this.deps.edited?.();
    await this.check(record.id);
    return this.views();
  }

  async update(id: string, input: ModelServerUpdateInput): Promise<ModelServerView[]> {
    await this.load();
    if (input.launch) this.assertLaunchable(id, input.launch, input.kind);
    if (id === LOCAL_SERVER_ID) {
      if (input.specs === undefined && input.launch === undefined)
        throw new Error('This computer has no other settings to change here.');
      if (input.launch) await this.deps.store.setLocalLaunch(input.launch);
      if (input.specs !== undefined) {
        this.localSpecs = await this.deps.store.setLocalSpecs(input.specs);
        this.deps.localSpecsChanged?.();
        this.saved(id);
      }
      this.emit();
      return this.views();
    }
    const entry = this.entries.get(id);
    if (!entry) throw new Error('That model server is no longer saved.');
    if (input.kind && input.kind !== entry.record.kind && (this.supervisor.owned(id) || this.supervisor.busy(id))) {
      throw new Error('Stop the server Desktop started here before changing its kind.');
    }
    if (entry.ssh && input.kind && input.kind !== 'ollama') {
      throw new Error('An SSH server reaches Ollama on that machine, so its kind stays Ollama.');
    }
    if (entry.ssh && input.credential && input.credential.type !== 'none') {
      throw new Error('An SSH server signs in with your SSH keys and takes no token or header.');
    }
    if (input.credential) {
      const hasCredentials = !!credentialHeaders(input.credential);
      entry.scope = (await this.scopeOf(entry.parsed.host)) ?? entry.scope;
      // With no scope (DNS failed), the lookup check at connect time decides.
      if (entry.scope) {
        const verdict = transportVerdict(entry.parsed.protocol, entry.scope, hasCredentials);
        if (!verdict.ok) throw new Error(verdict.reason);
      }
    }
    const record = await this.deps.store.update(id, input);
    this.entries.set(id, this.build(record, entry));
    this.deps.edited?.();
    this.saved(id);
    if (input.credential || input.kind) await this.check(id);
    else this.emit();
    return this.views();
  }

  async remove(id: string): Promise<ModelServerView[]> {
    await this.load();
    await this.deps.store.remove(id);
    await this.supervisor.stop(id).catch(() => undefined);
    this.launchStates.delete(id);
    const entry = this.entries.get(id);
    this.entries.delete(id);
    this.deps.edited?.();
    this.saved(id);
    this.emit();
    if (entry) this.announce(entry, true);
    return this.views();
  }

  /** Rechecks one server, or every server and this computer when `id` is omitted. */
  async check(id?: string): Promise<ModelServerView[]> {
    await this.load();
    if (id === undefined) return this.checkAll();
    if (id === LOCAL_SERVER_ID) await this.checkLocal();
    else {
      const entry = this.entries.get(id);
      if (entry) await this.checkEntry(entry);
    }
    this.emit();
    return this.views();
  }

  /** Every saved server's chat models. A server that does not answer, or not in time, lists its last models, disabled. */
  async models(options: ModelListOptions = {}): Promise<ChatModelOption[]> {
    await this.load();
    const lists = await Promise.all([...this.entries.values()].map(entry => this.entryModels(entry, options)));
    return lists.flat();
  }

  /** One server's chat models. A server saved again during the waits lists as saved; a removed one lists nothing. */
  private async entryModels(
    entry: Entry,
    options: ModelListOptions,
    // One budget for the check wait and the listing wait together, kept across a re-save during the wait.
    deadline = Date.now() + PICKER_LIST_WAIT_MS
  ): Promise<ChatModelOption[]> {
    const server = { id: entry.record.id, name: entry.record.name };
    // Asking without the credential would get a 401 that replaces this message with a vaguer one.
    const missing = this.deps.store.credentialMissing(entry.record) ? this.missingCredentialHealth() : null;
    if (missing && (entry.health.state !== missing.state || entry.health.error !== missing.error)) {
      this.setHealth(entry, missing);
      this.emit();
    }
    // A server shown as down may be back: a check already running (say, after a pull) decides, or a
    // picker refresh starts one when the last is stale. A server not checked yet is listed directly.
    const turn = options.untilListed === entry.record.id;
    const down = entry.health.state !== 'online' && entry.health.state !== 'unknown';
    const running = this.checking.get(entry);
    let checked: Listing | undefined;
    if (down && (running || this.stale(entry))) {
      const check = (
        running ??
        this.checkEntry(entry).then(listing => {
          this.emit();
          return listing;
        })
      ).catch(() => undefined);
      // A turn waits for the check like it waits for the listing; Stop still ends it.
      checked = turn ? await check : await within(check, PICKER_CHECK_WAIT_MS, undefined);
    }
    if (!this.current(entry)) return this.savedModels(entry, options, deadline);
    let reason: string | null = null;
    if (listable(entry)) {
      const fresh = this.freshKept(entry);
      const known: Listing | undefined = fresh ? { ok: true, models: fresh } : checked?.ok ? checked : undefined;
      let slot = known ? null : this.listEntry(entry);
      // undefined: still listing when the wait ran out, or already reported as still listing.
      let result: Listing | undefined = known;
      if (slot) slot.picker = true;
      const wait = (listing: Slot) =>
        turn ? listing.promise : within(listing.promise, Math.max(deadline - Date.now(), 0), undefined);
      if (slot && (turn || !slot.reported)) {
        result = await wait(slot);
        // A pull or removal during the wait dropped that listing, so the one started after it decides. The
        // picker keeps a dropped listing that succeeded, but a failed one says nothing about the server.
        while (result && slot.seq < entry.floor && (turn || !result.ok) && this.current(entry)) {
          slot = this.listEntry(entry);
          slot.picker = true;
          result = await wait(slot);
        }
      }
      if (!this.current(entry)) return this.savedModels(entry, options, deadline);
      if (result?.ok) {
        if (entry.health.state === 'unknown') void this.check(entry.record.id);
        return result.models.map(model => ({ ...model, server }));
      }
      // A check that found the server down during the wait decides the label.
      if (result === undefined && listable(entry)) {
        if (slot) slot.reported = true;
        reason = `${entry.record.name} is still listing its models`;
      }
    }
    const pending = reason !== null;
    reason ??= unavailableReason(entry);
    const wantsCredentials = entry.health.state === 'credentials' && !pending;
    const rejected = wantsCredentials && !!this.deps.store.headers(entry.record);
    const runtimeId = serverRuntimeId(entry.record.id);
    return entry.record.models.map(name => {
      const aliasIds = entry.aliasIds?.get(name);
      return {
        id: localModelId(runtimeId, name),
        name,
        backend: localBackend(runtimeId),
        server,
        ...(aliasIds ? { aliasIds } : {}),
        unavailable: reason,
        ...(pending ? { pending: true } : {}),
        ...(wantsCredentials ? { wantsCredentials: rejected ? ('rejected' as const) : ('missing' as const) } : {}),
      };
    });
  }

  private savedModels(replaced: Entry, options: ModelListOptions, deadline: number): Promise<ChatModelOption[]> {
    const saved = this.entries.get(replaced.record.id);
    return saved ? this.entryModels(saved, options, deadline) : Promise.resolve([]);
  }

  /** A pull or removal changed what the server holds, so its last listing is no longer served. */
  private forget(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.kept = undefined;
    entry.slot = undefined;
    entry.floor = entry.listSeq + 1;
  }

  /** Rows listed before a server's tool support changed, or a model first thought, carry the old values. */
  private toolsChanged(id: string): void {
    const entry = this.entries.get(id);
    if (entry) entry.kept = undefined;
    this.deps.edited?.();
    this.emit();
  }

  /** False once update() or remove() replaced this entry; its late results then change nothing. */
  private current(entry: Entry): boolean {
    return this.entries.get(entry.record.id) === entry;
  }

  private freshKept(entry: Entry): ChatModelOption[] | null {
    const kept = entry.kept;
    if (!kept) return null;
    return Date.now() - Math.max(kept.at, this.lateNoticeAt) < LISTED_FRESH_MS ? kept.models : null;
  }

  /** One listing per server at a time, shared by the picker and health checks; its promise never rejects. */
  private listEntry(entry: Entry): Slot {
    if (entry.slot) return entry.slot;
    const slot = { seq: ++entry.listSeq, reported: false, picker: false } as Slot;
    slot.promise = entry.client
      .listModels()
      .then(
        (models): Listing => ({ ok: true, models }),
        (error: unknown): Listing => ({ ok: false, error })
      )
      .then(result => this.settle(entry, slot, result));
    entry.slot = slot;
    return slot;
  }

  /** Applies a finished listing once, whoever waits on it, and announces it when a caller was given pending rows. */
  private async settle(entry: Entry, slot: Slot, result: Listing): Promise<Listing> {
    try {
      if (!this.current(entry)) {
        // Saved again after a caller was shown this listing as pending: the picker lists the saved server again.
        const saved = this.entries.get(entry.record.id);
        if (saved && slot.reported) this.announce(saved, true);
        return { ok: false, error: new Error(`${entry.record.name} was changed.`) };
      }
      if (slot.seq < entry.floor) {
        // A pull or removal that failed reloads nothing, so a picker shown this listing as pending must be told.
        if (slot.reported) this.announce(entry, true);
        return result;
      }
      if (result.ok) {
        const names = result.models.map(model => model.name);
        entry.record = { ...entry.record, models: names };
        entry.aliasIds = aliasIdsOf(result.models);
        // Only a listing a caller was told is pending is kept; any other result makes an older kept list stale.
        entry.kept = slot.reported ? { models: result.models, at: Date.now() } : undefined;
      } else {
        entry.kept = undefined;
        if (slot.picker) this.listingFailed(entry, result.error);
      }
      if (slot.reported) this.announce(entry, result.ok);
      if (result.ok) await this.deps.store.setModels(entry.record.id, entry.record.models).catch(() => undefined);
      return result;
    } finally {
      if (entry.slot === slot) entry.slot = undefined;
    }
  }

  private announce(entry: Entry, ok: boolean): void {
    try {
      // Settings and the Models screen show the new health; the picker reloads on listedLate.
      if (!ok) this.emit();
      this.lateNoticeAt = Date.now();
      this.deps.listedLate?.(entry.record.id);
    } catch (err) {
      this.deps.logger.warn(`MODEL SERVERS: reporting a late listing failed: ${String(err)}`);
    }
  }

  private listingFailed(entry: Entry, raw: unknown): void {
    const err = this.unwrapFailure(raw, entry);
    entry.health = failureHealth(err, entry.record.name, entry.scope, this.platform) ?? {
      ...entry.health,
      state: 'unreachable',
      checkedAt: new Date().toISOString(),
      error: withLocalNetworkHint(
        `${entry.record.name}: ${describeFailure(err)}`,
        errorCode(err),
        entry.scope,
        this.platform
      ),
    };
  }

  /** The chat client for a `srv-<id>` runtime id; null for any other id. */
  chatFor(runtimeId: string): LocalChat | null {
    const id = serverIdOfRuntime(runtimeId);
    if (id === null) return null;
    return {
      stream: (request, onEvent, signal, onTrimmed, onNotice) =>
        this.run(id, signal, entry => entry.client.stream(request, onEvent, signal, onTrimmed, onNotice)),
      contextTokens: (modelId, signal) => this.run(id, signal, entry => entry.client.contextTokens(modelId, signal)),
      growFor: (modelId, tokens) => this.run(id, undefined, entry => entry.client.growFor(modelId, tokens)),
      // For the Models screen's dialog only, so a failure here says nothing about the server's health.
      loadOffer: async (modelId, draftTokens) => {
        await this.load();
        return (await this.entries.get(id)?.client.loadOffer?.(modelId, draftTokens)) ?? {};
      },
    };
  }

  /**
   * The Models screen's handle on a saved server, null when none is saved under `id`. Health is this
   * registry's check, and failures update the server's health and name it, as chat's do.
   */
  hubServer(id: string): ModelHubServer | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    const { record } = entry;
    return {
      name: record.name,
      management: serverManagement({ local: false, kind: record.kind, access: record.access }),
      runtime: {
        baseUrl: entry.ssh ? `ssh://${entry.ssh}` : entry.parsed.baseUrl,
        health: async () => {
          const health = (await this.check(id)).find(server => server.id === id)?.health;
          return health?.state === 'online'
            ? { ok: true, version: health.version, error: null }
            : { ok: false, version: null, error: health?.error ?? `${record.name} did not answer.` };
        },
        list: () => this.run(id, undefined, current => current.runtime.list()),
        loaded: () => this.run(id, undefined, current => current.runtime.loaded()),
        inspect: (model, options) => this.run(id, options?.signal, current => current.runtime.inspect(model, options)),
        pull: (ref, options) =>
          this.run(id, options?.signal, current => current.runtime.pull(ref, options)).finally(() => this.forget(id)),
        remove: model =>
          this.run(id, undefined, current => current.runtime.remove(model)).finally(() => this.forget(id)),
      },
    };
  }

  private async run<T>(id: string, signal: AbortSignal | undefined, task: (entry: Entry) => Promise<T>): Promise<T> {
    await this.load();
    const entry = this.entries.get(id);
    if (!entry) throw new Error("This conversation's model server was removed. Pick another model.");
    if (this.deps.store.credentialMissing(entry.record)) {
      throw new ServerCredentialsError(entry.record.name, false);
    }
    try {
      const result = await task(entry);
      if (entry.health.state !== 'online') void this.check(id);
      return result;
    } catch (raw) {
      if (signal?.aborted) throw raw;
      const err = this.unwrapFailure(raw, entry);
      // A stalled pull says nothing about chat, so the server's health is left as it was.
      if (err instanceof PullIdleTimeoutError)
        throw new ServerUnreachableError(entry.record.name, describeFailure(err), { cause: err });
      const health = failureHealth(err, entry.record.name, entry.scope, this.platform);
      if (!health) throw raw;
      entry.health = health;
      this.emit();
      if (health.state === 'unreachable') {
        const reason = withLocalNetworkHint(describeFailure(err), errorCode(err), entry.scope, this.platform);
        throw new ServerUnreachableError(entry.record.name, reason, { cause: err });
      }
      throw err;
    }
  }

  /** The runtime's 401 as a credentials error, its 403 as a refusal, and the cause of a connection error it wrapped. */
  private unwrapFailure(err: unknown, entry: Entry): unknown {
    const inner = err instanceof RuntimeConnectionError && err.cause !== undefined ? err.cause : err;
    if (inner instanceof RuntimeHttpError && inner.status === 401) {
      return new ServerCredentialsError(entry.record.name, !!this.deps.store.headers(entry.record));
    }
    if (inner instanceof RuntimeHttpError && inner.status === 403) return new ServerForbiddenError(entry.record.name);
    return inner;
  }

  private async checkAll(): Promise<ModelServerView[]> {
    await Promise.all([this.checkLocal(), ...[...this.entries.values()].map(entry => this.checkEntry(entry))]);
    this.emit();
    return this.views();
  }

  private async checkLocal(): Promise<void> {
    const fetch = this.deps.localFetch ?? globalThis.fetch;
    const started = this.now();
    try {
      const response = await fetch(`${LOCAL_OLLAMA_URL}/api/version`, {
        signal: AbortSignal.timeout(LOCAL_TIMEOUT_MS),
      });
      const body = (await response.json().catch(() => null)) as { version?: unknown } | null;
      this.localHealth = {
        state: response.ok ? 'online' : 'unreachable',
        version: typeof body?.version === 'string' ? body.version : null,
        latencyMs: Math.round(this.now() - started),
        checkedAt: new Date().toISOString(),
        error: response.ok ? null : `Ollama returned HTTP ${response.status}`,
      };
    } catch {
      this.localHealth = {
        state: 'unreachable',
        version: null,
        latencyMs: null,
        checkedAt: new Date().toISOString(),
        error: 'Ollama is not running on this computer.',
      };
    }
    await this.observe(LOCAL_SERVER_ID);
  }

  /** One check per server at a time; callers during a check share its result: the listing it made, if it made one. */
  private checkEntry(entry: Entry): Promise<Listing | undefined> {
    const running = this.checking.get(entry);
    if (running) return running;
    const done = this.probeEntry(entry)
      .then(async listing => {
        if (this.current(entry)) await this.observe(entry.record.id);
        return listing;
      })
      .finally(() => this.checking.delete(entry));
    this.checking.set(entry, done);
    return done;
  }

  /** Who runs the server at `id`'s address. */
  private ownerOf(id: string): LaunchOwner {
    const target = this.launchTarget(id);
    if (!target || target.port === null) return 'remote';
    if (this.supervisor.owned(id) || this.supervisor.busy(id)) return 'desktop';
    const { state } = target.health;
    return state === 'online' || state === 'credentials' || state === 'refused' ? 'other' : 'none';
  }

  private launchTarget(id: string): LaunchTarget | null {
    if (id === LOCAL_SERVER_ID) {
      return {
        runtime: 'ollama',
        port: Number(LOCAL_OLLAMA_PORT),
        health: this.localHealth,
        product: null,
        url: LOCAL_OLLAMA_URL,
      };
    }
    const entry = this.entries.get(id);
    if (!entry) return null;
    return {
      runtime: entry.record.kind === 'ollama' ? 'ollama' : 'llama-server',
      port: entry.ssh ? null : launchPort(entry.parsed),
      health: entry.health,
      product: entry.product,
      url: entry.parsed.baseUrl,
    };
  }

  private launchSettings(id: string): ModelServerLaunchSettings {
    return id === LOCAL_SERVER_ID ? this.deps.store.localLaunch() : this.deps.store.launchSettings(id);
  }

  private launchView(id: string): ModelServerLaunchView | null {
    const target = this.launchTarget(id);
    if (!target) return null;
    const owner = this.ownerOf(id);
    const settings = this.launchSettings(id);
    const owned = this.supervisor.owned(id);
    const busy = this.supervisor.busy(id);
    const settingsProblem = launchSettingsProblem(settings, target.runtime);
    return {
      runtime: target.runtime,
      owner,
      busy,
      settings,
      pendingRestart: !!owned && !sameLaunch(owned.settings, settings),
      canStart: owner === 'none' && target.health.state === 'unreachable' && !settingsProblem,
      problem: owner === 'remote' ? null : (this.supervisor.problem(id) ?? settingsProblem),
      observed: owner === 'other' ? (this.launchStates.get(id)?.observed ?? null) : null,
      sizingKvCacheType: this.kvCacheType(id) ?? 'f16',
      noun: nounOf(target),
    };
  }

  /** Refuses launch settings Desktop would not apply: for a server it did not start, or that the server cannot take. */
  private assertLaunchable(id: string, settings: ModelServerLaunchSettings, kind?: ModelServerView['kind']): void {
    const target = this.launchTarget(id);
    if (!target) throw new Error('That model server is no longer saved.');
    const owner = this.ownerOf(id);
    if (owner === 'remote' || owner === 'other') throw new Error(launchRefusal(owner, nounOf(target)));
    const runtime = kind ? (kind === 'ollama' ? 'ollama' : 'llama-server') : target.runtime;
    const problem = launchSettingsProblem(settings, runtime);
    if (problem) throw new Error(problem);
  }

  /**
   * Reads the launch variables of an Ollama on this computer that Desktop did not start: when it starts answering, when
   * its version changes, and at most every OBSERVE_TTL_MS otherwise, since a read scans processes and systemd units.
   * Expires what was sized with the old cache type when that changes.
   */
  private async observe(id: string): Promise<void> {
    const target = this.launchTarget(id);
    if (!target) return;
    const state = this.launchState(id);
    if (target.runtime !== 'ollama' || this.ownerOf(id) !== 'other') {
      state.observed = null;
      state.observedAt = 0;
    } else if (
      state.observedAt === 0 ||
      state.observedVersion !== target.health.version ||
      Date.now() - state.observedAt >= OBSERVE_TTL_MS
    ) {
      const env = (await this.deps.readOllamaEnv?.(target.url).catch(() => null)) ?? null;
      state.observed = env ? observedLaunchVars(env) : null;
      state.observedAt = Date.now();
      state.observedVersion = target.health.version;
    }
    this.sizingChanged(id);
  }

  private launchState(id: string): LaunchState {
    let state = this.launchStates.get(id);
    if (!state) {
      state = { observed: null, observedAt: 0, observedVersion: null, sizedWith: undefined };
      this.launchStates.set(id, state);
    }
    return state;
  }

  private sizingChanged(id: string): void {
    const state = this.launchState(id);
    const kv = this.kvCacheType(id);
    if (kv === state.sizedWith) return;
    state.sizedWith = kv;
    if (id === LOCAL_SERVER_ID) this.deps.localSpecsChanged?.();
    else this.deps.edited?.();
    this.saved(id);
  }

  /** A server Desktop runs started, stopped or exited. */
  private launchChanged(id: string): void {
    this.sizingChanged(id);
    if (this.supervisor.busy(id)) this.emit();
    else void this.check(id).catch(() => undefined);
  }

  private async probeEntry(entry: Entry): Promise<Listing | undefined> {
    entry.scope = (await this.scopeOf(entry.parsed.host)) ?? entry.scope;
    if (this.deps.store.credentialMissing(entry.record)) {
      this.setHealth(entry, this.missingCredentialHealth());
      return undefined;
    }
    const outcome = await probeServer(
      entry.fetch,
      entry.parsed.baseUrl,
      entry.record.name,
      this.now,
      entry.record.kind,
      entry.ssh ? SSH_PROBE_TIMEOUT_MS : undefined
    );
    const checkedAt = new Date().toISOString();
    if (outcome.auth) {
      this.setHealth(entry, {
        state: 'credentials',
        version: null,
        latencyMs: outcome.latencyMs,
        checkedAt,
        error: new ServerCredentialsError(entry.record.name, !!this.deps.store.headers(entry.record)).message,
      });
      return undefined;
    }
    if (!outcome.kind) {
      if (outcome.code) {
        this.deps.logger.debug(
          `MODEL SERVERS: checking ${entry.record.name} (${entry.scope}) failed with ${outcome.code}`
        );
      }
      this.setHealth(entry, {
        state: outcome.refused ? 'refused' : 'unreachable',
        version: null,
        latencyMs: null,
        checkedAt,
        error: outcome.error && withLocalNetworkHint(outcome.error, outcome.code, entry.scope, this.platform),
      });
      return undefined;
    }
    if (outcome.product && outcome.product !== entry.product) {
      entry.product = outcome.product;
      // The chat client reads the product once, so rebuild it to start using what the probe learned.
      const rebuilt = this.build(entry.record, entry);
      entry.client = rebuilt.client;
      entry.runtime = rebuilt.runtime;
    }
    this.setHealth(entry, {
      state: 'online',
      version: outcome.version,
      latencyMs: outcome.latencyMs,
      checkedAt,
      error: null,
    });
    // A fresh kept listing is what the picker serves; listing again would take its rows back to pending.
    const slot = this.freshKept(entry) ? null : this.listEntry(entry);
    const listing = slot ? await slot.promise : null;
    if (listing && !listing.ok) {
      const err = listing.error;
      this.deps.logger.debug(
        `MODEL SERVERS: listing ${entry.record.id} failed: ${err instanceof Error ? err.name : 'unknown'}`
      );
    }
    // Each check is how tools come back after the server restarts with tool calling on. Not awaited: the probe
    // generates a token, and a change reaches Settings and the picker through toolsChanged.
    void entry.client.recheckTools?.(entry.record.models[0]);
    // A picker read that waited on this check serves its listing; one a pull or removal dropped is not served.
    return slot && listing?.ok && slot.seq >= entry.floor ? listing : undefined;
  }

  private missingCredentialHealth(): ModelServerHealth {
    return {
      state: 'credentials',
      version: null,
      latencyMs: null,
      checkedAt: new Date().toISOString(),
      error: this.deps.store.credentialPersisted()
        ? 'The saved credential could not be read. Enter it again.'
        : 'The credential was kept only until Desktop quit. Enter it again.',
    };
  }

  private stale(entry: Entry): boolean {
    const checked = entry.health.checkedAt ? Date.parse(entry.health.checkedAt) : 0;
    return Date.now() - checked >= RECHECK_AFTER_MS;
  }

  private setHealth(entry: Entry, health: ModelServerHealth): void {
    entry.health = health;
  }

  private build(record: ModelServerRecord, previous?: Entry): Entry {
    const ssh = record.transport.type === 'ssh' ? record.transport.destination : null;
    const parsed = parseServerAddress(
      record.transport.type === 'ssh' ? SSH_OLLAMA_URL : record.transport.baseUrl
    ) as ParsedAddress;
    const fetch = ssh
      ? this.sshFetchFor({ destination: ssh, label: record.name, app: 'Desktop' })
      : this.fetchFor({
          origin: parsed.origin,
          label: record.name,
          app: 'Desktop',
          credentialHeaders: () => this.supervisor.headers(record.id) ?? this.deps.store.headers(record),
        });
    const runtimeId = serverRuntimeId(record.id);
    const hasCredentials = () => !!this.deps.store.headers(record);
    const product = previous?.record.kind === record.kind ? previous.product : null;
    const client: ServerClient =
      record.kind === 'ollama'
        ? new OllamaLocal(
            undefined,
            undefined,
            {
              runtimeId,
              baseUrl: parsed.baseUrl,
              label: record.name,
              fetch,
              hasCredentials,
              redact: redactServerResponse,
              kvCacheType: () => this.kvCacheType(record.id),
            },
            this.deps.loadSettings
          )
        : new OpenAICompatibleChat({
            runtimeId,
            baseUrl: parsed.baseUrl,
            label: record.name,
            product,
            fetch,
            hasCredentials,
            redact: redactServerResponse,
            loadSettings: this.deps.loadSettings,
            toolsChanged: () => this.toolsChanged(record.id),
            learnedThinkers: {
              read: () => this.deps.store.thinkers(record.id),
              add: (model, identity) => this.deps.store.addThinker(record.id, model, identity),
              forget: model => this.deps.store.forgetThinker(record.id, model),
            },
          });
    const runtime: LocalRuntime =
      record.kind === 'ollama'
        ? new OllamaRuntime({ baseUrl: parsed.baseUrl, id: runtimeId, fetch, redact: redactServerResponse })
        : new OpenAICompatibleRuntime({ baseUrl: parsed.baseUrl, id: runtimeId, fetch, product });
    return {
      record,
      parsed,
      ssh,
      scope: previous?.scope ?? (isIP(parsed.host) ? scopeOfIp(parsed.host) : null),
      fetch,
      client,
      runtime,
      health: previous && previous.record.kind === record.kind ? previous.health : { ...UNKNOWN_HEALTH },
      product,
      ...(previous?.aliasIds ? { aliasIds: previous.aliasIds } : {}),
      listSeq: 0,
      floor: 0,
    };
  }

  private view(entry: Entry): ModelServerView {
    const { record } = entry;
    const toolsHint = entry.client.toolsHint?.();
    return {
      ...(toolsHint ? { toolsHint } : {}),
      id: record.id,
      name: record.name,
      local: false,
      kind: record.kind,
      transport: record.transport.type,
      address: entry.ssh ?? entry.parsed.baseUrl,
      access: record.access,
      auth:
        record.auth.type === 'header' ? { type: 'header', headerName: record.auth.name } : { type: record.auth.type },
      credentialsPersisted: record.auth.type === 'none' || this.deps.store.credentialPersisted(),
      credentialsMissing: this.deps.store.credentialMissing(record),
      unencrypted: entry.parsed.protocol === 'http:' && entry.scope === 'private',
      health: entry.health,
      models: record.models,
      specs: record.specs,
      launch: this.launchView(record.id),
    };
  }

  private load(): Promise<void> {
    this.loaded ??= Promise.all([this.deps.store.list(), this.deps.store.localSpecs()]).then(([records, specs]) => {
      for (const record of records) {
        if (record.transport.type === 'ssh' || parseServerAddress(record.transport.baseUrl)) {
          this.entries.set(record.id, this.build(record));
        }
      }
      this.localSpecs = specs;
      if (specs) this.deps.localSpecsChanged?.();
    });
    return this.loaded;
  }

  private saved(id: string): void {
    for (const listener of this.savedListeners) listener(id);
  }

  private emit(): void {
    if (!this.deps.changed) return;
    void this.views().then(servers => this.deps.changed?.(servers));
  }

  private fetchFor(endpoint: ServerEndpoint): FetchLike {
    return (this.deps.fetchFor ?? createServerFetch)(endpoint);
  }

  private sshFetchFor(endpoint: SshEndpoint): FetchLike {
    return this.deps.sshFetchFor ? this.deps.sshFetchFor(endpoint) : createSshFetch(endpoint);
  }

  private readonly now = () => (this.deps.now ?? performance.now.bind(performance))();

  private async scopeOf(host: string): Promise<AddressScope | null> {
    const literal = scopeOfIp(host);
    if (literal) return literal;
    try {
      const addresses = await within((this.deps.resolve ?? resolveAll)(host), RESOLVE_TIMEOUT_MS, null);
      if (!addresses || addresses.length === 0) return null;
      return leastTrusted(addresses.map(address => scopeOfIp(address) ?? 'public'));
    } catch {
      return null;
    }
  }
}

const LOCAL_OLLAMA_PORT = new URL(LOCAL_OLLAMA_URL).port;
const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0', '::', '::ffff:7f00:1']);

/** The hosts a server Desktop starts answers on: it binds 127.0.0.1 only. */
const LAUNCH_HOSTS = new Set(['127.0.0.1', 'localhost']);

/** The port Desktop would start a server on for this address; null when it is not plain http on this computer. */
function launchPort(parsed: ParsedAddress): number | null {
  const url = new URL(parsed.baseUrl);
  if (url.protocol !== 'http:' || !LAUNCH_HOSTS.has(url.hostname.toLowerCase()) || !url.port) return null;
  return ['', '/', '/v1', '/v1/'].includes(url.pathname) ? Number(url.port) : null;
}

const PRODUCT_NOUNS: Record<OpenAICompatibleProduct, string> = {
  'llama-server': 'llama-server',
  lmstudio: 'LM Studio server',
  vllm: 'vLLM server',
};

function nounOf(target: Pick<LaunchTarget, 'runtime' | 'product'>): string {
  if (target.runtime === 'ollama') return 'Ollama server';
  return target.product ? PRODUCT_NOUNS[target.product] : 'server';
}

function launchRefusal(owner: LaunchOwner, noun: string): string {
  return launchLockedMessage({ owner, noun }) ?? `Desktop is not running this ${noun}.`;
}

/** The port "This computer" already uses: saving it again would list the same Ollama twice. */
function isLocalOllama(parsed: ParsedAddress): boolean {
  return (
    LOOPBACK_NAMES.has(parsed.host.toLowerCase().replace(/\.$/, '')) &&
    new URL(parsed.origin).port === LOCAL_OLLAMA_PORT
  );
}

function failed(error: string, extra: Partial<ModelServerProbeResult> = {}): ModelServerProbeResult {
  return {
    ok: false,
    address: null,
    kind: null,
    version: null,
    latencyMs: null,
    models: null,
    needsCredentials: false,
    unencrypted: false,
    openToAnyone: false,
    suggestedName: null,
    error,
    ...extra,
  };
}

async function resolveAll(host: string): Promise<string[]> {
  const addresses = await dns.promises.lookup(host, { all: true });
  return addresses.map(entry => entry.address);
}

/** `work`'s result, or `late` once `ms` pass without one. */
function within<T, L>(work: Promise<T>, ms: number, late: L): Promise<T | L> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<L>(resolve => (timer = setTimeout(() => resolve(late), ms)));
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

function aliasIdsOf(listed: readonly ChatModelOption[]): Map<string, string[]> {
  return new Map(
    listed.flatMap((model): [string, string[]][] => (model.aliasIds?.length ? [[model.name, model.aliasIds]] : []))
  );
}

function listable(entry: Entry): boolean {
  return entry.health.state === 'online' || entry.health.state === 'unknown';
}

function unavailableReason(entry: Entry): string {
  if (entry.health.state === 'credentials') return `${entry.record.name} needs new credentials`;
  if (entry.health.state === 'refused')
    return entry.health.error
      ? `${entry.record.name} was refused: ${entry.health.error}`
      : `${entry.record.name} was refused`;
  return `${entry.record.name} is unreachable`;
}

/** The health a failed request implies; null when the failure says nothing about the server (a model error). */
function failureHealth(
  err: unknown,
  label: string,
  scope: AddressScope | null,
  platform: NodeJS.Platform
): ModelServerHealth | null {
  const checkedAt = new Date().toISOString();
  if (err instanceof ServerCredentialsError) {
    return { state: 'credentials', version: null, latencyMs: null, checkedAt, error: err.message };
  }
  if (
    err instanceof ServerTransportError ||
    err instanceof ServerRedirectError ||
    err instanceof ServerForbiddenError
  ) {
    return { state: 'refused', version: null, latencyMs: null, checkedAt, error: err.message };
  }
  const connection =
    err instanceof TypeError ||
    (err instanceof Error && err.name === 'TimeoutError') ||
    (err instanceof Error && err.cause instanceof TypeError) ||
    DROP_CODES.has(errorCode(err) ?? '') ||
    (err instanceof Error && /ended (the reply )?before|stream ended/i.test(err.message));
  if (!connection) return null;
  return {
    state: 'unreachable',
    version: null,
    latencyMs: null,
    checkedAt,
    error: withLocalNetworkHint(`${label}: ${describeFailure(err)}`, errorCode(err), scope, platform),
  };
}
