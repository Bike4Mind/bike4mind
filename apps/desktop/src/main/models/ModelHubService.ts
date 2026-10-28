import {
  HubAccessError,
  HubRateLimitError,
  LocalRuntimeError,
  ModelNotFoundError,
  PullIdleTimeoutError,
  RuntimeConnectionError,
  RuntimeHttpError,
  isAbliteratedModel,
  isHubRepoId,
  type HubGgufBuild,
  type HubModelDetail,
  type HubModelSummary,
  type HubSearchOptions,
  type HubSearchPage,
  type InstalledModel,
  type LoadedModel,
  type PullOptions,
  type PullProgress,
  type RuntimeHealth,
} from '@bike4mind/local-models';
import {
  licenseKind,
  pullKey,
  type HubBuildView,
  type HubDetailResult,
  type HubModelCard,
  type HubModelView,
  type HubSearchRequest,
  type HubSearchResult,
  type InstalledModelsResult,
  type ModelHubError,
  type ModelHubErrorKind,
  type ModelPull,
  type ModelPullRequest,
  type ModelPullResult,
  type ModelRemoveResult,
  type ModelRuntimeStatus,
  type ModelServerManagement,
} from '@shared/models';
import { LOCAL_SERVER_ID, LOCAL_SERVER_NAME } from '@shared/modelServers';
import { ServerCredentialsError, ServerUnreachableError } from '../modelServers/errors';
import { ServerRedirectError, ServerTransportError } from '../modelServers/serverFetch';

export interface ModelRuntimePort {
  readonly baseUrl: string;
  health(): Promise<RuntimeHealth>;
  list(): Promise<InstalledModel[]>;
  loaded(): Promise<LoadedModel[]>;
  pull(ref: string, opts?: PullOptions): Promise<void>;
  remove(model: string): Promise<void>;
}

export interface ModelHubPort {
  readonly endpoint: string;
  search(options: HubSearchOptions): Promise<HubSearchPage>;
  getModel(repo: string, options?: { signal?: AbortSignal; refresh?: boolean }): Promise<HubModelDetail>;
  verifyOllamaRef(
    detail: Pick<HubModelDetail, 'id' | 'builds'>,
    build: HubGgufBuild,
    options?: { signal?: AbortSignal }
  ): Promise<string | null>;
}

/**
 * A saved model server, read fresh for every call so a changed access setting applies at once. Its runtime
 * reports a dropped connection as ServerUnreachableError and a 401 or 403 as ServerCredentialsError.
 */
export interface ModelHubServer {
  name: string;
  management: ModelServerManagement;
  runtime: ModelRuntimePort;
}

export interface ModelHubServiceDeps {
  /** This computer's Ollama. */
  runtime: ModelRuntimePort;
  /** A saved model server by id; null when none is saved under it. */
  server?: (id: string) => ModelHubServer | null;
  hub: ModelHubPort;
  onPullsChanged: (pulls: ModelPull[]) => void;
  onInstalledChanged: (serverId: string) => void;
  /** True while a download to a saved server runs: that server's Ollama stops it if this computer sleeps. */
  keepAwake?: (on: boolean) => void;
  /** Minimum gap between progress pushes (ms). */
  progressIntervalMs?: number;
}

const DEFAULT_PROGRESS_INTERVAL_MS = 250;
const SEARCH_LIMIT = 30;

interface Target extends ModelHubServer {
  id: string;
  local: boolean;
}

interface PullEntry {
  view: ModelPull;
  controller: AbortController;
  /** The verified name Ollama pulls; a resume asks for the same one. */
  ref: string | null;
  /** Why the pull was stopped when its server was removed or set to no longer allow it. */
  stopped?: ModelHubError;
}

const SERVER_GONE = 'That model server is no longer saved. Pick another under Models.';

function hubError(kind: ModelHubErrorKind, message: string, retryAfterMs?: number | null): ModelHubError {
  return retryAfterMs === undefined ? { kind, message } : { kind, message, retryAfterMs };
}

