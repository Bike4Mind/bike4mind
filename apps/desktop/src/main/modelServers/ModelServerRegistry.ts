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
  type OpenAICompatibleProduct,
} from '@bike4mind/local-models';
import {
  answersWithoutCredentials,
  createServerFetch,
  describeFailure,
  DROP_CODES,
  errorCode,
  leastTrusted,
  parseServerAddress,
  probeServer,
  redactServerResponse,
  scopeOfIp,
  ServerRedirectError,
  ServerTransportError,
  suggestServerName,
  transportVerdict,
  type AddressScope,
  type ParsedAddress,
  type ServerEndpoint,
} from '@bike4mind/local-models/servers';
import { localBackend, localModelId, type ChatModelOption } from '@shared/chat';
import {
  LOCAL_SERVER_ID,
  LOCAL_SERVER_NAME,
  serverIdOfRuntime,
  serverManagement,
  serverRuntimeId,
  type ModelServerAddInput,
  type ModelServerHealth,
  type ModelServerProbeInput,
  type ModelServerProbeResult,
  type ModelServerSpecs,
  type ModelServerUpdateInput,
  type ModelServerView,
} from '@shared/modelServers';
import type { LocalChat } from '../chat/localChat';
import { OllamaLocal } from '../chat/OllamaLocal';
import type { ModelHubServer } from '../models/ModelHubService';
import { ServerCredentialsError, ServerForbiddenError, ServerUnreachableError } from './errors';
import { credentialHeaders, type ModelServerRecord, type ModelServerStore } from './ModelServerStore';
import { OpenAICompatibleChat } from './OpenAICompatibleChat';

export const LOCAL_OLLAMA_URL = 'http://127.0.0.1:11434';
const LOCAL_TIMEOUT_MS = 1_500;
/** Background recheck while the app runs. */
export const HEALTH_INTERVAL_MS = 60_000;
const RECHECK_AFTER_MS = 10_000;
/** `dns.lookup` has no timeout of its own and can hang on a slow resolver. */
const RESOLVE_TIMEOUT_MS = 5_000;
/** How long a picker load waits on a down server's check before listing its last models. */
export const PICKER_CHECK_WAIT_MS = 2_000;

interface ServerClient extends LocalChat {
  listModels(): Promise<ChatModelOption[]>;
  toolsHint?(): string | null;
  recheckTools?(model: string | undefined): Promise<void>;
}

interface Entry {
  record: ModelServerRecord;
  parsed: ParsedAddress;
  scope: AddressScope | null;
  fetch: FetchLike;
  client: ServerClient;
  /** What the Models screen lists, pulls and removes through, over the same fetch as chat. */
  runtime: LocalRuntime;
  health: ModelServerHealth;
  product: OpenAICompatibleProduct | null;
  /** From the last listing, so a conversation saved on an alias still finds its model while the server is down. */
  aliasIds?: ReadonlyMap<string, string[]>;
}

export interface ModelServerRegistryDeps {
  store: ModelServerStore;
  logger: { debug(message: string): void; warn(message: string): void };
  /** Called with the full list whenever a server or its health changes. */
  changed?(servers: ModelServerView[]): void;
  /** Resolves a host name to its addresses; defaults to `dns.lookup` with `all: true`. */
  resolve?(host: string): Promise<string[]>;
  fetchFor?(endpoint: ServerEndpoint): FetchLike;
  /** For "This computer"; defaults to the global fetch. */
  localFetch?: FetchLike;
  now?(): number;
  /** This computer's entered hardware was loaded or changed, so whatever was sized from its probe is stale. */
  localSpecsChanged?(): void;
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
  private readonly checking = new WeakMap<Entry, Promise<void>>();

