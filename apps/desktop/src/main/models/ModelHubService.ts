import {
  HubAccessError,
  HubRateLimitError,
  LocalRuntimeError,
  ModelNotFoundError,
  PullIdleTimeoutError,
  RuntimeConnectionError,
  RuntimeHttpError,
  curatedLibrary as libraryOf,
  curatedListing,
  curatedOllamaBlocked as ollamaBlocked,
  curatedParamsLabel as paramsLabel,
  curatedPicks,
  curatedPins as pinsOf,
  curatedRunner,
  curatedSource,
  installedReviewed,
  isAbliteratedModel,
  isCuratedListable as listable,
  isCuratedPullable as pullable,
  isHubRepoId,
  isPermissiveEntry as permissive,
  type HardwareProfile,
  ollamaPullRef,
  ollamaRefAliases,
  servesReviewed,
  type HubGgufBuild,
  type HubModelDetail,
  type HubModelSummary,
  type HubSearchOptions,
  type HubSearchPage,
  type InspectOptions,
  type InstalledModel,
  type LoadedModel,
  type ModelArch,
  type ModelInspection,
  type OllamaRegistryLayers,
  type PullOptions,
  type PullProgress,
  type RuntimeHealth,
} from '@bike4mind/local-models';
import type { HubBuild, HubEntry, HubManifest } from '@bike4mind/common';
import {
  licenseKind,
  pullKey,
  type CuratedBuildView,
  type CuratedCheckResult,
  type CuratedEntryView,
  type CuratedList,
  type CuratedPickView,
  type CuratedPullResult,
  type HfTokenResult,
  type HfTokenStatus,
  type HubAccess,
  type HubBuildView,
  type HubDetailResult,
  type HubModelCard,
  type HubModelView,
  type HubSearchRequest,
  type HubSearchResult,
  type InstalledModelsResult,
  type ModelFit,
  type ModelHubError,
  type ModelHubErrorKind,
  type ModelPull,
  type ModelPullRequest,
  type ModelPullResult,
  type ModelRemoveResult,
  type ModelRuntimeStatus,
  type ModelServerManagement,
} from '@shared/models';
import { AUTO_LOCAL_CONTEXT, type LocalContextSetting } from '@shared/localContextSetting';
import { LOCAL_SERVER_ID, LOCAL_SERVER_NAME, specsRate, type ModelServerSpecs } from '@shared/modelServers';
import { chatContextTokens, type LocalModelFootprint } from '../chat/localContext';
import { configuredNumCtx } from '../chat/localChatContext';
import { ServerCredentialsError, ServerUnreachableError } from '../modelServers/errors';
import { ServerRedirectError, ServerTransportError } from '../modelServers/serverFetch';
import { serverHardware, withEnteredSpecs } from './enteredHardware';
import { fitFromArch, fitFromSize, machineView } from './fit';

export interface ModelRuntimePort {
  readonly baseUrl: string;
  health(): Promise<RuntimeHealth>;
  list(): Promise<InstalledModel[]>;
  inspect(model: string, options?: InspectOptions): Promise<ModelInspection>;
  loaded(): Promise<LoadedModel[]>;
  pull(ref: string, opts?: PullOptions): Promise<void>;
  remove(model: string): Promise<void>;
}

export interface ModelHubPort {
  readonly endpoint: string;
  search(options: HubSearchOptions): Promise<HubSearchPage>;
  getModel(repo: string, options?: { signal?: AbortSignal; refresh?: boolean }): Promise<HubModelDetail>;
  verifyOllamaRef(
    detail: Pick<HubModelDetail, 'id' | 'builds' | 'ollamaNeedsSshKey'>,
    build: HubGgufBuild,
    options?: { signal?: AbortSignal }
  ): Promise<string | null>;
  ollamaLayers(repo: string, tag: string, options?: { signal?: AbortSignal }): Promise<OllamaRegistryLayers | null>;
  checkToken(options?: { signal?: AbortSignal }): Promise<boolean>;
}

export interface HubTokenPort {
  persisted(): boolean;
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
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
  /** A Hub client sending `token`, if any; it must only ever be pointed at Hugging Face itself. */
  createHub: (token: string | null) => ModelHubPort;
  tokens: HubTokenPort;
  /** The layers the Ollama library serves for a `name:tag` ref; null when it has no such tag. */
  libraryLayers: (ref: string, options?: { signal?: AbortSignal }) => Promise<OllamaRegistryLayers | null>;
  /** This computer's probe, before entered specs; probed once, on first use. */
  hardware: () => Promise<HardwareProfile>;
  /** Hardware entered in Settings by server id, `local` for this computer; read fresh for every call. */
  specs?: (serverId: string) => ModelServerSpecs | null;
  /** The Settings choice local chat sizes its context with; fit badges plan for that same context. */
  localContext: () => Promise<LocalContextSetting>;
  /**
   * The Curated tab's current list, which can change while the app runs. Each call here reads it once and uses
   * that snapshot throughout, so a list update during a download never changes the pins it is checked against.
   */
  curated: () => HubManifest;
  onPullsChanged: (pulls: ModelPull[]) => void;
  onInstalledChanged: (serverId: string) => void;
  /** True while a download to a saved server runs: that server's Ollama stops it if this computer sleeps. */
  keepAwake?: (on: boolean) => void;
  /** The main log. */
  warn: (message: string) => void;
  /** Minimum gap between progress pushes (ms). */
  progressIntervalMs?: number;
  /** Pauses between reads of a just-pulled model (ms); one more read than pauses. */
  checkBackoffMs?: readonly number[];
}

const DEFAULT_PROGRESS_INTERVAL_MS = 250;
// Ollama 0.40 holds /api/show on a just-pulled model for about 15 s on a busy host, then answers in milliseconds.
const CHECK_TIMEOUT_MS = 30_000;
const DEFAULT_CHECK_BACKOFF_MS = [1_000, 3_000];
const SEARCH_LIMIT = 30;
const OLLAMA_LIBRARY_URL = 'https://ollama.com/library';

const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const hubBuildId = (path: string) => path.replace(/\.gguf$/i, '');

