import { createHash } from 'node:crypto';
import { z } from 'zod';
import { downloadFile, type DownloadOptions, type DownloadResult } from './download';
import {
  HubAccessError,
  HubRateLimitError,
  LocalRuntimeError,
  ModelNotFoundError,
  RuntimeConnectionError,
  RuntimeHttpError,
  RuntimeProtocolError,
} from './errors';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  assertHeaderValues,
  combinedSignal,
  describeError,
  parseJson,
  runtimeEndpointId,
  type HttpClient,
} from './http';
import type { FetchLike } from './types';

export const DEFAULT_HUGGING_FACE_ENDPOINT = 'https://huggingface.co';

/** Registry host Ollama pulls Hugging Face GGUFs from, as `hf.co/<repo>:<quant>`. */
export const OLLAMA_HUGGING_FACE_HOST = 'hf.co';

/** Manifest requests one `verifyOllamaRef` call may send. */
export const MAX_VERIFY_TAGS = 4;

/** Where a Hugging Face account adds the SSH key Ollama uses to pull gated and private repos. */
export const HUGGING_FACE_SSH_KEYS_URL = 'https://huggingface.co/settings/keys';

export const MAX_HUB_SEARCH_LIMIT = 100;
const DEFAULT_HUB_SEARCH_LIMIT = 20;
const MAX_QUERY_LENGTH = 200;
const MAX_TREE_PAGES = 20;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_REDIRECTS = 3;
const MAX_TAGS = 30;
const MAX_BASE_MODELS = 10;
const MAX_LICENSES = 10;
export const HUB_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 200;
const DEFAULT_MAX_RATE_LIMIT_WAIT_MS = 5_000;
const MAX_RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BACKOFF_MS = 500;

export type HubSort = 'downloads' | 'likes' | 'trending' | 'updated';

export type HubGated = false | 'auto' | 'manual';

export interface HuggingFaceHubOptions {
  /** Hub root, for mirrors and tests. */
  endpoint?: string;
  fetch?: FetchLike;
  /** Sent as `Authorization: Bearer <token>` to the endpoint only; never kept elsewhere or put in an error. */
  token?: string;
  /** Deadline per request (ms); a multi-page file listing gets it once per page. */
  requestTimeoutMs?: number;
  /**
   * Most a request waits in total before surfacing `HubRateLimitError`; it retries on 429 after `Retry-After`, and
   * rejects at once when the wait asked for would pass this. Default 5000; 0 never retries.
   */
  maxRateLimitWaitMs?: number;
}

export interface HubSearchOptions {
  query?: string;
  sort?: HubSort;
  /** 1 to `MAX_HUB_SEARCH_LIMIT`; default 20. */
  limit?: number;
  /** `nextCursor` of the previous page, sent with the same query and sort. */
  cursor?: string;
  /** Skip the 10-minute cache and store the fresh answer. */
  refresh?: boolean;
  signal?: AbortSignal;
}

export interface HubSearchPage {
  models: HubModelSummary[];
  nextCursor: string | null;
}

export interface HubModelSummary {
  id: string;
  author: string | null;
  downloads: number | null;
  likes: number | null;
  updatedAt: string | null;
  pipelineTag: string | null;
  gated: HubGated;
  private: boolean;
  /**
   * Every declared license id, lowercased and deduped, e.g. `['apache-2.0', 'gemma']`; empty when none is declared.
   * A repo that lists several is bound by all of them. `other` means the card names it in `licenseName`, or that
   * more were declared than are kept; a card with only a `license_name` reports `['other']`.
   */
  licenses: string[];
  /** Repos the GGUF was converted from, whose card and license usually govern it. */
  baseModels: string[];
  /** Tags without the `license:`, `base_model:`, `arxiv:` and `region:` bookkeeping. */
  tags: string[];
}

export interface HubModelOptions {
  /**
   * Branch, tag or commit sha; default `main`. Files, sizes and URLs are pinned to the commit it resolves to, but
   * Ollama refs always pull from `main`, so any other revision gets `ollamaRefIssue: 'pinned-revision'`.
   */
  revision?: string;
  /** Skip the 10-minute cache and store the fresh answer; use it before acting on what a user reviewed. */
  refresh?: boolean;
  signal?: AbortSignal;
}

export interface HubGgufFile {
  path: string;
  sizeBytes: number;
  /** LFS sha256; null when the Hub masks it (gated repo without access) or the file is not in LFS. */
  sha256: string | null;
  /** Resolve URL at the pinned revision. */
  url: string;
}

export interface HubGgufProjector extends HubGgufFile {
  quant: string | null;
}

/**
 * Why a build has no Ollama ref. Hugging Face's registry refuses sharded GGUFs, needs a quant scheme in the tag,
 * serves the first file in path order whose name ends with the tag (`ambiguous`: no tag reaches this one), and
 * resolves only `main`. `unsupported-name`: the repo id, or every tail of the file name, breaks Ollama's name rules.
 * `unsupported-quant`: no tail of the file name is a tag the registry accepts, because its quant label (e.g.
 * `Q4_K_L`) is rejected.
 */
export type OllamaRefIssue =
  | 'split'
  | 'incomplete'
  | 'no-quant-label'
  | 'unsupported-quant'
  | 'unsupported-name'
  | 'pinned-revision'
  | 'ambiguous';