  constructor(private readonly deps: ModelServerRegistryDeps) {}

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
      address: LOCAL_OLLAMA_URL,
      access: 'manage',
      auth: { type: 'none' },
      credentialsPersisted: true,
      credentialsMissing: false,
      unencrypted: false,
      health: this.localHealth,
      models: [],
      specs: this.localSpecs,
    };
    return [local, ...[...this.entries.values()].map(entry => this.view(entry))];
  }

  /** Hardware entered in Settings for a server or this computer; null before the list loads. */
  specs(id: string): ModelServerSpecs | null {
    if (id === LOCAL_SERVER_ID) return this.localSpecs;
    return this.entries.get(id)?.record.specs ?? null;
  }

  /** Tests an address without saving it. */
  async probe(input: ModelServerProbeInput): Promise<ModelServerProbeResult> {
    const failed = (error: string, extra: Partial<ModelServerProbeResult> = {}): ModelServerProbeResult => ({
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
    });
    const parsed = parseServerAddress(input.address);
    if (!parsed) return failed('Enter an address like https://host, http://192.168.1.5:11434 or host:port.');
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
      return failed(
        `${outcome.error ?? `${label} did not answer as Ollama or an OpenAI-compatible server.`}${hint}`,
        base
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

  async add(input: ModelServerAddInput): Promise<ModelServerView[]> {
    await this.load();
    const probe = await this.probe(input);
    if (!probe.ok || !probe.address) throw new Error(probe.error ?? 'The server did not answer.');
    if (probe.openToAnyone && !input.acceptOpen) {
      throw new Error('This server answers anyone on the internet. Confirm that before saving it.');
    }
    const record = await this.deps.store.add(
      { name: input.name, kind: input.kind, transport: { type: 'http', baseUrl: probe.address }, access: input.access },
      input.credential
    );
    const entry = this.build(record);
    this.entries.set(record.id, entry);
    await this.check(record.id);
    return this.views();
  }

  async update(id: string, input: ModelServerUpdateInput): Promise<ModelServerView[]> {
    await this.load();
    if (id === LOCAL_SERVER_ID) {
      if (input.specs === undefined) throw new Error('This computer has no other settings to change here.');
      this.localSpecs = await this.deps.store.setLocalSpecs(input.specs);
      this.deps.localSpecsChanged?.();
      this.saved(id);
      this.emit();
      return this.views();
    }
    const entry = this.entries.get(id);
    if (!entry) throw new Error('That model server is no longer saved.');
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
    this.saved(id);
    if (input.credential || input.kind) await this.check(id);
    else this.emit();
    return this.views();
  }

  async remove(id: string): Promise<ModelServerView[]> {
    await this.load();
    await this.deps.store.remove(id);
    this.entries.delete(id);
    this.saved(id);
    this.emit();
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

  /** Every saved server's chat models. A server that does not answer lists its last models, disabled. */
  async models(): Promise<ChatModelOption[]> {
    await this.load();
    const lists = await Promise.all(
      [...this.entries.values()].map(async entry => {
        const server = { id: entry.record.id, name: entry.record.name };
        // Asking without the credential would get a 401 that replaces this message with a vaguer one.
        const missing = this.deps.store.credentialMissing(entry.record) ? this.missingCredentialHealth() : null;
        if (missing && (entry.health.state !== missing.state || entry.health.error !== missing.error)) {
          this.setHealth(entry, missing);
          this.emit();
        }
        // A server shown as down may be back: a check already running (say, after a pull) decides, or a
        // picker refresh starts one when the last is stale. A server not checked yet is listed directly.
        const down = entry.health.state !== 'online' && entry.health.state !== 'unknown';
        const running = this.checking.get(entry);
        if (down && (running || this.stale(entry))) {
          const check = (running ?? this.checkEntry(entry).then(() => this.emit())).catch(() => undefined);
          await within(check, PICKER_CHECK_WAIT_MS, undefined);
        }
        if (entry.health.state === 'online' || entry.health.state === 'unknown') {
          try {
            const listed = await entry.client.listModels();
            void this.deps.store
              .setModels(
                entry.record.id,
                listed.map(model => model.name)
              )
              .catch(() => undefined);
            entry.record = { ...entry.record, models: listed.map(model => model.name) };
            entry.aliasIds = aliasIdsOf(listed);
            if (entry.health.state === 'unknown') void this.check(entry.record.id);
            return listed.map(model => ({ ...model, server }));
          } catch (raw) {
            const err = this.unwrapFailure(raw, entry);
            entry.health = failureHealth(err, entry.record.name) ?? {
              ...entry.health,
              state: 'unreachable',
              error: `${entry.record.name}: ${describeFailure(err)}`,
            };
          }
        }
        const reason = unavailableReason(entry);
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
          };
        });
      })
    );
    return lists.flat();
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
        baseUrl: record.transport.baseUrl,
        health: async () => {
          const health = (await this.check(id)).find(server => server.id === id)?.health;
          return health?.state === 'online'
            ? { ok: true, version: health.version, error: null }
            : { ok: false, version: null, error: health?.error ?? `${record.name} did not answer.` };
        },
        list: () => this.run(id, undefined, current => current.runtime.list()),
        loaded: () => this.run(id, undefined, current => current.runtime.loaded()),
        inspect: (model, options) => this.run(id, options?.signal, current => current.runtime.inspect(model, options)),
        pull: (ref, options) => this.run(id, options?.signal, current => current.runtime.pull(ref, options)),
        remove: model => this.run(id, undefined, current => current.runtime.remove(model)),
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
      const health = failureHealth(err, entry.record.name);
      if (!health) throw raw;
      entry.health = health;
      this.emit();
      if (health.state === 'unreachable')
        throw new ServerUnreachableError(entry.record.name, describeFailure(err), { cause: err });
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
  }

  /** One check per server at a time; callers during a check share its result. */
  private checkEntry(entry: Entry): Promise<void> {
    const running = this.checking.get(entry);
    if (running) return running;
    const done = this.probeEntry(entry).finally(() => this.checking.delete(entry));
    this.checking.set(entry, done);
    return done;
  }

  private async probeEntry(entry: Entry): Promise<void> {
    entry.scope = (await this.scopeOf(entry.parsed.host)) ?? entry.scope;
    if (this.deps.store.credentialMissing(entry.record)) {
      this.setHealth(entry, this.missingCredentialHealth());
      return;
    }
    const outcome = await probeServer(
      entry.fetch,
      entry.record.transport.baseUrl,
      entry.record.name,
      this.now,
      entry.record.kind
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
      return;
    }
    if (!outcome.kind) {
      this.setHealth(entry, {
        state: outcome.refused ? 'refused' : 'unreachable',
        version: null,
        latencyMs: null,
        checkedAt,
        error: outcome.error,
      });
      return;
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
    try {
      const listed = await entry.client.listModels();
      const names = listed.map(model => model.name);
      entry.record = { ...entry.record, models: names };
      entry.aliasIds = aliasIdsOf(listed);
      await this.deps.store.setModels(entry.record.id, names);
    } catch (err) {
      this.deps.logger.debug(
        `MODEL SERVERS: listing ${entry.record.id} failed: ${err instanceof Error ? err.name : 'unknown'}`
      );
    }
    // Each check is how tools come back after the server restarts with tool calling on. Not awaited: the probe
    // generates a token, and a change reaches Settings and the picker through toolsChanged.
    void entry.client.recheckTools?.(entry.record.models[0]);
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
    const parsed = parseServerAddress(record.transport.baseUrl) as ParsedAddress;
    const endpoint: ServerEndpoint = {
      origin: parsed.origin,
      label: record.name,
      credentialHeaders: () => this.deps.store.headers(record),
    };
    const fetch = this.fetchFor(endpoint);
    const runtimeId = serverRuntimeId(record.id);
    const hasCredentials = () => !!this.deps.store.headers(record);
    const product = previous?.record.kind === record.kind ? previous.product : null;
    const client: ServerClient =
      record.kind === 'ollama'
        ? new OllamaLocal(undefined, undefined, {
            runtimeId,
            baseUrl: parsed.baseUrl,
            label: record.name,
            fetch,
            hasCredentials,
            redact: redactServerResponse,
          })
        : new OpenAICompatibleChat({
            runtimeId,
            baseUrl: parsed.baseUrl,
            label: record.name,
            product,
            fetch,
            hasCredentials,
            redact: redactServerResponse,
            toolsChanged: () => this.emit(),
          });
    const runtime: LocalRuntime =
      record.kind === 'ollama'
        ? new OllamaRuntime({ baseUrl: parsed.baseUrl, id: runtimeId, fetch, redact: redactServerResponse })
        : new OpenAICompatibleRuntime({ baseUrl: parsed.baseUrl, id: runtimeId, fetch, product });
    return {
      record,
      parsed,
      scope: previous?.scope ?? (isIP(parsed.host) ? scopeOfIp(parsed.host) : null),
      fetch,
      client,
      runtime,
      health: previous && previous.record.kind === record.kind ? previous.health : { ...UNKNOWN_HEALTH },
      product,
      ...(previous?.aliasIds ? { aliasIds: previous.aliasIds } : {}),
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
      address: record.transport.baseUrl,
      access: record.access,
      auth:
        record.auth.type === 'header' ? { type: 'header', headerName: record.auth.name } : { type: record.auth.type },
      credentialsPersisted: record.auth.type === 'none' || this.deps.store.credentialPersisted(),
      credentialsMissing: this.deps.store.credentialMissing(record),
      unencrypted: entry.parsed.protocol === 'http:' && entry.scope === 'private',
      health: entry.health,
      models: record.models,
      specs: record.specs,
    };
  }

  private load(): Promise<void> {
    this.loaded ??= Promise.all([this.deps.store.list(), this.deps.store.localSpecs()]).then(([records, specs]) => {
      for (const record of records) {
        if (parseServerAddress(record.transport.baseUrl)) this.entries.set(record.id, this.build(record));
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

/** The port "This computer" already uses: saving it again would list the same Ollama twice. */
function isLocalOllama(parsed: ParsedAddress): boolean {
  return (
    LOOPBACK_NAMES.has(parsed.host.toLowerCase().replace(/\.$/, '')) &&
    new URL(parsed.origin).port === LOCAL_OLLAMA_PORT
  );
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

function unavailableReason(entry: Entry): string {
  if (entry.health.state === 'credentials') return `${entry.record.name} needs new credentials`;
  if (entry.health.state === 'refused')
    return `${entry.record.name} was refused: ${entry.health.error ?? 'check Settings'}`;
  return `${entry.record.name} is unreachable`;
}

/** The health a failed request implies; null when the failure says nothing about the server (a model error). */
function failureHealth(err: unknown, label: string): ModelServerHealth | null {
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
    error: `${label}: ${describeFailure(err)}`,
  };
}