const EXPLORE_HINT = ' You can still review the repo in Explore.';
const LAYERS_CHANGED =
  "This model's weights, chat template, settings or license changed at its source since Bike4Mind reviewed it, " +
  'so Curated does not offer it.';
const LICENSE_CHANGED =
  'The license this model or its base model declares on Hugging Face changed since Bike4Mind reviewed it, so ' +
  'Curated does not offer it.' +
  EXPLORE_HINT;
const NOW_ABLITERATED = 'Hugging Face now marks this repo as abliterated, so Curated does not offer it.';

const licenseSet = (ids: readonly string[]) => [...new Set(ids.map(id => id.toLowerCase()))].sort().join(',');

/** Waits `ms`; false when `signal` aborts first. */
function pause(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve(false);
    const stop = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve(true);
    }, ms);
    signal.addEventListener('abort', stop, { once: true });
  });
}

/** Cold-cache /api/show reads in flight at once, so a long installed list does not swamp a busy daemon. */
const INSPECT_CONCURRENCY = 4;

async function mapLimited<T, R>(items: readonly T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await map(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** `listed` keeps the failure in the pull list, as a failed download rather than a refused one. */
type Refusal = { ok: false; error: ModelHubError; listed: boolean };
type Prepared = { ok: true; ref: string } | Refusal;
const refused = (kind: ModelHubErrorKind, message: string, listed = false): Refusal => ({
  ok: false,
  error: hubError(kind, message),
  listed,
});

/** Refuses a download unless the target's Ollama is running and, for a curated build, new enough for it. */
function runtimeRefusal(health: RuntimeHealth, build: HubBuild | null, target: Target): Refusal | null {
  if (!health.ok)
    return refused(
      'runtime-unavailable',
      target.local
        ? 'Ollama is not running. Start it, then retry.'
        : (health.error ?? `Could not reach ${target.name}. Check it, then retry.`),
      true
    );
  const blocked = build && ollamaBlocked(build, health.version);
  const where = target.local ? 'Ollama' : `Ollama on ${target.name}`;
  return blocked ? refused('cannot-pull', `${blocked}. Update ${where}, then download it.`) : null;
}

interface Target extends ModelHubServer {
  id: string;
  local: boolean;
}

// Printable ASCII with no spaces: anything else cannot be sent as a header and is not a Hub token.
const TOKEN_RE = /^[\x21-\x7e]{8,256}$/;

interface PullEntry {
  view: ModelPull;
  controller: AbortController;
  /** The verified name Ollama pulls; a resume asks for the same one. */
  ref: string | null;
  /** Why the pull was stopped when its server was removed or set to no longer allow it. */
  stopped?: ModelHubError;
  /** The reviewed build a Curated pull is checked against once it lands, and whether its tag was there before. */
  curated: { entry: HubEntry; build: HubBuild; hadTag: boolean | null } | null;
}

/** Per server: two servers can each hold the same tag. */
const tagKey = (target: Target, ref: string) => `${target.id}\0${ref.toLowerCase()}`;

/** A re-pulled tag changes its modified time or size, so it is read again. */
const archKey = (target: Target, model: InstalledModel) =>
  `${target.id}\0${model.name}\0${model.modifiedAt ?? ''}\0${model.sizeBytes}`;

const SERVER_GONE = 'That model server is no longer saved. Pick another under Models.';

interface HubSession {
  hub: ModelHubPort;
  token: boolean;
}

function hubError(kind: ModelHubErrorKind, message: string, retryAfterMs?: number | null): ModelHubError {
  return retryAfterMs === undefined ? { kind, message } : { kind, message, retryAfterMs };
}

/**
 * Maps local-models errors, which never carry the Hugging Face token, onto what the screen explains. `tokenSent`:
 * the request carried the saved token, so a refusal is about that token.
 */
export function toModelHubError(error: unknown, tokenSent = false): ModelHubError {
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
  const fromRegistry = error instanceof LocalRuntimeError && error.runtimeId === 'ollama-registry';
  if (error instanceof HubRateLimitError)
    return hubError('rate-limited', 'Hugging Face is rate limiting this computer.', error.retryAfterMs);
  if (error instanceof HubAccessError)
    return tokenSent
      ? hubError(
          'token-rejected',
          'Hugging Face refused your token for this repo: it is invalid or lacks access. Request access on the repo ' +
            'page, or replace the token.'
        )
      : hubError('gated', 'Hugging Face refused access to this repo. Request access on its page first.');
  if (error instanceof ModelNotFoundError)
    return !fromHub
      ? hubError('not-found', `Ollama has no model named ${error.model}.`)
      : tokenSent
        ? hubError(
            'not-found',
            `Hugging Face has no repo named ${error.model} that your token can read. The repo may not exist, or the ` +
              'token is invalid or lacks access to it.'
          )
        : hubError('not-found', `Hugging Face has no public repo named ${error.model}.`);
  if (error instanceof RuntimeConnectionError)
    return fromHub
      ? hubError('hub-unreachable', 'Could not reach Hugging Face. Check your connection and try again.')
      : hubError('runtime-unavailable', fromRegistry ? 'Could not reach ollama.com.' : 'Could not reach Ollama.');
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

/** Ollama answers a gated or private pull its own key cannot sign with the registry's 401 or 403. */
function pullAuthError(error: unknown, target: Target): ModelHubError | null {
  if (!(error instanceof LocalRuntimeError) || error.runtimeId.startsWith('huggingface')) return null;
  if (!/: pull model manifest: 40[13]\b/.test(error.message)) return null;
  const key = target.local
    ? "add Ollama's public key (usually ~/.ollama/id_ed25519.pub)"
    : `add the public key of Ollama on ${target.name}, not this computer's,`;
  return hubError(
    'gated',
    `Hugging Face refused Ollama's download. Ollama signs in with its own key, not your token: ${key} at ` +
      'huggingface.co/settings/keys on the account that has access, then download again.'
  );
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

function blockedReason(detail: HubModelDetail, build: HubGgufBuild, tokenSent: boolean): string | null {
  if (build.split) return 'Split into several files, which Ollama cannot pull from Hugging Face.';
  if (!build.complete) return 'Some of its files are missing from the repo.';
  if (build.ollamaRefIssue === 'no-quant-label') return 'Its file name has no quant label Ollama can pull by.';
  if (build.ollamaRefIssue === 'unsupported-name') return "Its repo or file name breaks Ollama's naming rules.";
  if (build.ollamaRefIssue === 'unsupported-quant') return 'Ollama cannot pull this quant from Hugging Face yet.';
  if (!build.files[0]?.sha256)
    return !detail.ollamaNeedsSshKey
      ? 'Hugging Face lists no checksum for this file, so the download cannot be verified.'
      : tokenSent
        ? 'Needs access: your Hugging Face token cannot read this file yet. Request access on the repo page.'
        : 'Needs access: add a Hugging Face token from an account that has been granted access.';
  return null;
}

function hubAccess(detail: HubModelDetail, tokenSent: boolean): HubAccess {
  if (!tokenSent) return 'no-token';
  if (detail.canDownload === null) return 'unknown';
  return detail.canDownload ? 'granted' : 'denied';
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

function projectorBytes(detail: HubModelDetail): number | null {
  return detail.projectors.length ? Math.max(...detail.projectors.map(entry => entry.sizeBytes)) : null;
}

function toView(
  endpoint: string,
  detail: HubModelDetail,
  tokenSent: boolean,
  fit: (build: HubGgufBuild) => ModelFit | null
): HubModelView {
  const builds: HubBuildView[] = detail.builds.map(build => ({
    id: build.id,
    label: build.label,
    sizeBytes: build.sizeBytes,
    ollamaRef: build.ollamaRef && ollamaPullRef(build.ollamaRef, detail.ollamaNeedsSshKey),
    installedNames: build.ollamaRef ? ollamaRefAliases(build.ollamaRef) : [],
    blockedReason: blockedReason(detail, build, tokenSent),
    fit: fit(build),
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
    projectorBytes: projectorBytes(detail),
    needsAccess: detail.ollamaNeedsSshKey,
    hubAccess: hubAccess(detail, tokenSent),
  };
}

/** The pull dialog's view of a library build, which has no Hugging Face repo behind it. */
function libraryView(
  entry: HubEntry,
  build: HubBuild,
  fit: ModelFit | null
): { model: HubModelView; build: HubBuildView } {
  const library = libraryOf(build);
  if (!library) throw new Error(`${entry.id}/${build.id} is not an Ollama library build`);
  const view: HubBuildView = {
    id: build.id,
    label: build.quant.label,
    sizeBytes: library.sizeBytes,
    ollamaRef: library.ref,
    installedNames: ollamaRefAliases(library.ref),
    blockedReason: null,
    fit,
  };
  return {
    model: {
      id: library.ref,
      author: null,
      downloads: null,
      likes: null,
      updatedAt: null,
      licenses: [entry.license.id],
      gated: false,
      private: false,
      abliterated: false,
      url: `${OLLAMA_LIBRARY_URL}/${library.ref}`,
      revision: library.digest,
      licenseNames: [entry.license.id],
      licenseUrl: entry.license.source,
      licenseHost: new URL(entry.license.source).host,
      licenseKind: permissive(entry) ? 'permissive' : 'restricted',
      baseModels: [entry.lineage.base],
      builds: [view],
      // The library's size already includes the projector.
      projectorBytes: null,
      needsAccess: false,
      hubAccess: 'no-token',
    },
    build: view,
  };
}

function phaseOf(status: string): ModelPull['phase'] {
  return status.startsWith('verifying') || status.startsWith('writing') || status === 'success'
    ? 'finishing'
    : 'downloading';
}

interface Sizing {
  hardware: HardwareProfile;
  setting: LocalContextSetting;
  /** What chat sizes num_ctx from: this computer's hardware, or null on a saved server, which chat never measures. */
  chatHardware: HardwareProfile | null;
  rating: 'probe' | 'entered';
}

/** The num_ctx OllamaLocal would send this model with, so a badge rates the load chat makes. */
function chatContext(
  { chatHardware, setting }: Sizing,
  arch: LocalModelFootprint['arch'],
  weightsBytes: number,
  bounds: { modelLimit?: number; configured?: number }
): number {
  return chatContextTokens({ setting, footprint: { arch, weightsBytes, hardware: chatHardware }, ...bounds });
}

/** A reviewed build's fit from its layer shapes, pinned projector and num_ctx; its row and its pull dialog share it. */
function reviewedFit(entry: HubEntry, build: HubBuild, sizing: Sizing): ModelFit {
  const library = libraryOf(build);
  // The library's size already includes the projector; Hugging Face weight sizes leave it out.
  const weights = library ? library.sizeBytes : (build.weights[0]?.sizeBytes ?? 0);
  const projector = library ? 0 : (pinsOf(build)?.projectorBytes ?? 0);
  const context = chatContext(sizing, entry.arch, weights + projector, {
    configured: pinsOf(build)?.numCtx ?? undefined,
  });
  return fitFromArch(entry.arch, weights, sizing.hardware, context, { mmprojBytes: projector });
}

/**
 * Installed models, Hugging Face search and pulls for the Ollama daemon Desktop chats with, and for each saved
 * model server set to "Chat and manage". Every call names its server; omitted means this computer.
 */
export class ModelHubService {
  readonly #deps: ModelHubServiceDeps;
  readonly #pulls = new Map<string, PullEntry>();
  readonly #progressIntervalMs: number;
  readonly #checkBackoffMs: readonly number[];
  /** Curated pulls Ollama could not describe, by tagKey, with whether the tag was there before. */
  readonly #unverified = new Map<string, boolean | null>();
  /** In-flight Check again runs by tagKey; one build can show in two rows, and two checks race to remove. */
  readonly #checks = new Map<string, Promise<CuratedCheckResult>>();
  /** The hf.co ref each curated Hugging Face build was last pulled under, by entry and build id. */
  readonly #pulledRefs = new Map<string, string>();
  /** Installed models' layer shapes by archKey. */
  readonly #archs = new Map<
    string,
    Promise<{ arch: ModelArch | null; parameters: string | null; contextLength: number | null } | null>
  >();
  #hardware: Promise<HardwareProfile> | null = null;
  #lastPush = 0;
  #pushTimer: ReturnType<typeof setTimeout> | null = null;
  #awake = false;
  #disposed = false;
  #session: Promise<HubSession> | null = null;
  #tokenMutation: Promise<unknown> = Promise.resolve();

  constructor(deps: ModelHubServiceDeps) {
    this.#deps = deps;
    this.#progressIntervalMs = deps.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
    this.#checkBackoffMs = deps.checkBackoffMs ?? DEFAULT_CHECK_BACKOFF_MS;
  }

  #machine(): Promise<HardwareProfile> {
    this.#hardware ??= this.#deps.hardware();
    return this.#hardware;
  }

  /** This computer, with any hardware entered for it in Settings in place of the probe. */
  async #localSizing(): Promise<Sizing> {
    const [probed, setting] = await Promise.all([this.#machine(), this.#deps.localContext()]);
    const specs = this.#deps.specs?.(LOCAL_SERVER_ID) ?? null;
    const hardware = withEnteredSpecs(probed, specs);
    return { hardware, setting, chatHardware: hardware, rating: specsRate(specs) ? 'entered' : 'probe' };
  }

  /** Null for a saved server without entered hardware: its models are not rated. */
  async #sizing(target: Target): Promise<Sizing | null> {
    if (target.local) return this.#localSizing();
    const hardware = serverHardware(this.#deps.specs?.(target.id) ?? null);
    // Chat sends a saved server the Auto floor whatever the Settings choice, having no measure of it.
    return hardware ? { hardware, setting: AUTO_LOCAL_CONTEXT, chatHardware: null, rating: 'entered' } : null;
  }

  async #installedFit(
    target: Target,
    model: InstalledModel,
    sizing: Sizing,
    keep: Set<string>
  ): Promise<ModelFit | null> {
    const { hardware } = sizing;
    if (!model.sizeBytes) return null;
    const key = archKey(target, model);
    keep.add(key);
    let shown = this.#archs.get(key);
    if (!shown) {
      // The installed list was just read, so skip inspect's own re-read of it.
      shown = target.runtime
        .inspect(model.name, { tags: false })
        .then(inspection => ({
          arch: inspection.arch,
          parameters: inspection.parameters ?? null,
          contextLength: inspection.contextLength ?? null,
        }))
        .catch(() => {
          // A busy daemon can time out once; read it again next time instead of rating by size for the session.
          this.#archs.delete(key);
          return null;
        });
      this.#archs.set(key, shown);
    }
    const inspection = await shown;
    const arch = inspection?.arch ?? null;
    const limit = arch?.contextMax ?? inspection?.contextLength ?? undefined;
    // Ollama's tag size already includes any projector, as it does for chat's own sizing.
    const context = chatContext(sizing, arch, model.sizeBytes, {
      modelLimit: inspection?.contextLength ?? undefined,
      configured: configuredNumCtx(inspection?.parameters),
    });
    return arch
      ? fitFromArch(arch, model.sizeBytes, hardware, context)
      : fitFromSize(model.sizeBytes, hardware, context, { limitKnown: limit !== undefined });
  }

  /** A reviewed curated file is rated as its Curated row is; any other file falls back to its size. */
  #buildFit(
    detail: HubModelDetail,
    sizing: Sizing | null,
    manifest: HubManifest
  ): (build: HubGgufBuild) => ModelFit | null {
    const projector = projectorBytes(detail) ?? 0;
    return build => {
      if (!sizing || build.sizeBytes <= 0) return null;
      const file = build.files.length === 1 ? build.files[0] : null;
      for (const entry of manifest.entries)
        for (const reviewed of entry.builds) {
          const weights = reviewed.weights[0];
          if (
            reviewed.hf &&
            sameRepo(reviewed.hf.repo, detail.id) &&
            weights?.path.toLowerCase() === file?.path.toLowerCase() &&
            weights.sha256 === file?.sha256 &&
            weights.sizeBytes === file?.sizeBytes
          )
            return reviewedFit(entry, reviewed, sizing);
        }
      const limit = detail.gguf?.contextLength ?? undefined;
      const context = chatContext(sizing, null, build.sizeBytes + projector, { modelLimit: limit });
      return fitFromSize(build.sizeBytes + projector, sizing.hardware, context, { limitKnown: limit !== undefined });
    };
  }

  #reviewed(manifest: HubManifest, entryId: string, buildId: string): { entry: HubEntry; build: HubBuild } | null {
    const entry = manifest.entries.find(candidate => candidate.id === entryId && listable(candidate, manifest));
    const build = entry?.builds.find(candidate => candidate.id === buildId && pullable(candidate));
    return entry && build ? { entry, build } : null;
  }

  /** Refuses unless the registry serves the reviewed weights and pinned layers; `tag` is the hf.co tag. */
  async #checkLayers(reviewed: HubBuild, tag: string | null, signal?: AbortSignal): Promise<ModelHubError | null> {
    const library = libraryOf(reviewed);
    const hint = library ? '' : EXPLORE_HINT;
    let live: OllamaRegistryLayers | null;
    if (library) live = await this.#deps.libraryLayers(library.ref, { signal });
    else if (reviewed.hf && tag) live = await (await this.#hub()).hub.ollamaLayers(reviewed.hf.repo, tag, { signal });
    else return hubError('cannot-pull', 'Bike4Mind has no reviewed source for this build, so it cannot be checked.');
    if (!live)
      return hubError(
        'upstream-changed',
        library
          ? `The Ollama library no longer serves ${library.ref}, so Curated cannot offer it.`
          : `Hugging Face no longer serves the ${reviewed.quant.label} build of this repo to Ollama, so Curated ` +
              `cannot offer it.${hint}`
      );
    return servesReviewed(live, reviewed) ? null : hubError('upstream-changed', LAYERS_CHANGED + hint);
  }

  /** Refuses unless the repo's card and its base model's card declare the reviewed licenses, no more, no fewer. */
  async #checkLicenses(entry: HubEntry, detail: HubModelDetail, signal?: AbortSignal): Promise<ModelHubError | null> {
    if (licenseSet(detail.licenses) !== licenseSet([entry.license.cardTag ?? entry.license.id]))
      return hubError('upstream-changed', LICENSE_CHANGED);
    const base = await (await this.#hub()).hub.getModel(entry.lineage.base, { signal });
    return licenseSet(base.licenses) === licenseSet([entry.license.base.id])
      ? null
      : hubError('upstream-changed', LICENSE_CHANGED);
  }

  /**
   * After a curated pull: removes the model only when Ollama definitely installed something other than the reviewed
   * build, since the registry can change between the check and Ollama's own read, and never a tag it already had.
   */
  async #checkInstalled(
    target: Target,
    reviewed: HubBuild,
    ref: string,
    hadTag: boolean | null,
    signal: AbortSignal
  ): Promise<ModelHubError | null> {
    const key = tagKey(target, ref);
    const found = await this.#inspectPulled(target, ref, signal);
    // A 404 clears the warning only when the list agrees the model is gone; otherwise it stays unverified.
    if (found === 'missing' && (await this.#hasTag(target, ref)) === false) {
      this.#unverified.delete(key);
      return null;
    }
    const inspection = found === 'missing' ? null : found;
    if (!inspection) {
      this.#unverified.set(key, hadTag);
      const why = signal.aborted
        ? `Download cancelled while Bike4Mind was checking ${ref}, so it was not compared with the reviewed build.`
        : `Ollama could not describe ${ref} after downloading it, so Bike4Mind could not check it against the ` +
          'reviewed build.';
      return hubError('unverified', `${why} It is still installed; remove it from Installed unless you trust it.`);
    }
    this.#unverified.delete(key);
    if (installedReviewed(inspection, reviewed)) return null;
    const changed = (outcome: string) =>
      hubError('upstream-changed', `${LAYERS_CHANGED} ${outcome}${libraryOf(reviewed) ? '' : EXPLORE_HINT}`);
    if (hadTag !== false)
      return changed(
        hadTag
          ? `${ref} was installed before this download, so Bike4Mind left it in place.`
          : `Bike4Mind could not tell whether ${ref} was installed before this download, so it left it in place.`
      );
    try {
      await target.runtime.remove(ref);
    } catch {
      return changed(
        `Bike4Mind could not remove it, so the unreviewed model ${ref} is still installed. Remove it from Installed.`
      );
    }
    return changed('Bike4Mind removed what Ollama downloaded.');
  }

  /**
   * Reads a just-pulled model, retrying a failed or slow read; null once the reads run out or `signal` aborts, and
   * 'missing' at once when Ollama no longer has it (removed in Installed while the check was pending).
   */
  async #inspectPulled(target: Target, ref: string, signal: AbortSignal): Promise<ModelInspection | 'missing' | null> {
    const pauses = this.#checkBackoffMs;
    for (let attempt = 0; ; attempt++) {
      const started = Date.now();
      try {
        return await target.runtime.inspect(ref, { tags: false, signal, timeoutMs: CHECK_TIMEOUT_MS });
      } catch (error) {
        if (error instanceof ModelNotFoundError) return 'missing';
        const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        this.#deps.warn(
          `MODELS: could not describe ${ref}${target.local ? '' : ` on ${target.id}`} after its download ` +
            `(read ${attempt + 1} of ${pauses.length + 1}, ` +
            `${Date.now() - started}ms): ${reason}`
        );
      }
      if (attempt >= pauses.length || !(await pause(pauses[attempt], signal))) return null;
    }
  }

  /** Re-runs the post-download check on an installed curated build that Ollama could not describe. */
  async checkCurated(entryId: string, buildId: string, serverId?: string): Promise<CuratedCheckResult> {
    const target = this.#target(serverId);
    if (!target) return { ok: false, error: hubError('not-found', SERVER_GONE) };
    // The check can remove what it finds, so it needs the same access a removal does.
    const refusal = manageRefusal(target);
    if (refusal) return { ok: false, error: refusal };
    const picked = this.#reviewed(this.#deps.curated(), entryId, buildId);
    if (!picked) return { ok: false, error: hubError('not-found', 'That model is not on the list.') };
    const { build } = picked;
    const ref = libraryOf(build)?.ref ?? this.#hfRef(entryId, build);
    const key = tagKey(target, ref);
    const running = this.#checks.get(key);
    if (running) return running;
    const check = this.#recheck(target, build, ref).finally(() => this.#checks.delete(key));
    this.#checks.set(key, check);
    return check;
  }

  async #recheck(target: Target, build: HubBuild, ref: string): Promise<CuratedCheckResult> {
    const hadTag = this.#unverified.get(tagKey(target, ref)) ?? null;
    const error = await this.#checkInstalled(target, build, ref, hadTag, new AbortController().signal);
    for (const [key, entry] of this.#pulls) {
      if (entry.view.phase !== 'failed' || entry.view.serverId !== target.id) continue;
      if (entry.view.ref?.toLowerCase() !== ref.toLowerCase()) continue;
      if (error) this.#fail(key, entry, error);
      else this.#drop(key, entry);
    }
    this.#deps.onInstalledChanged(target.id);
    return error ? { ok: false, error } : { ok: true };
  }

  /** Whether `ref` was installed before this pull; after an unverified pull the list shows the tag Bike4Mind added. */
  async #hadTagBefore(target: Target, ref: string): Promise<boolean | null> {
    const key = tagKey(target, ref);
    return this.#unverified.has(key) ? (this.#unverified.get(key) ?? null) : this.#hasTag(target, ref);
  }

  /** Whether the target's Ollama lists `ref`; null when the list cannot be read. */
  async #hasTag(target: Target, ref: string): Promise<boolean | null> {
    const models = await target.runtime.list().catch(() => null);
    return models && models.some(model => model.name.toLowerCase() === ref.toLowerCase());
  }

  /** verifyOllamaRef's tag when this build was pulled this session, else the tag its quant label implies. */
  #hfRef(entryId: string, build: HubBuild): string {
    return this.#pulledRefs.get(`${entryId}\0${build.id}`) ?? `hf.co/${build.hf?.repo ?? ''}:${build.quant.label}`;
  }

  #curatedBuild(entry: HubEntry, build: HubBuild, sizing: Sizing, version: string | null): CuratedBuildView {
    const { repo, pullBuildId, sizeBytes, ollamaRef } = curatedSource(build);
    return {
      id: build.id,
      repo,
      pullBuildId,
      quant: build.quant.label,
      sizeBytes,
      ollamaRef: libraryOf(build) ? ollamaRef : this.#hfRef(entry.id, build),
      fit: reviewedFit(entry, build, sizing),
      blockedReason: ollamaBlocked(build, version),
    };
  }

  /** Recommended goes to the first pick, best first, that fits and can be downloaded here. */
  #picks(manifest: HubManifest, entries: readonly CuratedEntryView[], hardware: HardwareProfile): CuratedPickView[] {
    const shown = curatedPicks(manifest, hardware).picks.flatMap(({ pick }) => {
      const build = entries.find(entry => entry.id === pick.entry)?.builds.find(view => view.id === pick.build);
      return build ? [{ pick, build }] : [];
    });
    const recommended = shown.findIndex(({ build }) => build.fit.level !== 'too-large' && !build.blockedReason);
    return shown.map(({ pick }, index) => ({
      slot: pick.slot,
      entryId: pick.entry,
      buildId: pick.build,
      recommended: index === recommended,
    }));
  }

  /**
   * The list's source status is the caller's to add; this service only sees the manifest. Fit and picks rate the
   * server's entered hardware, or this computer when it has none; `serverId` also sets which Ollama version decides
   * what can be downloaded.
   */
  async curated(serverId?: string): Promise<Omit<CuratedList, 'source'>> {
    const manifest = this.#deps.curated();
    const target = this.#target(serverId);
    const [rated, health, { hub }] = await Promise.all([
      target ? this.#sizing(target) : null,
      target
        ? target.runtime.health()
        : Promise.resolve<RuntimeHealth>({ ok: false, version: null, error: SERVER_GONE }),
      this.#hub(),
    ]);
    const sizing = rated ?? (await this.#localSizing());
    const { hardware } = sizing;
    const version = health.ok ? health.version : null;
    const entries = curatedListing(manifest).map(({ entry, builds }): CuratedEntryView => {
      const library = entry.builds.map(libraryOf).find(source => source !== null);
      const repo = entry.builds.find(build => build.hf)?.hf?.repo;
      return {
        id: entry.id,
        name: entry.name,
        why: entry.why,
        params: paramsLabel(entry),
        licenseName: entry.license.id,
        licenseUrl: entry.license.source,
        licenseKind: permissive(entry) ? 'permissive' : 'restricted',
        thinking: entry.capabilities.thinking,
        vision: entry.capabilities.vision,
        code: entry.roles.includes('code'),
        tools: entry.capabilities.tools,
        toolUse: { rating: entry.toolUse.rating, note: entry.toolUse.note ?? null },
        sourceUrl: library
          ? `${OLLAMA_LIBRARY_URL}/${library.ref.slice(0, library.ref.indexOf(':'))}`
          : `${hub.endpoint}/${repo ?? ''}`,
        sourceName: library ? 'Ollama' : 'Hugging Face',
        builds: builds.map(build => this.#curatedBuild(entry, build, sizing, version)),
      };
    });
    return {
      updatedAt: manifest.updatedAt,
      rating: rated?.rating ?? null,
      machine: machineView(hardware),
      picks: this.#picks(manifest, entries, hardware),
      entries,
    };
  }

  /**
   * The pull dialog's view of a curated build, only while its source would still serve what was reviewed; `pull`
   * checks again when the request carries the curated identity.
   */
  async curatedPull(entryId: string, buildId: string, serverId?: string): Promise<CuratedPullResult> {
    const target = this.#target(serverId);
    if (!target) return { ok: false, error: hubError('not-found', SERVER_GONE) };
    const refusal = manageRefusal(target);
    if (refusal) return { ok: false, error: refusal };
    const manifest = this.#deps.curated();
    const picked = this.#reviewed(manifest, entryId, buildId);
    if (!picked) return { ok: false, error: hubError('not-found', 'That model is not on the list.') };
    const { entry, build: reviewed } = picked;
    let token = false;
    try {
      const [sizing, health, session] = await Promise.all([this.#sizing(target), target.runtime.health(), this.#hub()]);
      token = session.token;
      const { hub } = session;
      const runtime = runtimeRefusal(health, reviewed, target);
      if (runtime) return { ok: false, error: runtime.error };
      if (libraryOf(reviewed)) {
        const layers = await this.#checkLayers(reviewed, null);
        if (layers) return { ok: false, error: layers };
        return { ok: true, ...libraryView(entry, reviewed, sizing && reviewedFit(entry, reviewed, sizing)) };
      }
      const repo = reviewed.hf?.repo ?? '';
      const detail = await hub.getModel(repo);
      if (isAbliteratedModel(detail)) return { ok: false, error: hubError('upstream-changed', NOW_ABLITERATED) };
      const file = reviewed.weights[0];
      const live = detail.builds.find(candidate => candidate.id === hubBuildId(file.path));
      const liveFile = live?.files.length === 1 ? live.files[0] : undefined;
      if (!live || !liveFile || liveFile.sha256 !== file.sha256 || liveFile.sizeBytes !== file.sizeBytes)
        return {
          ok: false,
          error: hubError(
            'upstream-changed',
            `This file changed on Hugging Face since Bike4Mind reviewed it, so Curated does not offer it.${EXPLORE_HINT}`
          ),
        };
      const blocked = blockedReason(detail, live, token);
      if (blocked) return { ok: false, error: hubError('cannot-pull', blocked) };
      const licenses = await this.#checkLicenses(entry, detail);
      if (licenses) return { ok: false, error: licenses };
      const ref = await hub.verifyOllamaRef(detail, live);
      if (!ref)
        return {
          ok: false,
          error: hubError('unverified', 'Hugging Face could not confirm Ollama would get this exact file.'),
        };
      const refusal = await this.#checkLayers(reviewed, ref.slice(ref.lastIndexOf(':') + 1));
      if (refusal) return { ok: false, error: refusal };
      const model = toView(hub.endpoint, detail, token, this.#buildFit(detail, sizing, manifest));
      const build = model.builds.find(candidate => candidate.id === live.id);
      if (!build) return { ok: false, error: hubError('not-found', 'That build is no longer in this repo.') };
      const kind = permissive(entry) && model.licenseKind === 'permissive' ? 'permissive' : 'restricted';
      const projector = pinsOf(reviewed)?.projectorBytes ?? null;
      return { ok: true, model: { ...model, licenseKind: kind, projectorBytes: projector }, build };
    } catch (error) {
      return { ok: false, error: toModelHubError(error, token) };
    }
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

  #hub(): Promise<HubSession> {
    if (!this.#session) {
      const session = this.#deps.tokens
        .get()
        .then(token => ({ hub: this.#deps.createHub(token), token: token !== null }));
      this.#session = session;
      void session.catch(() => {
        if (this.#session === session) this.#session = null;
      });
    }
    return this.#session;
  }

  #mutateToken(operation: () => Promise<HfTokenResult>): Promise<HfTokenResult> {
    const result = this.#tokenMutation.then(operation);
    this.#tokenMutation = result.catch(() => undefined);
    return result;
  }

  async tokenStatus(): Promise<HfTokenStatus> {
    return { set: (await this.#hub()).token, persisted: this.#deps.tokens.persisted() };
  }

  /** Keeps `raw` only once Hugging Face has accepted it; searches and reads after that send it. */
  setToken(raw: string): Promise<HfTokenResult> {
    return this.#mutateToken(() => this.#setToken(raw));
  }

  async #setToken(raw: string): Promise<HfTokenResult> {
    const token = raw.trim();
    const malformed = hubError(
      'token-rejected',
      'That is not a Hugging Face token. Copy it again from huggingface.co/settings/tokens.'
    );
    if (!TOKEN_RE.test(token)) return { ok: false, error: malformed };
    let hub: ModelHubPort;
    try {
      hub = this.#deps.createHub(token);
    } catch {
      return { ok: false, error: malformed };
    }
    try {
      if (!(await hub.checkToken()))
        return {
          ok: false,
          error: hubError(
            'token-rejected',
            'Hugging Face did not accept this token. Check that you copied all of it and that it has not been revoked.'
          ),
        };
    } catch (error) {
      return { ok: false, error: toModelHubError(error) };
    }
    try {
      await this.#deps.tokens.set(token);
    } catch {
      return { ok: false, error: hubError('failed', 'Could not save the token. Try again.') };
    }
    this.#session = Promise.resolve({ hub, token: true });
    return { ok: true, status: await this.tokenStatus() };
  }

  /** The session only forgets the token once the stored one is gone, so a failed removal still shows it as set. */
  clearToken(): Promise<HfTokenResult> {
    return this.#mutateToken(() => this.#clearToken());
  }

  async #clearToken(): Promise<HfTokenResult> {
    try {
      await this.#deps.tokens.clear();
    } catch {
      return { ok: false, error: hubError('failed', 'Could not remove the token. Try again.') };
    }
    this.#session = Promise.resolve({ hub: this.#deps.createHub(null), token: false });
    return { ok: true, status: await this.tokenStatus() };
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
      let fits: (ModelFit | null)[] = models.map(() => null);
      const sizing = await this.#sizing(target);
      if (sizing) {
        const keep = new Set<string>();
        fits = await mapLimited(models, INSPECT_CONCURRENCY, model => this.#installedFit(target, model, sizing, keep));
        const prefix = `${target.id}\0`;
        for (const key of this.#archs.keys()) if (key.startsWith(prefix) && !keep.has(key)) this.#archs.delete(key);
      }
      return {
        ok: true,
        models: models
          .map((model, index) => ({ ...model, loaded: loadedNames.has(model.name), fit: fits[index] }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    } catch (error) {
      return { ok: false, error: toModelHubError(error) };
    }
  }

  async search(request: HubSearchRequest): Promise<HubSearchResult> {
    let token = false;
    try {
      const session = await this.#hub();
      token = session.token;
      const { hub } = session;
      const page = await hub.search({
        query: request.query,
        cursor: request.cursor ?? undefined,
        sort: 'downloads',
        limit: SEARCH_LIMIT,
      });
      return { ok: true, models: page.models.map(toCard), nextCursor: page.nextCursor };
    } catch (error) {
      return { ok: false, error: toModelHubError(error, token) };
    }
  }

  /** Fits rate `serverId`'s hardware, and are null for a saved server without entered hardware. */
  async detail(repo: string, serverId?: string): Promise<HubDetailResult> {
    let token = false;
    try {
      const session = await this.#hub();
      token = session.token;
      const { hub } = session;
      const target = this.#target(serverId);
      const [found, sizing] = await Promise.all([hub.getModel(repo), target ? this.#sizing(target) : null]);
      // A cached denial would outlive an access grant by up to the cache TTL; re-ask before saying "cannot read".
      const detail =
        token && hubAccess(found, token) === 'denied' ? await hub.getModel(repo, { refresh: true }) : found;
      return {
        ok: true,
        model: toView(hub.endpoint, detail, token, this.#buildFit(detail, sizing, this.#deps.curated())),
      };
    } catch (error) {
      return { ok: false, error: toModelHubError(error, token) };
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
    // One snapshot for every check below; a list update mid-pull applies to the next pull.
    const manifest = this.#deps.curated();
    const curated = request.curated ? this.#reviewed(manifest, request.curated.entryId, request.curated.buildId) : null;
    const offList = {
      ok: false,
      error: hubError('not-found', 'That model is not on the list.'),
      listed: false,
    } as const;
    if (request.curated && !curated) return offList;
    // A library build is named by its Ollama ref; anything else must be a repo id, so no key can pose as another's.
    if (!(curated && libraryOf(curated.build)?.ref === request.repo) && !isHubRepoId(request.repo))
      return curated ? offList : { ok: false, error: hubError('invalid', 'Invalid request.'), listed: false };
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
      curated: null,
      view: {
        key,
        serverId: target.id,
        serverName: target.name,
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
      return { ok: false, error: entry.stopped ?? error, listed: false };
    };

    let token = false;
    let prepared: Prepared;
    try {
      const session = await this.#hub();
      token = session.token;
      prepared =
        curated && libraryOf(curated.build)
          ? await this.#prepareLibrary(curated, request, entry, target, controller.signal)
          : await this.#prepareHub(session, request, curated, entry, target, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return refuse(hubError('cancelled', 'Download cancelled.'));
      return this.#fail(key, entry, toModelHubError(error, token));
    }
    if (controller.signal.aborted) return refuse(hubError('cancelled', 'Download cancelled.'));
    if (!prepared.ok) return prepared.listed ? this.#fail(key, entry, prepared.error) : refuse(prepared.error);
    const { ref } = prepared;

    const hadTag = curated ? await this.#hadTagBefore(target, ref) : null;
    if (controller.signal.aborted) return refuse(hubError('cancelled', 'Download cancelled.'));
    entry.ref = ref;
    entry.curated = curated && { ...curated, hadTag };
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
    const { curated } = entry;
    const { signal } = entry.controller;
    entry.view = { ...entry.view, ref, phase: 'downloading', error: null };
    this.#push(true);
    try {
      await target.runtime.pull(ref, {
        runner: curated ? curatedRunner(curated.build) : undefined,
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
      return this.#fail(
        key,
        entry,
        pullEofError(error, ref) ??
          pullAuthError(error, target) ??
          diskFullError(error, target) ??
          toModelHubError(error)
      );
    }
    if (curated && !libraryOf(curated.build)) this.#pulledRefs.set(`${curated.entry.id}\0${curated.build.id}`, ref);
    const installed = curated ? await this.#checkInstalled(target, curated.build, ref, curated.hadTag, signal) : null;
    this.#deps.onInstalledChanged(target.id);
    if (installed) return this.#fail(key, entry, installed);
    this.#drop(key, entry);
    return { ok: true, ref };
  }

  async #prepareHub(
    { hub, token }: HubSession,
    request: ModelPullRequest,
    curated: { entry: HubEntry; build: HubBuild } | null,
    entry: PullEntry,
    target: Target,
    signal: AbortSignal
  ): Promise<Prepared> {
    if (
      curated &&
      (!curated.build.hf ||
        !sameRepo(curated.build.hf.repo, request.repo) ||
        hubBuildId(curated.build.weights[0].path) !== request.buildId)
    )
      return refused('not-found', 'That model is not on the list.');
    // Read fresh: a card edit (say, a new license) is a new commit, and it must still be the one the dialog showed.
    const detail = await hub.getModel(request.repo, { refresh: true });
    if (signal.aborted) return refused('cancelled', 'Download cancelled.');
    const build = detail.builds.find((candidate: HubGgufBuild) => candidate.id === request.buildId);
    if (!build) return refused('not-found', 'That build is no longer in this repo.');
    if (detail.revision !== request.revision || build.sizeBytes !== request.sizeBytes)
      return refused(
        'changed',
        'This repo changed since you reviewed it. Click Download again to review it as it is now.'
      );
    if (curated) {
      if (isAbliteratedModel(detail)) return refused('upstream-changed', NOW_ABLITERATED);
      const licenses = await this.#checkLicenses(curated.entry, detail, signal);
      if (licenses) return { ok: false, error: licenses, listed: false };
    }
    const reason = blockedReason(detail, build, token);
    if (reason) return refused('cannot-pull', reason);
    const restricted = licenseKind(detail.licenses) === 'restricted' || (curated && !permissive(curated.entry));
    if (restricted && !request.acceptLicense)
      return refused('license-required', 'Accept the license before downloading.');
    if (detail.ollamaNeedsSshKey && !request.confirmAccess)
      return refused('access-required', 'Confirm the Hugging Face access steps before downloading.');
    entry.view = { ...entry.view, label: build.label, expectedBytes: build.sizeBytes };

    const health = await target.runtime.health();
    if (signal.aborted) return refused('cancelled', 'Download cancelled.');
    const runtime = runtimeRefusal(health, curated?.build ?? null, target);
    if (runtime) return runtime;
    // The registry serves the first file whose name ends with the tag; only its manifest proves which one.
    const ref = await hub.verifyOllamaRef(detail, build, { signal });
    if (signal.aborted) return refused('cancelled', 'Download cancelled.');
    if (!ref)
      return refused(
        'unverified',
        'Hugging Face could not confirm Ollama would get this exact file, so it was not downloaded.',
        true
      );
    if (curated) {
      const layers = await this.#checkLayers(curated.build, ref.slice(ref.lastIndexOf(':') + 1), signal);
      if (layers) return { ok: false, error: layers, listed: false };
    }
    return { ok: true, ref };
  }

  /** A library build has no Hugging Face repo: the reviewed manifest digest stands in for its revision. */
  async #prepareLibrary(
    curated: { entry: HubEntry; build: HubBuild },
    request: ModelPullRequest,
    entry: PullEntry,
    target: Target,
    signal: AbortSignal
  ): Promise<Prepared> {
    const library = libraryOf(curated.build);
    if (!library || request.repo !== library.ref || request.buildId !== curated.build.id)
      return refused('not-found', 'That model is not on the list.');
    if (request.revision !== library.digest || request.sizeBytes !== library.sizeBytes)
      return refused('changed', 'The curated list changed since you reviewed this model. Click Download again.');
    if (!permissive(curated.entry) && !request.acceptLicense)
      return refused('license-required', 'Accept the license before downloading.');
    entry.view = { ...entry.view, label: curated.build.quant.label, expectedBytes: library.sizeBytes };

    const health = await target.runtime.health();
    if (signal.aborted) return refused('cancelled', 'Download cancelled.');
    const runtime = runtimeRefusal(health, curated.build, target);
    if (runtime) return runtime;
    const layers = await this.#checkLayers(curated.build, null, signal);
    if (layers) return { ok: false, error: layers, listed: false };
    return { ok: true, ref: library.ref };
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
    this.#unverified.delete(tagKey(target, name));
    for (const [key, entry] of this.#pulls) {
      if (entry.view.phase !== 'failed' || entry.view.serverId !== target.id) continue;
      if (entry.view.ref?.toLowerCase() === name.toLowerCase()) this.#drop(key, entry);
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
