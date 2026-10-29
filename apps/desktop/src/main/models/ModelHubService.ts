import { createHash } from 'node:crypto';
import {
  HubAccessError,
  HubRateLimitError,
  LocalRuntimeError,
  ModelNotFoundError,
  RuntimeConnectionError,
  RuntimeHttpError,
  isAbliteratedModel,
  type HardwareProfile,
  ollamaPullRef,
  ollamaRefAliases,
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
import {
  CURATED_SLOTS,
  MIN_CHAT_CONTEXT,
  curatedTier,
  type HubBuild,
  type HubEntry,
  type HubManifest,
} from '@bike4mind/common';
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
} from '@shared/models';
import type { LocalContextSetting } from '@shared/localContextSetting';
import { chatContextTokens, type LocalModelFootprint } from '../chat/localContext';
import { configuredNumCtx } from '../chat/localChatContext';
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

export interface ModelHubServiceDeps {
  runtime: ModelRuntimePort;
  /** A Hub client sending `token`, if any; it must only ever be pointed at Hugging Face itself. */
  createHub: (token: string | null) => ModelHubPort;
  tokens: HubTokenPort;
  /** The layers the Ollama library serves for a `name:tag` ref; null when it has no such tag. */
  libraryLayers: (ref: string, options?: { signal?: AbortSignal }) => Promise<OllamaRegistryLayers | null>;
  /** Probed once, on first use. */
  hardware: () => Promise<HardwareProfile>;
  /** The Settings choice local chat sizes its context with; fit badges plan for that same context. */
  localContext: () => Promise<LocalContextSetting>;
  /** The Curated tab's list. */
  curated: HubManifest;
  onPullsChanged: (pulls: ModelPull[]) => void;
  onInstalledChanged: () => void;
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

function paramsLabel(entry: HubEntry): string {
  const { totalB, activeB } = entry.params;
  return activeB === null ? `${totalB}B` : `${totalB}B, ${activeB}B active`;
}

const permissive = (entry: HubEntry) =>
  entry.license.class === 'permissive' && entry.license.base.class === 'permissive';

const libraryOf = (build: HubBuild) => (build.ollama?.kind === 'library' ? build.ollama : null);
const pinsOf = (build: HubBuild) =>
  build.ollama?.kind === 'library' || build.ollama?.kind === 'hf-pull' ? build.ollama.layers : undefined;
const modelDigest = (build: HubBuild) => libraryOf(build)?.digest ?? build.weights[0]?.sha256;

/** Abliterated entries never reach Curated, whatever the manifest policy says. */
function listable(entry: HubEntry, manifest: HubManifest): boolean {
  if (entry.flags.abliterated || entry.lineage.variantType === 'abliterated' || entry.license.legal === 'blocked')
    return false;
  if (entry.roles.includes('chat') && entry.arch.contextMax < MIN_CHAT_CONTEXT) return false;
  const sources = entry.builds.map(build => build.hf?.repo ?? libraryOf(build)?.ref ?? '');
  if (isAbliteratedModel({ id: entry.id, tags: [entry.name, ...sources], baseModels: [entry.lineage.base] }))
    return false;
  return permissive(entry) || manifest.policy.restrictedLicense === 'curated-labelled';
}

// The library serves a tag whole; hf.co serves one file per tag, so only single-file builds without a separate
// projector qualify there, and only with the template pinned, since hf.co builds it from the repo's main branch.
function pullable(build: HubBuild): boolean {
  const pins = pinsOf(build);
  if (!pins) return false;
  if (libraryOf(build)) return true;
  return !!(pins.installedTemplate ?? pins.template) && !!build.hf && build.weights.length === 1 && !build.mmproj;
}

const OLLAMA_LAYER = 'application/vnd.ollama.image.';
const PINNED_LAYERS = ['template', 'params', 'license', 'projector', 'draft'] as const;
const EXPLORE_HINT = ' You can still review the repo in Explore.';
const LAYERS_CHANGED =
  "This model's weights, chat template, settings or license changed at its source since Bike4Mind reviewed it, " +
  'so Curated does not offer it.';
const LICENSE_CHANGED =
  'The license this model or its base model declares on Hugging Face changed since Bike4Mind reviewed it, so ' +
  'Curated does not offer it.' +
  EXPLORE_HINT;
const NOW_ABLITERATED = 'Hugging Face now marks this repo as abliterated, so Curated does not offer it.';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const licenseSet = (ids: readonly string[]) => [...new Set(ids.map(id => id.toLowerCase()))].sort().join(',');

/** True while the registry serves the reviewed weights and exactly the pinned other layers, nothing more. */
export function servesReviewed(live: OllamaRegistryLayers, reviewed: HubBuild): boolean {
  const pins = pinsOf(reviewed);
  if (!pins || !live.model || live.model !== modelDigest(reviewed)) return false;
  const expected = new Map<string, string>();
  for (const kind of PINNED_LAYERS) {
    const digest = pins[kind];
    if (digest) expected.set(`${OLLAMA_LAYER}${kind}`, digest);
  }
  const types = new Set(live.others.map(layer => layer.mediaType));
  return (
    types.size === live.others.length &&
    live.others.length === expected.size &&
    live.others.every(layer => expected.get(layer.mediaType) === layer.digest)
  );
}

/**
 * True when what Ollama installed is the reviewed weights, projector, draft, template, license and num_ctx.
 * Other params are covered by the registry check before the pull.
 */
export function installedReviewed(inspection: ModelInspection, reviewed: HubBuild): boolean {
  const pins = pinsOf(reviewed);
  const contents = inspection.contents;
  if (!pins || !contents || contents.modelBlob !== modelDigest(reviewed)) return false;
  if (contents.adapterBlobs?.length) return false;
  const matchesBlob = (actual: (string | null)[] | undefined, expected: string | null) =>
    expected ? actual?.length === 1 && actual[0] === expected : (actual?.length ?? 0) === 0;
  if (!matchesBlob(contents.projectorBlobs, pins.projector) || !matchesBlob(contents.draftBlobs, pins.draft))
    return false;
  // A library build with no template layer chats through Ollama's renderer, so /api/show has no template to compare.
  const template = pins.installedTemplate ?? pins.template;
  if (template && (contents.template === null || sha256(contents.template) !== template)) return false;
  if (pins.license ? contents.license === null || sha256(contents.license) !== pins.license : contents.license)
    return false;
  return (configuredNumCtx(inspection.parameters) ?? null) === pins.numCtx;
}

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

// Pre-release suffixes are dropped on purpose (0.32.12-rc1 meets a 0.32.12 floor); a dev build
// reporting 0.0.0 is blocked, which is the safe side.
const versionParts = (text: string) => /^v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim())?.slice(1).map(Number);