export interface HubGgufBuild {
  /**
   * Path without `.gguf` and the shard suffix; unique within the repo. A split build whose merged file sits next to
   * it keeps its first shard's path instead.
   */
  id: string;
  /** Upper-case quant label read from the file name, e.g. `Q4_K_M` or `UD-Q4_K_XL`; `Q4_K_L` and kin are ours. */
  quant: string | null;
  /** The file, or every shard in order. */
  files: HubGgufFile[];
  sizeBytes: number;
  split: boolean;
  /** False when a split build is missing shards. */
  complete: boolean;
  /**
   * `hf.co/<repo>:<tag>` as planned from the file list. The registry also skips some files the list cannot tell
   * apart (draft and assistant models), and then the tag fails or falls through to a later file, so confirm with
   * `HuggingFaceHub.verifyOllamaRef` before pulling.
   */
  ollamaRef: string | null;
  ollamaRefIssue: OllamaRefIssue | null;
}

export interface HubGgufInfo {
  architecture: string | null;
  contextLength: number | null;
  parameterCount: number | null;
}

export interface HubModelDetail extends HubModelSummary {
  /** Commit sha that every path, size, sha256 and URL here was read at; Ollama refs resolve against `main`. */
  revision: string;
  licenseName: string | null;
  licenseLink: string | null;
  /** From the Hub's own read of the repo's GGUF headers; null when it has none. */
  gguf: HubGgufInfo | null;
  /** Smallest first. */
  builds: HubGgufBuild[];
  /** Vision projectors (`mmproj*.gguf`); Ollama's Hugging Face registry adds one of them to each pull. */
  projectors: HubGgufProjector[];
  /**
   * Whether the configured token can download the files: true when ungated, false when gated without a token,
   * otherwise the answer of a resolve HEAD. Null for a gated repo with no GGUF file to try.
   */
  canDownload: boolean | null;
  /**
   * True for a gated or private repo. Ollama pulls from hf.co with its own SSH key and never sees `token`, so the
   * Ollama host's public key (`~/.ollama/id_ed25519.pub`) must first be added at `HUGGING_FACE_SSH_KEYS_URL`
   * (Hugging Face Hub docs, "Use Ollama with any GGUF Model on Hugging Face Hub").
   */
  ollamaNeedsSshKey: boolean;
}

// The Hub labels a GGUF by the last quant scheme in its upper-cased file name (scheme list from huggingface.js
// packages/tasks/src/gguf.ts, plus the `_XL` schemes).
// Longest first, so Q4_0_4_4 is not read as Q4_0; the registry tells those apart.
const QUANT_SCHEMES = [
  'F32 F16 BF16 Q4_0 Q4_1 Q4_1_SOME_F16 Q4_2 Q4_3 Q8_0 Q5_0 Q5_1 Q2_K Q3_K_S Q3_K_M Q3_K_L Q4_K_S Q4_K_M Q5_K_S',
  'Q5_K_M Q6_K IQ2_XXS IQ2_XS Q2_K_S IQ3_XS IQ3_XXS IQ1_S IQ4_NL IQ3_S IQ3_M IQ2_S IQ2_M IQ4_XS IQ1_M Q4_0_4_4',
  'Q4_0_4_8 Q4_0_8_8 TQ1_0 TQ2_0 MXFP4_MOE MXFP4 NVFP4 Q1_0 Q2_0 Q2_K_XL Q3_K_XL Q4_K_XL Q5_K_XL Q6_K_XL Q8_K_XL',
].flatMap(line => line.split(' '));
const QUANT_SCHEME_RE = new RegExp(QUANT_SCHEMES.join('|'));
// bartowski's `_L` builds (the `_M` mix with Q8_0 embed/output weights). The registry rejects these as tags with
// "not a valid quantization scheme", so they are labelled but never get an Ollama ref.
const REGISTRY_REJECTED_QUANTS = new Set(['Q4_K_L', 'Q5_K_L', 'Q8_K_L']);
const QUANT_RE = new RegExp(
  `(?:UD-)?(?:${[...QUANT_SCHEMES, ...REGISTRY_REJECTED_QUANTS].sort((a, b) => b.length - a.length).join('|')})(?:_[A-Z]+)?`,
  'g'
);

// Ollama's tag rule (name.go): alphanumeric or `_` first, then `_ . -`, at most 80 characters.
const OLLAMA_TAG_RE = /^[A-Za-z0-9_][\w.-]{0,79}$/;
const OLLAMA_NAME_PART_MAX = 80;
const OLLAMA_MODEL_LAYER = 'application/vnd.ollama.image.model';
const REGISTRY_MANIFEST_ACCEPT = 'application/vnd.docker.distribution.manifest.v2+json';

const SHARD_RE = /-(\d{5})-of-(\d{5})\.gguf$/i;
const REPO_ID_RE = /^[A-Za-z0-9][\w.-]{0,95}\/[A-Za-z0-9][\w.-]{0,95}$/;
const REVISION_RE = /^[\w./-]{1,200}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const BOOKKEEPING_TAG_RE = /^(?:license|base_model|arxiv|region|doi):|^endpoints_compatible$/;

const SORT_PARAMS: Record<HubSort, string> = {
  downloads: 'downloads',
  likes: 'likes',
  trending: 'trendingScore',
  updated: 'lastModified',
};

const SUMMARY_FIELDS = ['author', 'downloads', 'likes', 'lastModified', 'gated', 'private', 'pipeline_tag', 'tags'];
const DETAIL_FIELDS = [...SUMMARY_FIELDS, 'sha', 'cardData', 'gguf'];

const optionalString = z.string().max(200).nullable().optional();
const optionalNumber = z.number().nullable().optional();

