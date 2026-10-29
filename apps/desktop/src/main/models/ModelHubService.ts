import {
  HubAccessError,
  HubRateLimitError,
  LocalRuntimeError,
  ModelNotFoundError,
  RuntimeConnectionError,
  RuntimeHttpError,
  isAbliteratedModel,
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
} from '@shared/models';

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

export interface ModelHubServiceDeps {
  runtime: ModelRuntimePort;
  hub: ModelHubPort;
  onPullsChanged: (pulls: ModelPull[]) => void;
  onInstalledChanged: () => void;
  /** Minimum gap between progress pushes (ms). */
  progressIntervalMs?: number;
}

const DEFAULT_PROGRESS_INTERVAL_MS = 250;
const SEARCH_LIMIT = 30;

interface PullEntry {
  view: ModelPull;
  controller: AbortController;
}

function hubError(kind: ModelHubErrorKind, message: string, retryAfterMs?: number | null): ModelHubError {
  return retryAfterMs === undefined ? { kind, message } : { kind, message, retryAfterMs };
}

/** Maps local-models errors, which never carry the Hugging Face token, onto what the screen explains. */
export function toModelHubError(error: unknown): ModelHubError {
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
    label: build.label,
    sizeBytes: build.sizeBytes,
    ollamaRef: build.ollamaRef,
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

/** Installed models, Hugging Face search and pulls for the Ollama daemon Desktop chats with. */
export class ModelHubService {
  readonly #deps: ModelHubServiceDeps;
  readonly #pulls = new Map<string, PullEntry>();
  readonly #progressIntervalMs: number;
  #lastPush = 0;
  #pushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: ModelHubServiceDeps) {
    this.#deps = deps;
    this.#progressIntervalMs = deps.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
  }

  async status(): Promise<ModelRuntimeStatus> {
    const health = await this.#deps.runtime.health();
    return { reachable: health.ok, version: health.version, url: this.#deps.runtime.baseUrl, error: health.error };
  }

  async installed(): Promise<InstalledModelsResult> {
    try {
      const [models, loaded] = await Promise.all([
        this.#deps.runtime.list(),
        this.#deps.runtime.loaded().catch(() => [] as LoadedModel[]),
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

  /** Resolves when the pull finishes, fails or is cancelled; progress arrives through `onPullsChanged`. */
  async pull(request: ModelPullRequest): Promise<ModelPullResult> {
    const key = pullKey(request.repo, request.buildId);
    const existing = this.#pulls.get(key);
    if (existing && existing.view.phase !== 'failed')
      return { ok: false, error: hubError('already-pulling', 'This model is already downloading.'), listed: true };

    const controller = new AbortController();
    const entry: PullEntry = {
      controller,
      view: {
        key,
        repo: request.repo,
        buildId: request.buildId,
        label: null,
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
      return { ok: false, error, listed: false };
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
      entry.view = { ...entry.view, label: build.label, expectedBytes: build.sizeBytes };

      const health = await this.#deps.runtime.health();
      if (controller.signal.aborted) return refuse(hubError('cancelled', 'Download cancelled.'));
      if (!health.ok)
        return this.#fail(key, entry, hubError('runtime-unavailable', 'Ollama is not running. Start it, then retry.'));
      // The registry serves the first file whose name ends with the tag; only its manifest proves which one.
      ref = await this.#deps.hub.verifyOllamaRef(detail, build, { signal: controller.signal });
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

    entry.view = { ...entry.view, ref, phase: 'downloading' };
    this.#push(true);
    try {
      await this.#deps.runtime.pull(ref, {
        signal: controller.signal,
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
      if (controller.signal.aborted) return refuse(hubError('cancelled', 'Download cancelled.'));
      return this.#fail(key, entry, pullEofError(error, ref) ?? toModelHubError(error));
    }
    this.#drop(key, entry);
    this.#deps.onInstalledChanged();
    return { ok: true, ref };
  }

  cancel(key: string): void {
    this.#pulls.get(key)?.controller.abort();
  }

  /** Clears a failed pull from the list; active pulls are cancelled instead. */
  dismiss(key: string): void {
    const entry = this.#pulls.get(key);
    if (entry?.view.phase === 'failed') this.#drop(key, entry);
  }

  async remove(name: string): Promise<ModelRemoveResult> {
    try {
      await this.#deps.runtime.remove(name);
    } catch (error) {
      return { ok: false, error: toModelHubError(error) };
    }
    this.#deps.onInstalledChanged();
    return { ok: true };
  }

  dispose(): void {
    for (const entry of this.#pulls.values()) entry.controller.abort();
    if (this.#pushTimer) clearTimeout(this.#pushTimer);
    this.#pushTimer = null;
  }

  #fail(key: string, entry: PullEntry, error: ModelHubError): ModelPullResult {
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