/** Why this Ollama cannot download the build; one with a minimum is blocked while Ollama reports no version. */
export function ollamaBlocked(build: HubBuild, version: string | null): string | null {
  const minimum = build.runtimeMin?.ollama;
  const want = minimum && versionParts(minimum);
  if (!minimum || !want) return null;
  const needs = `Needs Ollama ${minimum} or newer`;
  const have = version ? versionParts(version) : undefined;
  if (!have) return `${needs}, and Ollama did not report its version`;
  const differs = have.findIndex((part, index) => part !== want[index]);
  return differs !== -1 && have[differs] < want[differs] ? needs : null;
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

const smallestBuild = (entry: CuratedEntryView) => Math.min(...entry.builds.map(build => build.sizeBytes));

/** `listed` keeps the failure in the pull list, as a failed download rather than a refused one. */
type Refusal = { ok: false; error: ModelHubError; listed: boolean };
type Prepared = { ok: true; ref: string } | Refusal;
const refused = (kind: ModelHubErrorKind, message: string, listed = false): Refusal => ({
  ok: false,
  error: hubError(kind, message),
  listed,
});

/** Refuses a download unless Ollama is running and, for a curated build, new enough for it. */
function runtimeRefusal(health: RuntimeHealth, build: HubBuild | null): Refusal | null {
  if (!health.ok) return refused('runtime-unavailable', 'Ollama is not running. Start it, then retry.', true);
  const blocked = build && ollamaBlocked(build, health.version);
  return blocked ? refused('cannot-pull', `${blocked}. Update Ollama, then download it.`) : null;
}

// Printable ASCII with no spaces: anything else cannot be sent as a header and is not a Hub token.
const TOKEN_RE = /^[\x21-\x7e]{8,256}$/;

interface PullEntry {
  view: ModelPull;
  controller: AbortController;
}

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

/** Ollama answers a gated or private pull its own key cannot sign with the registry's 401 or 403. */
function pullAuthError(error: unknown): ModelHubError | null {
  if (!(error instanceof LocalRuntimeError) || error.runtimeId.startsWith('huggingface')) return null;
  if (!/: pull model manifest: 40[13]\b/.test(error.message)) return null;
  return hubError(
    'gated',
    "Hugging Face refused Ollama's download. Ollama signs in with its own key, not your token: add Ollama's public " +
      'key (usually ~/.ollama/id_ed25519.pub) at huggingface.co/settings/keys on the account that has access, then ' +
      'download again.'
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
function libraryView(entry: HubEntry, build: HubBuild, fit: ModelFit): { model: HubModelView; build: HubBuildView } {
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
}

/** The num_ctx OllamaLocal would send this model with, so a badge rates the load chat makes. */
function chatContext(
  { hardware, setting }: Sizing,
  arch: LocalModelFootprint['arch'],
  weightsBytes: number,
  bounds: { modelLimit?: number; configured?: number }
): number {
  return chatContextTokens({ setting, footprint: { arch, weightsBytes, hardware }, ...bounds });
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

/** Installed models, Hugging Face search and pulls for the Ollama daemon Desktop chats with. */
export class ModelHubService {
  readonly #deps: ModelHubServiceDeps;
  readonly #pulls = new Map<string, PullEntry>();
  readonly #progressIntervalMs: number;
  readonly #checkBackoffMs: readonly number[];
  /** Curated pulls Ollama could not describe, by lowercased ref, with whether the tag was there before. */
  readonly #unverified = new Map<string, boolean | null>();
  /** In-flight Check again runs by lowercased ref; one build can show in two rows, and two checks race to remove. */
  readonly #checks = new Map<string, Promise<CuratedCheckResult>>();
  /** The hf.co ref each curated Hugging Face build was last pulled under, by entry and build id. */
  readonly #pulledRefs = new Map<string, string>();
  /** Installed models' layer shapes, keyed by name, modified time and size so a re-pulled tag is read again. */
  readonly #archs = new Map<
    string,
    Promise<{ arch: ModelArch | null; parameters: string | null; contextLength: number | null } | null>
  >();
  #hardware: Promise<HardwareProfile> | null = null;
  #lastPush = 0;
  #pushTimer: ReturnType<typeof setTimeout> | null = null;
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

  async #sizing(): Promise<Sizing> {
    const [hardware, setting] = await Promise.all([this.#machine(), this.#deps.localContext()]);
    return { hardware, setting };
  }

  async #installedFit(model: InstalledModel, sizing: Sizing, keep: Set<string>): Promise<ModelFit | null> {
    const { hardware } = sizing;
    if (!model.sizeBytes) return null;
    const key = `${model.name}\0${model.modifiedAt ?? ''}\0${model.sizeBytes}`;
    keep.add(key);
    let shown = this.#archs.get(key);
    if (!shown) {
      // The installed list was just read, so skip inspect's own re-read of it.
      shown = this.#deps.runtime
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
  #buildFit(detail: HubModelDetail, sizing: Sizing): (build: HubGgufBuild) => ModelFit | null {
    const projector = projectorBytes(detail) ?? 0;
    return build => {
      if (build.sizeBytes <= 0) return null;
      const file = build.files.length === 1 ? build.files[0] : null;
      for (const entry of this.#deps.curated.entries)
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

  #reviewed(entryId: string, buildId: string): { entry: HubEntry; build: HubBuild } | null {
    const manifest = this.#deps.curated;
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
    reviewed: HubBuild,
    ref: string,
    hadTag: boolean | null,
    signal: AbortSignal
  ): Promise<ModelHubError | null> {
    const found = await this.#inspectPulled(ref, signal);
    // A 404 clears the warning only when the list agrees the model is gone; otherwise it stays unverified.
    if (found === 'missing' && (await this.#hasTag(ref)) === false) {
      this.#unverified.delete(ref.toLowerCase());
      return null;
    }
    const inspection = found === 'missing' ? null : found;
    if (!inspection) {
      this.#unverified.set(ref.toLowerCase(), hadTag);
      const why = signal.aborted
        ? `Download cancelled while Bike4Mind was checking ${ref}, so it was not compared with the reviewed build.`
        : `Ollama could not describe ${ref} after downloading it, so Bike4Mind could not check it against the ` +
          'reviewed build.';
      return hubError('unverified', `${why} It is still installed; remove it from Installed unless you trust it.`);
    }
    this.#unverified.delete(ref.toLowerCase());
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
      await this.#deps.runtime.remove(ref);
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
  async #inspectPulled(ref: string, signal: AbortSignal): Promise<ModelInspection | 'missing' | null> {
    const pauses = this.#checkBackoffMs;
    for (let attempt = 0; ; attempt++) {
      const started = Date.now();
      try {
        return await this.#deps.runtime.inspect(ref, { tags: false, signal, timeoutMs: CHECK_TIMEOUT_MS });
      } catch (error) {
        if (error instanceof ModelNotFoundError) return 'missing';
        const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        this.#deps.warn(
          `MODELS: could not describe ${ref} after its download (read ${attempt + 1} of ${pauses.length + 1}, ` +
            `${Date.now() - started}ms): ${reason}`
        );
      }
      if (attempt >= pauses.length || !(await pause(pauses[attempt], signal))) return null;
    }
  }

  /** Re-runs the post-download check on an installed curated build that Ollama could not describe. */
  async checkCurated(entryId: string, buildId: string): Promise<CuratedCheckResult> {
    const picked = this.#reviewed(entryId, buildId);
    if (!picked) return { ok: false, error: hubError('not-found', 'That model is not on the list.') };
    const { build } = picked;
    const ref = libraryOf(build)?.ref ?? this.#hfRef(entryId, build);
    const key = ref.toLowerCase();
    const running = this.#checks.get(key);
    if (running) return running;
    const check = this.#recheck(build, ref).finally(() => this.#checks.delete(key));
    this.#checks.set(key, check);
    return check;
  }

  async #recheck(build: HubBuild, ref: string): Promise<CuratedCheckResult> {
    const hadTag = this.#unverified.get(ref.toLowerCase()) ?? null;
    const error = await this.#checkInstalled(build, ref, hadTag, new AbortController().signal);
    for (const [key, entry] of this.#pulls) {
      if (entry.view.phase !== 'failed' || entry.view.ref?.toLowerCase() !== ref.toLowerCase()) continue;
      if (error) this.#fail(key, entry, error);
      else this.#drop(key, entry);
    }
    this.#deps.onInstalledChanged();
    return error ? { ok: false, error } : { ok: true };
  }

  /** Whether `ref` was installed before this pull; after an unverified pull the list shows the tag Bike4Mind added. */
  async #hadTagBefore(ref: string): Promise<boolean | null> {
    const key = ref.toLowerCase();
    return this.#unverified.has(key) ? (this.#unverified.get(key) ?? null) : this.#hasTag(ref);
  }

  /** Whether Ollama lists `ref`; null when the list cannot be read. */
  async #hasTag(ref: string): Promise<boolean | null> {
    const models = await this.#deps.runtime.list().catch(() => null);
    return models && models.some(model => model.name.toLowerCase() === ref.toLowerCase());
  }

  /** verifyOllamaRef's tag when this build was pulled this session, else the tag its quant label implies. */
  #hfRef(entryId: string, build: HubBuild): string {
    return this.#pulledRefs.get(`${entryId}\0${build.id}`) ?? `hf.co/${build.hf?.repo ?? ''}:${build.quant.label}`;
  }

  #curatedBuild(entry: HubEntry, build: HubBuild, sizing: Sizing, version: string | null) {
    const fit = reviewedFit(entry, build, sizing);
    const blockedReason = ollamaBlocked(build, version);
    const library = libraryOf(build);
    if (library)
      return {
        id: build.id,
        repo: library.ref,
        pullBuildId: build.id,
        quant: build.quant.label,
        sizeBytes: library.sizeBytes,
        ollamaRef: library.ref,
        fit,
        blockedReason,
      } satisfies CuratedBuildView;
    const repo = build.hf?.repo ?? '';
    const file = build.weights[0];
    return {
      id: build.id,
      repo,
      pullBuildId: hubBuildId(file.path),
      quant: build.quant.label,
      sizeBytes: file.sizeBytes + (pinsOf(build)?.projectorBytes ?? 0),
      ollamaRef: this.#hfRef(entry.id, build),
      fit,
      blockedReason,
    } satisfies CuratedBuildView;
  }

  /** Recommended goes to the first pick, best first, that fits and can be downloaded here. */
  #picks(entries: readonly CuratedEntryView[], hardware: HardwareProfile): CuratedPickView[] {
    const tier = curatedTier(this.#deps.curated.tiers, hardware);
    if (!tier) return [];
    const shown = tier.picks
      .map(pick => ({
        pick,
        build: entries.find(entry => entry.id === pick.entry)?.builds.find(build => build.id === pick.build),
      }))
      .filter((shownPick): shownPick is { pick: (typeof tier.picks)[number]; build: CuratedBuildView } =>
        Boolean(shownPick.build)
      )
      .sort((a, b) => CURATED_SLOTS.indexOf(a.pick.slot) - CURATED_SLOTS.indexOf(b.pick.slot));
    const recommended = shown.findIndex(({ build }) => build.fit.level !== 'too-large' && !build.blockedReason);
    return shown.map(({ pick }, index) => ({
      slot: pick.slot,
      entryId: pick.entry,
      buildId: pick.build,
      recommended: index === recommended,
    }));
  }

  async curated(): Promise<CuratedList> {
    const [sizing, health, { hub }] = await Promise.all([this.#sizing(), this.#deps.runtime.health(), this.#hub()]);
    const { hardware } = sizing;
    const manifest = this.#deps.curated;
    const version = health.ok ? health.version : null;
    const entries = manifest.entries
      .filter(entry => listable(entry, manifest))
      .map((entry): CuratedEntryView => {
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
          builds: entry.builds.filter(pullable).map(build => this.#curatedBuild(entry, build, sizing, version)),
        };
      })
      .filter(entry => entry.builds.length > 0)
      .sort((a, b) => smallestBuild(a) - smallestBuild(b));
    return {
      updatedAt: manifest.updatedAt,
      machine: machineView(hardware),
      picks: this.#picks(entries, hardware),
      entries,
    };
  }

  /**
   * The pull dialog's view of a curated build, only while its source would still serve what was reviewed; `pull`
   * checks again when the request carries the curated identity.
   */
  async curatedPull(entryId: string, buildId: string): Promise<CuratedPullResult> {
    const picked = this.#reviewed(entryId, buildId);
    if (!picked) return { ok: false, error: hubError('not-found', 'That model is not on the list.') };
    const { entry, build: reviewed } = picked;
    let token = false;
    try {
      const [sizing, health, session] = await Promise.all([this.#sizing(), this.#deps.runtime.health(), this.#hub()]);
      token = session.token;
      const { hub } = session;
      const runtime = runtimeRefusal(health, reviewed);
      if (runtime) return { ok: false, error: runtime.error };
      if (libraryOf(reviewed)) {
        const layers = await this.#checkLayers(reviewed, null);
        if (layers) return { ok: false, error: layers };
        return { ok: true, ...libraryView(entry, reviewed, reviewedFit(entry, reviewed, sizing)) };
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
      const model = toView(hub.endpoint, detail, token, this.#buildFit(detail, sizing));
      const build = model.builds.find(candidate => candidate.id === live.id);
      if (!build) return { ok: false, error: hubError('not-found', 'That build is no longer in this repo.') };
      const kind = permissive(entry) && model.licenseKind === 'permissive' ? 'permissive' : 'restricted';
      const projector = pinsOf(reviewed)?.projectorBytes ?? null;
      return { ok: true, model: { ...model, licenseKind: kind, projectorBytes: projector }, build };
    } catch (error) {
      return { ok: false, error: toModelHubError(error, token) };
    }
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
      const sizing = await this.#sizing();
      const keep = new Set<string>();
      const fits = await mapLimited(models, INSPECT_CONCURRENCY, model => this.#installedFit(model, sizing, keep));
      for (const key of this.#archs.keys()) if (!keep.has(key)) this.#archs.delete(key);
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

  async detail(repo: string): Promise<HubDetailResult> {
    let token = false;
    try {
      const session = await this.#hub();
      token = session.token;
      const { hub } = session;
      const [found, sizing] = await Promise.all([hub.getModel(repo), this.#sizing()]);
      // A cached denial would outlive an access grant by up to the cache TTL; re-ask before saying "cannot read".
      const detail =
        token && hubAccess(found, token) === 'denied' ? await hub.getModel(repo, { refresh: true }) : found;
      return { ok: true, model: toView(hub.endpoint, detail, token, this.#buildFit(detail, sizing)) };
    } catch (error) {
      return { ok: false, error: toModelHubError(error, token) };
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

    const curated = request.curated ? this.#reviewed(request.curated.entryId, request.curated.buildId) : null;
    if (request.curated && !curated) return refuse(hubError('not-found', 'That model is not on the list.'));

    let token = false;
    let prepared: Prepared;
    try {
      const session = await this.#hub();
      token = session.token;
      prepared =
        curated && libraryOf(curated.build)
          ? await this.#prepareLibrary(curated, request, entry, controller.signal)
          : await this.#prepareHub(session, request, curated, entry, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return refuse(hubError('cancelled', 'Download cancelled.'));
      return this.#fail(key, entry, toModelHubError(error, token));
    }
    if (controller.signal.aborted) return refuse(hubError('cancelled', 'Download cancelled.'));
    if (!prepared.ok) return prepared.listed ? this.#fail(key, entry, prepared.error) : refuse(prepared.error);
    const { ref } = prepared;

    const hadTag = curated ? await this.#hadTagBefore(ref) : null;
    if (controller.signal.aborted) return refuse(hubError('cancelled', 'Download cancelled.'));
    entry.view = { ...entry.view, ref, phase: 'downloading' };
    this.#push(true);
    try {
      await this.#deps.runtime.pull(ref, {
        // Pins are the GGUF child of a library manifest list; Apple Silicon Ollama would otherwise pick MLX.
        ...(curated && libraryOf(curated.build) ? { runner: 'llamacpp' } : {}),
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
      return this.#fail(key, entry, pullEofError(error, ref) ?? pullAuthError(error) ?? toModelHubError(error));
    }
    if (curated && !libraryOf(curated.build)) this.#pulledRefs.set(`${curated.entry.id}\0${curated.build.id}`, ref);
    const installed = curated ? await this.#checkInstalled(curated.build, ref, hadTag, controller.signal) : null;
    this.#deps.onInstalledChanged();
    if (installed) return this.#fail(key, entry, installed);
    this.#drop(key, entry);
    return { ok: true, ref };
  }

  async #prepareHub(
    { hub, token }: HubSession,
    request: ModelPullRequest,
    curated: { entry: HubEntry; build: HubBuild } | null,
    entry: PullEntry,
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

    const health = await this.#deps.runtime.health();
    if (signal.aborted) return refused('cancelled', 'Download cancelled.');
    const runtime = runtimeRefusal(health, curated?.build ?? null);
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

    const health = await this.#deps.runtime.health();
    if (signal.aborted) return refused('cancelled', 'Download cancelled.');
    const runtime = runtimeRefusal(health, curated.build);
    if (runtime) return runtime;
    const layers = await this.#checkLayers(curated.build, null, signal);
    if (layers) return { ok: false, error: layers, listed: false };
    return { ok: true, ref: library.ref };
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
    this.#unverified.delete(name.toLowerCase());
    for (const [key, entry] of this.#pulls) {
      if (entry.view.phase === 'failed' && entry.view.ref?.toLowerCase() === name.toLowerCase()) this.#drop(key, entry);
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