const modelEntrySchema = z.object({
  id: z.string().regex(REPO_ID_RE),
  author: optionalString,
  downloads: optionalNumber,
  likes: optionalNumber,
  lastModified: optionalString,
  gated: z.union([z.boolean(), z.string()]).nullable().optional(),
  private: z.boolean().nullable().optional(),
  pipeline_tag: optionalString,
  tags: z.array(z.unknown()).nullable().optional(),
});

const modelInfoSchema = modelEntrySchema.extend({
  sha: z.string().regex(COMMIT_RE),
  cardData: z.record(z.string(), z.unknown()).nullable().optional(),
  gguf: z.unknown().optional(),
});

const ggufInfoSchema = z.object({
  architecture: z.string().max(100).optional(),
  context_length: z.number().optional(),
  total: z.number().optional(),
});

const treeEntrySchema = z.object({
  type: z.string(),
  path: z
    .string()
    .max(1024)
    .refine(path => path.split('/').every(segment => segment && segment !== '.' && segment !== '..')),
  size: z.number().nonnegative().optional(),
  lfs: z.object({ oid: z.string().max(128), size: z.number().nonnegative() }).optional(),
});

const errorBodySchema = z.object({ error: z.string() });

const manifestSchema = z.object({
  layers: z.array(z.object({ mediaType: z.string(), digest: z.string() })),
});

type ModelEntry = z.infer<typeof modelEntrySchema>;
type TreeEntry = z.infer<typeof treeEntrySchema>;

interface RequestContext {
  method?: 'GET' | 'HEAD';
  signal?: AbortSignal;
  repo?: string;
  revision?: string;
  accept?: string;
  /** A registry manifest read, where 404 means "no such tag" rather than "no such repo". */
  manifest?: boolean;
}

/** The quant label the Hub shows for a GGUF file name. */
export function ggufQuantLabel(fileName: string): string | null {
  return ggufStem(fileName).toUpperCase().match(QUANT_RE)?.at(-1) ?? null;
}