/** Maps local-models errors, which never carry the Hugging Face token, onto what the screen explains. */
export function toModelHubError(error: unknown): ModelHubError {
  if (error instanceof ServerCredentialsError) return hubError('credentials', error.message);
  if (error instanceof ServerUnreachableError) return hubError('runtime-unavailable', error.message);
  if (error instanceof ServerTransportError || error instanceof ServerRedirectError)
    return hubError('failed', error.message);
  if (error instanceof PullIdleTimeoutError)
    return hubError(
      'runtime-unavailable',
      'Ollama stopped sending download progress, so the download was stopped. Download again to continue it.'
    );
  const fromHub = error instanceof LocalRuntimeError && error.runtimeId.startsWith('huggingface');
  if (error instanceof HubRateLimitError)
    return hubError('rate-limited', 'Hugging Face is rate limiting this computer.', error.retryAfterMs);
  if (error instanceof HubAccessError)
    return hubError('gated', 'Hugging Face refused access to this repo. Request access on its page first.');
  if (error instanceof ModelNotFoundError)
    return fromHub
      ? hubError('not-found', `Hugging Face has no public repo named ${error.model}.`)
      : hubError('not-found', `Ollama has no model named ${error.model}.`);
  if (error instanceof RuntimeConnectionError)
    return fromHub
      ? hubError('hub-unreachable', 'Could not reach Hugging Face. Check your connection and try again.')
      : hubError('runtime-unavailable', 'Could not reach Ollama.');
  if (error instanceof RuntimeHttpError && fromHub && error.status >= 500)
    return hubError('hub-unreachable', `Hugging Face answered with an error (HTTP ${error.status}). Try again later.`);
  if (error instanceof Error) return hubError('failed', error.message);
  return hubError('failed', String(error));
}

/**
 * Maps Ollama's EOF pull errors. A bare `EOF` comes from its resume reading a chunk file a stopped pull left
 * truncated; `Get "...": EOF` and `Head "...": EOF` are the registry connection closing.
 */
function pullEofError(error: unknown, ref: string): ModelHubError | null {
  if (!(error instanceof LocalRuntimeError) || error.runtimeId.startsWith('huggingface')) return null;
  if (error.message.endsWith(` could not pull ${ref}: EOF`))
    return hubError(
      'interrupted',
      'An earlier download of this model was interrupted and Ollama cannot resume it; restarting Ollama does not ' +
        "clear it. While nothing else is downloading, delete the files with -partial in their names from Ollama's " +
        'blobs folder (usually ~/.ollama/models/blobs), then download again.'
    );
  if (/: EOF$/.test(error.message))
    return hubError(
      'hub-unreachable',
      'Ollama lost its connection to Hugging Face. Check your connection, then download again.'
    );
  return null;
}

function diskFullError(error: unknown, target: Target): ModelHubError | null {
  if (!(error instanceof Error) || !/no space left on device/i.test(error.message)) return null;
  return hubError('failed', `${target.name} ran out of disk space for this download. Free some space, then retry.`);
}

function manageRefusal(target: Target): ModelHubError | null {
  if (target.management === 'chat-only')
    return hubError(
      'not-allowed',
      `${target.name} is set to Chat only, so Desktop does not download to it or remove its models. ` +
        'Change that under Settings, Model servers.'
    );
  if (target.management === 'unsupported')
    return hubError(
      'not-allowed',
      `${target.name} is not an Ollama server, so Desktop cannot download to it or remove its models.`
    );
  return null;
}

/**
 * The name Ollama pulls a gated or private repo by. Ollama refuses to sign a pull whose auth realm (huggingface.co)
 * is not the host it asked (hf.co redirects there), so these are pulled by their huggingface.co name instead.
 */