/** File name without folders, shard suffix and `.gguf`: what the registry matches a tag's end against. */
function ggufStem(path: string): string {
  return path
    .replace(/^.*\//, '')
    .replace(SHARD_RE, '')
    .replace(/\.gguf$/i, '');
}

interface OllamaTagPlan {
  /** Tags to try, best first; when not `unique`, one works only if the registry skips the earlier files it matches. */
  tags: string[];
  unique: boolean;
}

const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const reversed = (text: string) => [...text].reverse().join('');

/**
 * Tails of the stem that Ollama and the registry accept as a tag, the quant label first, then shortest first. A tail
 * starts at a separator or after a character Ollama's tag charset lacks, e.g. the space in `Gemma3-270M Q8_0`.
 */
function ollamaTagCandidates(path: string, quant: string | null): string[] {
  if (!quant) return [];
  const stem = ggufStem(path);
  const starts = [0];
  for (let i = 0; i < stem.length; i++) if (!/[A-Za-z0-9]/.test(stem.charAt(i))) starts.push(i + 1);
  const tags = starts
    .reverse()
    .map(start => stem.slice(start))
    .filter(tail => OLLAMA_TAG_RE.test(tail) && QUANT_SCHEME_RE.test(tail.toUpperCase()))
    .map(tail => (tail.toUpperCase() === quant ? quant : tail));
  return tags.includes(quant) ? [quant, ...tags.filter(tag => tag !== quant)] : tags;
}

/**
 * For stems in path order, a lookup from a tag to the first stem that ends with it (case-insensitive), or Infinity:
 * reversed stems sorted so the ones ending with a tag form one range, and a sparse table for that range's minimum.
 */
function firstStemEndingWith(stems: readonly string[]): (tag: string) => number {
  const entries = stems
    .map((stem, index) => ({ key: reversed(stem.toUpperCase()), index }))
    .sort((a, b) => byCodeUnits(a.key, b.key));
  const keys = entries.map(entry => entry.key);
  const levels: number[][] = [entries.map(entry => entry.index)];
  for (let span = 1; span * 2 <= entries.length; span *= 2) {
    const previous = levels[levels.length - 1] ?? [];
    levels.push(
      previous.slice(0, previous.length - span).map((value, i) => Math.min(value, previous[i + span] ?? value))
    );
  }
  const lowerBound = (target: string) => {
    let [lo, hi] = [0, keys.length];
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((keys[mid] ?? '') < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return tag => {
    const key = reversed(tag.toUpperCase());
    const [lo, hi] = [lowerBound(key), lowerBound(`${key}\uFFFF`)];
    if (lo >= hi) return Infinity;
    const level = 31 - Math.clz32(hi - lo);
    const row = levels[level] ?? [];
    return Math.min(row[lo] ?? Infinity, row[hi - (1 << level)] ?? Infinity);
  };
}

/**
 * The registry answers `hf.co/<repo>:<tag>` with the first non-projector GGUF, in path order, whose stem ends with
 * the tag (case-insensitive), so a tag reaches a file only if no earlier stem ends with it too.
 */
function planOllamaTags(builds: readonly Pick<HubGgufBuild, 'id' | 'quant' | 'files'>[]): Map<string, OllamaTagPlan> {
  const ordered = builds
    .flatMap(build => (build.files[0] ? [{ build, path: build.files[0].path }] : []))
    .sort((a, b) => byCodeUnits(a.path, b.path));
  const firstOwner = firstStemEndingWith(ordered.map(({ path }) => ggufStem(path)));
  const plans = new Map<string, OllamaTagPlan>();
  ordered.forEach(({ build, path }, index) => {
    const candidates = ollamaTagCandidates(path, build.quant);
    const unique = candidates.find(tag => firstOwner(tag) === index);
    plans.set(build.id, {
      tags: unique ? [unique, ...candidates.filter(tag => tag !== unique)] : candidates,
      unique: unique !== undefined,
    });
  });
  return plans;
}

// Plans of the builds arrays getModel returned, so verifyOllamaRef does not plan again.
const tagPlans = new WeakMap<readonly HubGgufBuild[], Map<string, OllamaTagPlan>>();

/** Ollama caps each name part at 80 characters and allows no `.` in the namespace. */
function ollamaAcceptsRepo(repo: string): boolean {
  const [owner = '', name = ''] = repo.split('/');
  return !owner.includes('.') && owner.length <= OLLAMA_NAME_PART_MAX && name.length <= OLLAMA_NAME_PART_MAX;
}

export function isHubRepoId(repo: string): boolean {
  return REPO_ID_RE.test(repo) && !repo.includes('..');
}

/** `<endpoint>/<repo>/resolve/<revision>/<path>`; pass a commit sha to fetch exactly the bytes that were listed. */
export function hubResolveUrl(
  repo: string,
  revision: string,
  path: string,
  endpoint: string = DEFAULT_HUGGING_FACE_ENDPOINT
): string {
  return `${hubEndpoint(endpoint)}${resolvePath(repo, revision, path)}`;
}

function resolvePath(repo: string, revision: string, path: string): string {
  assertRepoId(repo);
  assertRevision(revision);
  const segments = path.split('/');
  if (!path || segments.some(segment => !segment || segment === '.' || segment === '..'))
    throw new LocalRuntimeError('Invalid Hugging Face file path', 'huggingface');
  return `/${repo}/resolve/${encodeURIComponent(revision)}/${segments.map(encodeURIComponent).join('/')}`;
}

function hubEndpoint(endpoint: string): string {
  const url = URL.canParse(endpoint) ? new URL(endpoint) : null;
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new LocalRuntimeError('Invalid Hugging Face endpoint', 'huggingface');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * Install-side guard: only `.gguf` files are fetched. Pickle formats (`.bin`, `.pt`, `.pth`, `.ckpt`) can run code
 * when loaded, and safetensors installs are not supported.
 */
export function assertGgufFile(path: string): void {
  const name = path.replace(/^.*\//, '');
  if (!/\.gguf$/i.test(name))
    throw new LocalRuntimeError(
      `Only .gguf files can be installed; refusing ${JSON.stringify(name.slice(0, 100))}`,
      'huggingface'
    );
}

function assertRepoId(repo: string): void {
  if (!isHubRepoId(repo))
    throw new LocalRuntimeError('Invalid Hugging Face repo id; expected owner/name', 'huggingface');
}

function assertRevision(revision: string): void {
  if (!REVISION_RE.test(revision) || revision.split('/').some(part => part === '' || part === '.' || part === '..'))
    throw new LocalRuntimeError('Invalid Hugging Face revision', 'huggingface');
}

function toGated(value: boolean | string | null | undefined): HubGated {
  if (value === 'auto' || value === 'manual') return value;
  return value === true ? 'auto' : false;
}

function strings(value: unknown, maxLength = 200): string[] {
  const list: unknown[] = Array.isArray(value) ? value : [value];
  return list.filter((entry): entry is string => typeof entry === 'string' && !!entry && entry.length <= maxLength);
}

function licenseIds(values: string[]): string[] {
  const ids = [...new Set(values.map(value => value.trim().toLowerCase()).filter(Boolean))];
  // Past the cap, `other` stands in for what was dropped so consumers still classify the repo as restricted.
  return ids.length > MAX_LICENSES ? [...new Set([...ids.slice(0, MAX_LICENSES - 1), 'other'])] : ids;
}

function toSummary(entry: ModelEntry): HubModelSummary {
  const tags = strings(entry.tags ?? []);
  return {
    id: entry.id,
    author: entry.author || entry.id.split('/')[0] || null,
    downloads: entry.downloads ?? null,
    likes: entry.likes ?? null,
    updatedAt: entry.lastModified ?? null,
    pipelineTag: entry.pipeline_tag ?? null,
    gated: toGated(entry.gated),
    private: entry.private ?? false,
    licenses: licenseIds(tags.flatMap(tag => (tag.startsWith('license:') ? [tag.slice('license:'.length)] : []))),
    baseModels: tags
      .flatMap(tag => /^base_model:([^:]+)$/.exec(tag)?.slice(1) ?? [])
      .filter(isHubRepoId)
      .slice(0, MAX_BASE_MODELS),
    tags: tags.filter(tag => !BOOKKEEPING_TAG_RE.test(tag)).slice(0, MAX_TAGS),
  };
}

function toGgufInfo(value: unknown): HubGgufInfo | null {
  const parsed = ggufInfoSchema.safeParse(value);
  if (!parsed.success) return null;
  const { architecture, context_length, total } = parsed.data;
  if (architecture === undefined && context_length === undefined && total === undefined) return null;
  return { architecture: architecture ?? null, contextLength: context_length ?? null, parameterCount: total ?? null };
}

function groupGgufFiles(
  repo: string,
  entries: TreeEntry[],
  url: (path: string) => string,
  pinned: boolean
): { builds: HubGgufBuild[]; projectors: HubGgufProjector[] } {
  const groups = new Map<string, { id: string; total: number; shards: { index: number; file: HubGgufFile }[] }>();
  const projectors: HubGgufProjector[] = [];
  for (const entry of entries) {
    if (entry.type !== 'file' || !/\.gguf$/i.test(entry.path)) continue;
    const oid = entry.lfs?.oid ?? '';
    const file: HubGgufFile = {
      path: entry.path,
      sizeBytes: entry.lfs?.size ?? entry.size ?? 0,
      sha256: SHA256_RE.test(oid) ? oid : null,
      url: url(entry.path),
    };
    if (/mmproj/i.test(entry.path.replace(/^.*\//, ''))) {
      projectors.push({ ...file, quant: ggufQuantLabel(entry.path) });
      continue;
    }
    const shard = SHARD_RE.exec(entry.path);
    const id = shard ? entry.path.slice(0, shard.index) : entry.path.replace(/\.gguf$/i, '');
    const key = `${shard ? 'split' : 'single'}:${id}`;
    const group = groups.get(key) ?? { id, total: shard ? Number(shard[2]) : 1, shards: [] };
    group.shards.push({ index: shard ? Number(shard[1]) : 1, file });
    groups.set(key, group);
  }

  const builds = [...groups.entries()].map(([key, group]) => {
    const shards = group.shards.sort((a, b) => a.index - b.index);
    const files = shards.map(shard => shard.file);
    const split = group.total > 1 || shards.length > 1;
    const complete = shards.length === group.total && shards.every((shard, i) => shard.index === i + 1);
    const collides = key.startsWith('split:') && groups.has(`single:${group.id}`);
    return {
      id: collides && files[0] ? files[0].path.replace(/\.gguf$/i, '') : group.id,
      quant: ggufQuantLabel(group.id),
      files,
      sizeBytes: shards.reduce((sum, shard) => sum + shard.file.sizeBytes, 0),
      split,
      complete,
    };
  });
  const plans = planOllamaTags(builds);
  const repoOk = ollamaAcceptsRepo(repo);
  const planned = builds
    .map((build): HubGgufBuild => {
      const tag = plans.get(build.id)?.tags[0];
      const issue: OllamaRefIssue | null = !build.complete
        ? 'incomplete'
        : build.split
          ? 'split'
          : !build.quant
            ? 'no-quant-label'
            : !repoOk
              ? 'unsupported-name'
              : !tag
                ? [...REGISTRY_REJECTED_QUANTS].some(rejected => build.quant?.includes(rejected))
                  ? 'unsupported-quant'
                  : 'unsupported-name'
                : pinned
                  ? 'pinned-revision'
                  : !plans.get(build.id)?.unique
                    ? 'ambiguous'
                    : null;
      return {
        ...build,
        ollamaRef: issue || !tag ? null : `${OLLAMA_HUGGING_FACE_HOST}/${repo}:${tag}`,
        ollamaRefIssue: issue,
      };
    })
    .sort((a, b) => a.sizeBytes - b.sizeBytes || a.id.localeCompare(b.id));
  tagPlans.set(planned, plans);
  return { builds: planned, projectors };
}

/** The `cursor` of a `Link: <...>; rel="next"` header, so the next page goes to our endpoint even behind a mirror. */
function nextCursor(headers: Headers): string | null {
  for (const part of (headers.get('link') ?? '').split(',')) {
    const match = /<([^>]*)>\s*;\s*rel="?next"?/i.exec(part);
    if (match?.[1] && URL.canParse(match[1], DEFAULT_HUGGING_FACE_ENDPOINT))
      return new URL(match[1], DEFAULT_HUGGING_FACE_ENDPOINT).searchParams.get('cursor') || null;
  }
  return null;
}

function retryAfterMs(headers: Headers): number | null {
  const retryAfter = headers.get('retry-after')?.trim();
  if (retryAfter && /^\d+$/.test(retryAfter)) return Number(retryAfter) * 1000;
  const date = retryAfter ? Date.parse(retryAfter) : NaN;
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  // Hub API responses carry the IETF draft header, e.g. `"api";r=0;t=53`, where t is seconds to the reset.
  const reset = /(?:^|;)\s*t=(\d+)/.exec(headers.get('ratelimit') ?? '');
  return reset ? Number(reset[1]) * 1000 : null;
}

class BodyTooLargeError extends Error {}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Shared by every client, so a new instance (say, after a token change) still hits; keys carry the endpoint and a
// token hash, so one token's answers never reach another.
const hubCache = new Map<string, { expires: number; value: unknown }>();

function cacheGet<T>(key: string): T | undefined {
  const entry = hubCache.get(key);
  if (!entry) return undefined;
  hubCache.delete(key);
  if (entry.expires <= Date.now()) return undefined;
  hubCache.set(key, entry);
  return structuredClone(entry.value) as T;
}

function cachePut(key: string, value: unknown): void {
  hubCache.delete(key);
  hubCache.set(key, { expires: Date.now() + HUB_CACHE_TTL_MS, value: structuredClone(value) });
  for (const oldest of hubCache.keys()) {
    if (hubCache.size <= MAX_CACHE_ENTRIES) break;
    hubCache.delete(oldest);
  }
}

/** Drops every cached search and model answer, for every client. */
export function clearHubCache(): void {
  hubCache.clear();
}

async function readText(response: Response, maxBytes: number): Promise<string> {
  if (Number(response.headers.get('content-length')) > maxBytes) throw new BodyTooLargeError();
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new BodyTooLargeError();
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * Search and metadata for GGUF repos on the Hugging Face Hub. Downloads go through Ollama (`ollamaRef`) or the
 * resolve URLs on each file.
 */
export class HuggingFaceHub {
  readonly id: string;
  readonly endpoint: string;
  readonly #token: string | undefined;
  readonly #client: HttpClient;
  readonly #requestTimeoutMs: number;
  readonly #cacheScope: string;
  readonly #maxRateLimitWaitMs: number;

  constructor(options: HuggingFaceHubOptions = {}) {
    this.endpoint = hubEndpoint(options.endpoint ?? DEFAULT_HUGGING_FACE_ENDPOINT);
    this.id =
      this.endpoint === DEFAULT_HUGGING_FACE_ENDPOINT
        ? 'huggingface'
        : `huggingface:${runtimeEndpointId(this.endpoint)}`;
    this.#token = options.token?.trim() || undefined;
    if (this.#token) assertHeaderValues({ authorization: `Bearer ${this.#token}` }, this.id);
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#maxRateLimitWaitMs = options.maxRateLimitWaitMs ?? DEFAULT_MAX_RATE_LIMIT_WAIT_MS;
    this.#cacheScope = `${this.endpoint}\n${this.#token ? `token:${createHash('sha256').update(this.#token).digest('hex')}` : 'anonymous'}`;
    this.#client = { runtimeId: this.id, baseUrl: this.endpoint, fetch: options.fetch ?? fetch };
  }

  /** One page of GGUF repos matching `query`. */
  async search(options: HubSearchOptions = {}): Promise<HubSearchPage> {
    options.signal?.throwIfAborted();
    const requested = Number.isFinite(options.limit) ? Math.trunc(options.limit ?? 0) : DEFAULT_HUB_SEARCH_LIMIT;
    const limit = Math.min(Math.max(requested, 1), MAX_HUB_SEARCH_LIMIT);
    const params = new URLSearchParams({ filter: 'gguf', sort: SORT_PARAMS[options.sort ?? 'downloads'] });
    const query = options.query?.trim();
    if (query) params.set('search', query.slice(0, MAX_QUERY_LENGTH));
    params.set('limit', String(limit));
    for (const field of SUMMARY_FIELDS) params.append('expand[]', field);
    if (options.cursor) params.set('cursor', options.cursor);
    const cacheKey = `${this.#cacheScope}\nsearch\n${params}`;
    const cached = options.refresh ? undefined : cacheGet<HubSearchPage>(cacheKey);
    if (cached) return cached;
    const { data, headers } = await this.#getJson(`/api/models?${params}`, z.array(z.unknown()), {
      signal: options.signal,
    });
    const page: HubSearchPage = {
      models: data.slice(0, limit).flatMap(raw => {
        const entry = modelEntrySchema.safeParse(raw);
        return entry.success && isHubRepoId(entry.data.id) ? [toSummary(entry.data)] : [];
      }),
      nextCursor: nextCursor(headers),
    };
    cachePut(cacheKey, page);
    return page;
  }

  /**
   * Repo metadata and its GGUF builds, pinned to one commit. A missing repo, and a private one the token cannot
   * read, both reject with `ModelNotFoundError`, since the Hub answers both with a bare 401; a token the Hub
   * rejects outright (403) gives `HubAccessError` with reason `unauthorized`.
   */
  async getModel(repo: string, options: HubModelOptions = {}): Promise<HubModelDetail> {
    assertRepoId(repo);
    const requested = options.revision ?? 'main';
    assertRevision(requested);
    options.signal?.throwIfAborted();
    const cacheKey = `${this.#cacheScope}\nmodel\n${repo}\n${requested}`;
    const cached = options.refresh ? undefined : cacheGet<HubModelDetail>(cacheKey);
    if (cached) return cached;
    const detail = await this.#fetchModel(repo, requested, options.signal);
    cachePut(cacheKey, detail);
    return detail;
  }

  async #fetchModel(repo: string, requested: string, signal: AbortSignal | undefined): Promise<HubModelDetail> {
    const context = { signal, repo, revision: requested };
    const params = new URLSearchParams();
    for (const field of DETAIL_FIELDS) params.append('expand[]', field);
    const { data: info } = await this.#getJson(
      `/api/models/${repo}/revision/${encodeURIComponent(requested)}?${params}`,
      modelInfoSchema,
      context
    );
    if (COMMIT_RE.test(requested) && info.sha !== requested)
      throw new RuntimeProtocolError(`${this.id} answered for ${info.sha}, not ${repo}@${requested}`, this.id);

    // A renamed repo redirects to its new id, which is the one Ollama refs and resolve URLs need.
    const canonical = info.id;
    const revision = info.sha;
    const tree = await this.#listTree(canonical, revision, signal);
    const { builds, projectors } = groupGgufFiles(
      canonical,
      tree,
      path => this.resolveUrl(canonical, revision, path),
      requested !== 'main'
    );
    const summary = toSummary(info);
    const card = info.cardData ?? {};
    const cardBaseModels = strings(card.base_model).filter(isHubRepoId).slice(0, MAX_BASE_MODELS);
    const probe = builds[0]?.files[0] ?? projectors[0];
    const licenses = licenseIds([...strings(card.license), ...summary.licenses]);
    const licenseName = strings(card.license_name)[0] ?? null;
    return {
      ...summary,
      licenses: licenses.length === 0 && licenseName ? ['other'] : licenses,
      baseModels: cardBaseModels.length > 0 ? cardBaseModels : summary.baseModels,
      revision,
      licenseName,
      licenseLink: strings(card.license_link, 2048)[0] ?? null,
      gguf: toGgufInfo(info.gguf),
      builds,
      projectors,
      canDownload: await this.#canDownload(canonical, revision, summary.gated, probe?.path, signal),
      ollamaNeedsSshKey: summary.gated !== false || summary.private,
    };
  }

  resolveUrl(repo: string, revision: string, path: string): string {
    return hubResolveUrl(repo, revision, path, this.endpoint);
  }

  /**
   * The Ollama ref that pulls exactly `build`'s file, asked of the registry itself (one manifest request per tag
   * tried, at most `MAX_VERIFY_TAGS`); null when no tag does. Call it right before a pull: it also clears `ambiguous`
   * and `pinned-revision` builds whose file the registry serves byte for byte, and catches files the registry skips.
   * The pull itself carries no token; see `ollamaNeedsSshKey`.
   */
  async verifyOllamaRef(
    detail: Pick<HubModelDetail, 'id' | 'builds'>,
    build: HubGgufBuild,
    options: { signal?: AbortSignal } = {}
  ): Promise<string | null> {
    assertRepoId(detail.id);
    for (const file of build.files) assertGgufFile(file.path);
    const sha256 = build.files[0]?.sha256;
    if (build.split || !build.complete || !sha256 || !ollamaAcceptsRepo(detail.id)) return null;
    const plan = (tagPlans.get(detail.builds) ?? planOllamaTags(detail.builds)).get(build.id);
    const context = { signal: options.signal, repo: detail.id, accept: REGISTRY_MANIFEST_ACCEPT, manifest: true };
    for (const tag of plan?.tags.slice(0, MAX_VERIFY_TAGS) ?? []) {
      let manifest: z.infer<typeof manifestSchema>;
      try {
        ({ data: manifest } = await this.#getJson(`/v2/${detail.id}/manifests/${tag}`, manifestSchema, context));
      } catch (error) {
        // 400 is the registry's "not available", "sharded" and "not a valid quantization scheme".
        if (error instanceof RuntimeHttpError && [400, 404].includes(error.status)) continue;
        throw error;
      }
      const model = manifest.layers.find(layer => layer.mediaType === OLLAMA_MODEL_LAYER);
      if (model?.digest === `sha256:${sha256}`) return `${OLLAMA_HUGGING_FACE_HOST}/${detail.id}:${tag}`;
    }
    return null;
  }

  /**
   * Downloads one GGUF file, resuming `<destination>.partial` from an earlier attempt, and checks its size and
   * sha256 (size only when the Hub masks the hash). The token goes to the endpoint only, never to the CDN it
   * redirects to. An existing `destination` is never overwritten: it is verified, or `ModelFileConflictError`.
   */
  async download(file: HubGgufFile, destination: string, options: DownloadOptions = {}): Promise<DownloadResult> {
    assertGgufFile(file.path);
    assertGgufFile(URL.canParse(file.url) ? new URL(file.url).pathname : file.url);
    const origin = new URL(this.endpoint).origin;
    const resolved = file.url.startsWith(`${this.endpoint}/`)
      ? /^\/([^/]+\/[^/]+)\/resolve\/([^/]+)\//.exec(file.url.slice(this.endpoint.length))
      : null;
    const repo = resolved?.[1];
    const revision = resolved?.[2] && decodeURIComponent(resolved[2]);
    return downloadFile(
      {
        runtimeId: this.id,
        fetch: this.#client.fetch,
        headersFor: (url): Record<string, string> =>
          this.#token && url.origin === origin ? { authorization: `Bearer ${this.#token}` } : {},
        httpError: (response, url) =>
          url.origin === origin
            ? this.#httpError(response, url.pathname, { repo, revision })
            : this.#httpError(response, `${url.origin} download`, {}),
        connectionError: error => this.#connectionError(file.path, error, options.signal),
      },
      file,
      destination,
      options
    );
  }

  async #canDownload(
    repo: string,
    revision: string,
    gated: HubGated,
    path: string | undefined,
    signal: AbortSignal | undefined
  ): Promise<boolean | null> {
    if (!gated) return true;
    if (!this.#token) return false;
    if (!path) return null;
    try {
      await this.#request(resolvePath(repo, revision, path), { method: 'HEAD', signal, repo, revision });
      return true;
    } catch (error) {
      if (error instanceof HubAccessError || error instanceof ModelNotFoundError) return false;
      throw error;
    }
  }

  async #listTree(repo: string, revision: string, signal: AbortSignal | undefined): Promise<TreeEntry[]> {
    const entries: TreeEntry[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_TREE_PAGES; page++) {
      const params = new URLSearchParams({ recursive: 'true' });
      if (cursor) params.set('cursor', cursor);
      const { data, headers } = await this.#getJson(
        `/api/models/${repo}/tree/${revision}?${params}`,
        z.array(z.unknown()),
        { signal, repo, revision }
      );
      for (const raw of data) {
        const entry = treeEntrySchema.safeParse(raw);
        if (entry.success) entries.push(entry.data);
      }
      cursor = nextCursor(headers);
      if (!cursor) return entries;
    }
    throw new RuntimeProtocolError(`${this.id} lists more than ${MAX_TREE_PAGES} pages of files in ${repo}`, this.id);
  }

  async #getJson<T extends z.ZodType>(
    path: string,
    schema: T,
    context: RequestContext
  ): Promise<{ data: z.infer<T>; headers: Headers }> {
    const shown = path.split('?')[0] ?? path;
    const response = await this.#request(path, context);
    let text: string;
    try {
      text = await readText(response, MAX_RESPONSE_BYTES);
    } catch (error) {
      if (error instanceof BodyTooLargeError)
        throw new RuntimeProtocolError(`${this.id} ${shown} sent more than ${MAX_RESPONSE_BYTES} bytes`, this.id);
      throw this.#connectionError(shown, error, context.signal);
    }
    try {
      return { data: parseJson(this.#client, shown, text, schema), headers: response.headers };
    } catch (error) {
      if (!(error instanceof RuntimeProtocolError)) throw error;
      // Parser causes can quote truncated token fragments that exact-token redaction cannot remove.
      throw new RuntimeProtocolError(error.message, this.id);
    }
  }

  /** Follows same-origin redirects for GET (renamed repos); a HEAD returns its redirect, which means "readable". */
  async #request(path: string, context: RequestContext): Promise<Response> {
    const shown = path.split('?')[0] ?? path;
    const signal = combinedSignal(context.signal, this.#requestTimeoutMs);
    const origin = new URL(this.endpoint).origin;
    let url = `${this.endpoint}${path}`;
    let retries = 0;
    let waitedMs = 0;
    for (let hop = 0; ; hop++) {
      let response: Response;
      try {
        response = await this.#client.fetch(url, {
          method: context.method ?? 'GET',
          headers: {
            accept: context.accept ?? 'application/json',
            ...(this.#token ? { authorization: `Bearer ${this.#token}` } : {}),
          },
          signal,
          redirect: 'manual',
        });
      } catch (error) {
        throw this.#connectionError(shown, error, context.signal);
      }
      if (response.status === 429 && this.#maxRateLimitWaitMs > 0 && retries < MAX_RATE_LIMIT_RETRIES) {
        const delay = retryAfterMs(response.headers) ?? RATE_LIMIT_BACKOFF_MS * 2 ** retries;
        if (waitedMs + delay <= this.#maxRateLimitWaitMs) {
          await response.body?.cancel().catch(() => undefined);
          try {
            await sleep(delay, signal);
          } catch (error) {
            throw this.#connectionError(shown, error, context.signal);
          }
          waitedMs += delay;
          retries++;
          hop--;
          continue;
        }
      }
      if (response.status < 300 || response.status >= 400) {
        if (!response.ok) throw await this.#httpError(response, shown, context);
        return response;
      }
      if (context.method === 'HEAD') return response;
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get('location');
      const next = location && URL.canParse(location, url) ? new URL(location, url) : null;
      // Only same-origin hops: the Authorization header must not reach another host.
      if (!next || next.origin !== origin || hop >= MAX_REDIRECTS)
        throw new RuntimeProtocolError(`${this.id} ${shown} redirected somewhere it will not follow`, this.id);
      url = next.href;
    }
  }

  async #httpError(response: Response, path: string, context: RequestContext): Promise<Error> {
    const { status, headers } = response;
    const text = context.method === 'HEAD' ? '' : await readText(response, MAX_ERROR_BODY_BYTES).catch(() => '');
    const body = errorBodySchema.safeParse(safeJsonParse(text));
    const detail = this.#redact(
      (headers.get('x-error-message') ?? (body.success ? body.data.error : '')).slice(0, 300)
    );
    const message = `${this.id} ${path} returned HTTP ${status}${detail ? `: ${detail}` : ''}`;
    const code = headers.get('x-error-code');
    const { repo, revision } = context;
    if (status === 429) return new HubRateLimitError(message, this.id, retryAfterMs(headers));
    if (!repo) return new RuntimeHttpError(message, this.id, status);
    if ((status === 401 || status === 403) && code === 'GatedRepo')
      return new HubAccessError(message, this.id, status, repo, 'gated');
    if (status === 404 && context.manifest) return new RuntimeHttpError(message, this.id, status);
    if (status === 404 && code === 'RevisionNotFound')
      return new ModelNotFoundError(this.id, `${repo}@${revision}`, { cause: message });
    // The Hub ignores a bad token on a public repo and answers a missing or unreadable one with a bare 401.
    if (status === 404 || status === 401) return new ModelNotFoundError(this.id, repo, { cause: message });
    if (status === 403) return new HubAccessError(message, this.id, status, repo, 'unauthorized');
    return new RuntimeHttpError(message, this.id, status);
  }

  #connectionError(path: string, error: unknown, signal: AbortSignal | undefined): unknown {
    if (error instanceof LocalRuntimeError || signal?.aborted) return error;
    const reason = this.#redact(describeError(error, this.#requestTimeoutMs));
    return new RuntimeConnectionError(`${this.id} ${path} failed: ${reason}`, this.id, {
      cause: redactedError(error, text => this.#redact(text)),
    });
  }

  #redact(text: string): string {
    const withoutToken = this.#token ? text.split(this.#token).join('[redacted]') : text;
    return withoutToken.replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [redacted]').replace(/\bhf_\w{8,}/g, '[redacted]');
  }
}

/** A copy of a fetch failure and its causes with only name, message, code and stack, each passed through `redact`. */
function redactedError(error: unknown, redact: (text: string) => string, depth = 0): Error {
  const source = error instanceof Error ? error : new Error(String(error));
  const cause = depth < 3 && source.cause !== undefined ? redactedError(source.cause, redact, depth + 1) : undefined;
  const copy = new Error(redact(source.message), cause ? { cause } : undefined);
  copy.name = redact(source.name);
  copy.stack = redact(source.stack ?? `${copy.name}: ${copy.message}`);
  const code: unknown = Reflect.get(source, 'code');
  if (typeof code === 'string') Object.assign(copy, { code: redact(code) });
  return copy;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