export function signedPullRef(ref: string): string {
  return ref.replace(/^hf\.co\//, 'huggingface.co/');
}

function toCard(model: HubModelSummary): HubModelCard {
  return {
    id: model.id,
    author: model.author,
    downloads: model.downloads,
    likes: model.likes,
    updatedAt: model.updatedAt,
    licenses: model.licenses,
    gated: model.gated,
    private: model.private,
    abliterated: isAbliteratedModel(model),
  };
}

function blockedReason(detail: HubModelDetail, build: HubGgufBuild): string | null {
  if (build.split) return 'Split into several files, which Ollama cannot pull from Hugging Face.';
  if (!build.complete) return 'Some of its files are missing from the repo.';
  if (build.ollamaRefIssue === 'no-quant-label') return 'Its file name has no quant label Ollama can pull by.';
  if (build.ollamaRefIssue === 'unsupported-name') return "Its repo or file name breaks Ollama's naming rules.";
  if (build.ollamaRefIssue === 'unsupported-quant') return 'Ollama cannot pull this quant from Hugging Face yet.';
  if (!build.files[0]?.sha256)
    return detail.ollamaNeedsSshKey
      ? 'Needs access: Hugging Face hides this file until your account is granted access.'
      : 'Hugging Face lists no checksum for this file, so the download cannot be verified.';
  return null;
}

/** An unparseable card link falls back to the repo page. */
function licenseUrl(endpoint: string, detail: HubModelDetail): string {
  const link = detail.licenseLink?.trim();
  const candidate =
    link && /^https:\/\//i.test(link)
      ? link
      : link && !/^[a-z][a-z0-9+.-]*:/i.test(link) && !link.startsWith('//')
        ? `${endpoint}/${detail.id}/blob/main/${link.replace(/^\.?\//, '')}`
        : null;
  return candidate && URL.canParse(candidate) ? candidate : `${endpoint}/${detail.id}`;
}

function toView(endpoint: string, detail: HubModelDetail): HubModelView {
  const builds: HubBuildView[] = detail.builds.map(build => ({
    id: build.id,
    quant: build.quant,
    sizeBytes: build.sizeBytes,
    ollamaRef: build.ollamaRef && detail.ollamaNeedsSshKey ? signedPullRef(build.ollamaRef) : build.ollamaRef,
    blockedReason: blockedReason(detail, build),
  }));
  const url = licenseUrl(endpoint, detail);
  return {
    ...toCard(detail),
    url: `${endpoint}/${detail.id}`,
    revision: detail.revision,
    licenseNames: detail.licenses.map(id => (id === 'other' && detail.licenseName) || id),
    licenseUrl: url,
    licenseHost: new URL(url).host,
    licenseKind: licenseKind(detail.licenses),
    baseModels: detail.baseModels,
    builds,
    projectorBytes: detail.projectors.length ? Math.max(...detail.projectors.map(entry => entry.sizeBytes)) : null,
    needsAccess: detail.ollamaNeedsSshKey,
  };
}

function phaseOf(status: string): ModelPull['phase'] {
  return status.startsWith('verifying') || status.startsWith('writing') || status === 'success'
    ? 'finishing'
    : 'downloading';
}

/**
 * Installed models, Hugging Face search and pulls for the Ollama daemon Desktop chats with, and for each saved
 * model server set to "Chat and manage". Every call names its server; omitted means this computer.
 */
export class ModelHubService {
  readonly #deps: ModelHubServiceDeps;
  readonly #pulls = new Map<string, PullEntry>();
  readonly #progressIntervalMs: number;
  #lastPush = 0;
  #pushTimer: ReturnType<typeof setTimeout> | null = null;
  #awake = false;
  #disposed = false;

  constructor(deps: ModelHubServiceDeps) {
    this.#deps = deps;
    this.#progressIntervalMs = deps.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
  }

  #target(serverId: string | undefined): Target | null {
    if (serverId === undefined || serverId === LOCAL_SERVER_ID)
      return {
        id: LOCAL_SERVER_ID,
        name: LOCAL_SERVER_NAME,
        local: true,
        management: 'allowed',
        runtime: this.#deps.runtime,
      };
    const server = this.#deps.server?.(serverId);
    return server ? { ...server, id: serverId, local: false } : null;
  }

  async status(serverId?: string): Promise<ModelRuntimeStatus> {
    const target = this.#target(serverId);
    if (!target)
      return {
        reachable: false,
        version: null,
        url: '',
        error: SERVER_GONE,
        serverId: serverId ?? LOCAL_SERVER_ID,
        serverName: 'Model server',
        management: 'unsupported',
      };
    const health = await target.runtime.health();
    return {
      reachable: health.ok,
      version: health.version,
      url: target.runtime.baseUrl,
      error: health.error,
      serverId: target.id,
      serverName: target.name,
      management: target.management,
    };
  }

  async installed(serverId?: string): Promise<InstalledModelsResult> {
    const target = this.#target(serverId);
    if (!target) return { ok: false, error: hubError('not-found', SERVER_GONE) };
    try {
      const [models, loaded] = await Promise.all([
        target.runtime.list(),
        target.runtime.loaded().catch(() => [] as LoadedModel[]),
      ]);
      const loadedNames = new Set(loaded.map(entry => entry.name));
      return {
        ok: true,
        models: models
          .map(model => ({ ...model, loaded: loadedNames.has(model.name) }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    } catch (error) {
      return { ok: false, error: toModelHubError(error) };
    }
  }

  async search(request: HubSearchRequest): Promise<HubSearchResult> {
    try {
      const page = await this.#deps.hub.search({
        query: request.query,
        cursor: request.cursor ?? undefined,
        sort: 'downloads',
        limit: SEARCH_LIMIT,
      });
      return { ok: true, models: page.models.map(toCard), nextCursor: page.nextCursor };
    } catch (error) {
      return { ok: false, error: toModelHubError(error) };
    }
  }

  async detail(repo: string): Promise<HubDetailResult> {
    try {
      return { ok: true, model: toView(this.#deps.hub.endpoint, await this.#deps.hub.getModel(repo)) };
    } catch (error) {
      return { ok: false, error: toModelHubError(error) };
    }
  }

  pulls(): ModelPull[] {
    return [...this.#pulls.values()].map(entry => ({ ...entry.view }));
  }

  /**
   * Resolves when the pull finishes, fails, pauses or is cancelled; progress arrives through `onPullsChanged`.
   * Refused for a server the user did not set to "Chat and manage".
   */
  async pull(request: ModelPullRequest): Promise<ModelPullResult> {
    if (!isHubRepoId(request.repo)) return { ok: false, error: hubError('invalid', 'Invalid request.'), listed: false };
    const target = this.#target(request.serverId);
    if (!target) return { ok: false, error: hubError('not-found', SERVER_GONE), listed: false };
    const refusal = manageRefusal(target);
    if (refusal) return { ok: false, error: refusal, listed: false };
    const key = pullKey(request.repo, request.buildId, target.id);
    const existing = this.#pulls.get(key);
    if (existing && existing.view.phase !== 'failed' && existing.view.phase !== 'paused')
      return { ok: false, error: hubError('already-pulling', 'This model is already downloading.'), listed: true };

    const controller = new AbortController();
    const entry: PullEntry = {
      controller,
      ref: null,
      view: {
        key,
        serverId: target.id,
        serverName: target.name,
        repo: request.repo,
        buildId: request.buildId,
        quant: null,
        ref: null,
        phase: 'verifying',
        completedBytes: 0,
        totalBytes: null,
        expectedBytes: 0,
        error: null,
      },
    };
    this.#pulls.set(key, entry);
    this.#push(true);

    const refuse = (error: ModelHubError): ModelPullResult => {
      this.#drop(key, entry);
      return { ok: false, error: entry.stopped ?? error, listed: false };
    };

    let ref: string | null;
    try {
      // Read fresh: a card edit (say, a new license) is a new commit, and it must still be the one the dialog showed.
      const detail = await this.#deps.hub.getModel(request.repo, { refresh: true });
      const build = detail.builds.find((candidate: HubGgufBuild) => candidate.id === request.buildId);
      if (!build) return refuse(hubError('not-found', 'That build is no longer in this repo.'));
      if (detail.revision !== request.revision || build.sizeBytes !== request.sizeBytes)
        return refuse(hubError('changed', 'This repo changed since you reviewed it. Review it again, then download.'));
      const reason = blockedReason(detail, build);
      if (reason) return refuse(hubError('cannot-pull', reason));
      if (licenseKind(detail.licenses) === 'restricted' && !request.acceptLicense)
        return refuse(hubError('license-required', 'Accept the license before downloading.'));
      if (detail.ollamaNeedsSshKey && !request.confirmAccess)
        return refuse(hubError('access-required', 'Confirm the Hugging Face access steps before downloading.'));
      entry.view = { ...entry.view, quant: build.quant, expectedBytes: build.sizeBytes };

      const health = await target.runtime.health();
      if (controller.signal.aborted) return refuse(hubError('cancelled', 'Download cancelled.'));
      if (!health.ok)
        return this.#fail(
          key,
          entry,
          hubError(
            'runtime-unavailable',
            target.local
              ? 'Ollama is not running. Start it, then retry.'
              : (health.error ?? `Could not reach ${target.name}. Check it, then retry.`)
          )
        );
      // The registry serves the first file whose name ends with the tag; only its manifest proves which one.
      ref = await this.#deps.hub.verifyOllamaRef(detail, build, { signal: controller.signal });
      if (ref && detail.ollamaNeedsSshKey) ref = signedPullRef(ref);
    } catch (error) {
      if (controller.signal.aborted) return refuse(hubError('cancelled', 'Download cancelled.'));
      return this.#fail(key, entry, toModelHubError(error));
    }
    if (controller.signal.aborted) return refuse(hubError('cancelled', 'Download cancelled.'));
    if (!ref)
      return this.#fail(
        key,
        entry,
        hubError(
          'unverified',
          'Hugging Face could not confirm Ollama would get this exact file, so it was not downloaded.'
        )
      );

    entry.ref = ref;
    return this.#download(key, entry, target);
  }

  /** Continues a paused pull of the same verified name; Ollama picks up its partial file. */
  async resume(key: string): Promise<ModelPullResult> {
    const entry = this.#pulls.get(key);
    if (!entry || entry.view.phase !== 'paused' || !entry.ref)
      return { ok: false, error: hubError('invalid', 'That download is not paused.'), listed: false };
    const target = this.#target(entry.view.serverId);
    if (!target) return this.#fail(key, entry, hubError('not-found', SERVER_GONE));
    const refusal = manageRefusal(target);
    if (refusal) return this.#fail(key, entry, refusal);
    entry.controller = new AbortController();
    return this.#download(key, entry, target);
  }

  async #download(key: string, entry: PullEntry, target: Target): Promise<ModelPullResult> {
    const ref = entry.ref as string;
    const { signal } = entry.controller;
    entry.view = { ...entry.view, ref, phase: 'downloading', error: null };
    this.#push(true);
    try {
      await target.runtime.pull(ref, {
        signal,
        onProgress: (progress: PullProgress) => {
          const phase = phaseOf(progress.status);
          const changed = phase !== entry.view.phase;
          entry.view = {
            ...entry.view,
            phase,
            completedBytes: progress.completedBytes,
            totalBytes: progress.totalBytes,
          };
          this.#push(changed);
        },
      });
    } catch (error) {
      if (signal.aborted) {
        this.#drop(key, entry);
        return { ok: false, error: entry.stopped ?? hubError('cancelled', 'Download cancelled.'), listed: false };
      }
      if (!target.local && error instanceof ServerUnreachableError) return this.#pause(key, entry, target);
      return this.#fail(key, entry, pullEofError(error, ref) ?? diskFullError(error, target) ?? toModelHubError(error));
    }
    this.#drop(key, entry);
    this.#deps.onInstalledChanged(target.id);
    return { ok: true, ref };
  }

  /** Cancels a running pull; a paused one has nothing running, so it is cleared. */
  cancel(key: string): void {
    const entry = this.#pulls.get(key);
    if (entry?.view.phase === 'paused') this.#drop(key, entry);
    else entry?.controller.abort();
  }

  /** Clears a failed or paused pull from the list; active pulls are cancelled instead. */
  dismiss(key: string): void {
    const entry = this.#pulls.get(key);
    if (entry?.view.phase === 'failed' || entry?.view.phase === 'paused') this.#drop(key, entry);
  }

  /** Called when a saved server changes or is removed: stops and clears its pulls once it no longer allows them. */
  serverChanged(serverId: string): void {
    const target = this.#target(serverId);
    const reason = target ? manageRefusal(target) : hubError('not-found', SERVER_GONE);
    if (!reason) return;
    for (const [key, entry] of this.#pulls) {
      if (entry.view.serverId !== serverId) continue;
      entry.stopped = reason;
      entry.controller.abort();
      this.#drop(key, entry);
    }
  }

  /** Refused for a server the user did not set to "Chat and manage". */
  async remove(name: string, serverId?: string): Promise<ModelRemoveResult> {
    const target = this.#target(serverId);
    if (!target) return { ok: false, error: hubError('not-found', SERVER_GONE) };
    const refusal = manageRefusal(target);
    if (refusal) return { ok: false, error: refusal };
    try {
      await target.runtime.remove(name);
    } catch (error) {
      return { ok: false, error: toModelHubError(error) };
    }
    this.#deps.onInstalledChanged(target.id);
    return { ok: true };
  }

  dispose(): void {
    // Set first: each aborted pull settles after this and must not wake the computer or push again.
    this.#disposed = true;
    for (const entry of this.#pulls.values()) entry.controller.abort();
    if (this.#pushTimer) clearTimeout(this.#pushTimer);
    this.#pushTimer = null;
    if (this.#awake) this.#deps.keepAwake?.(false);
    this.#awake = false;
  }

  #pause(key: string, entry: PullEntry, target: Target): ModelPullResult {
    if (entry.stopped) return { ok: false, error: entry.stopped, listed: false };
    const error = hubError(
      'connection-lost',
      `Paused: lost the connection to ${target.name}. Resume continues from the part it already downloaded. ` +
        `If Ollama on ${target.name} restarts after more than an hour paused, the download starts over.`
    );
    if (this.#pulls.get(key) === entry) {
      entry.view = { ...entry.view, phase: 'paused', error };
      this.#push(true);
    }
    return { ok: false, error, listed: true };
  }

  #fail(key: string, entry: PullEntry, error: ModelHubError): ModelPullResult {
    if (entry.stopped) return { ok: false, error: entry.stopped, listed: false };
    if (this.#pulls.get(key) === entry) {
      entry.view = { ...entry.view, phase: 'failed', error };
      this.#push(true);
    }
    return { ok: false, error, listed: true };
  }

  #drop(key: string, entry: PullEntry): void {
    if (this.#pulls.get(key) !== entry) return;
    this.#pulls.delete(key);
    this.#push(true);
  }

  #push(now: boolean): void {
    if (this.#disposed) return;
    const awake = [...this.#pulls.values()].some(
      ({ view }) => view.serverId !== LOCAL_SERVER_ID && view.phase !== 'paused' && view.phase !== 'failed'
    );
    if (awake !== this.#awake) {
      this.#awake = awake;
      this.#deps.keepAwake?.(awake);
    }
    const elapsed = Date.now() - this.#lastPush;
    if (now || elapsed >= this.#progressIntervalMs) {
      if (this.#pushTimer) clearTimeout(this.#pushTimer);
      this.#pushTimer = null;
      this.#lastPush = Date.now();
      this.#deps.onPullsChanged(this.pulls());
      return;
    }
    this.#pushTimer ??= setTimeout(() => {
      this.#pushTimer = null;
      this.#lastPush = Date.now();
      this.#deps.onPullsChanged(this.pulls());
    }, this.#progressIntervalMs - elapsed);
  }
}
