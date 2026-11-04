import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { DownloadOptions, DownloadResult } from './download';
import {
  ollamaHubName,
  type HubGgufBuild,
  type HubGgufFile,
  type HubGgufProjector,
  type HubModelDetail,
} from './huggingface';
import type { PullBlock } from './pulls/approval';
import type { ModelImportRuntime, OllamaCreateRequest, OllamaRegistryLayers } from './types';

/**
 * The first Ollama that creates one model from every shard of a split GGUF (server/create_split_gguf.go in
 * ollama/ollama); it refuses a create naming only the first shard.
 */
export const SPLIT_IMPORT_MIN_OLLAMA = '0.35.0';

// Ollama groups shards only under this exact name (splitGGUFNameRe in server/create_split_gguf.go).
const OLLAMA_SHARD_NAME_RE = /^.+-\d{5}-of-\d{5}\.gguf$/;
const PROJECTOR_LAYER = 'application/vnd.ollama.image.projector';
const PARAMS_LAYER = 'application/vnd.ollama.image.params';
// With no sibling to ask, F16 first: Hugging Face's registry pairs it with most tags.
const PROJECTOR_PREFERENCE = ['F16', 'BF16', 'F32'];
const NUMBER_PARAMS = new Set([
  'temperature',
  'top_k',
  'top_p',
  'min_p',
  'repeat_penalty',
  'repeat_last_n',
  'presence_penalty',
  'frequency_penalty',
  'num_ctx',
  'num_predict',
  'seed',
]);

export type SplitImportBlock = Extract<PullBlock, 'incomplete' | 'unsupported-name' | 'no-checksum' | 'needs-access'>;

const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** Why Ollama's create would refuse `name` as a file key (validateCreateFilePath in server/create.go), else null. */
export function createFileNameProblem(name: string): string | null {
  if (name === '' || name === '.' || name === '..') return `${JSON.stringify(name)} is not a file name`;
  if (/[\\:/]/.test(name) || [...name].some(char => char.charCodeAt(0) < 0x20))
    return `${name} has a character Ollama refuses in file names (backslash, colon or a control character)`;
  return null;
}

/** The path of a staged part, which must stay inside `dir` even on Windows. */
function stagedPath(dir: string, name: string): string {
  const path = resolve(dir, name);
  const from = relative(resolve(dir), path);
  if (createFileNameProblem(name) || !from || from.startsWith('..') || isAbsolute(from))
    throw new Error(`${name} cannot be staged inside the import folder`);
  return path;
}

/** The name a split build is created under: the `hf.co` ref Ollama would pull it by if the registry served splits. */
export function splitImportName(repo: string, build: Pick<HubGgufBuild, 'label'>): string | null {
  return ollamaHubName(repo, build.label);
}

/** Why the caller cannot import a split build by downloading its shards and creating the model in Ollama. */
export function splitImportBlock(
  detail: Pick<HubModelDetail, 'id' | 'gated' | 'private' | 'canDownload'>,
  build: HubGgufBuild
): SplitImportBlock | null {
  if (!build.complete) return 'incomplete';
  if (
    !splitImportName(detail.id, build) ||
    build.files.some(file => {
      const name = fileName(file.path);
      return !OLLAMA_SHARD_NAME_RE.test(name) || createFileNameProblem(name) !== null;
    })
  )
    return 'unsupported-name';
  // The Hub hides a gated or private file's checksum from a reader without access.
  const hidden = build.files.some(file => !file.sha256);
  if (detail.canDownload === false || (hidden && (detail.gated || detail.private))) return 'needs-access';
  return hidden ? 'no-checksum' : null;
}

/** Ollama option values from a params layer, keeping only options Ollama reads and dropping anything else. */
export function importParameters(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'stop') {
      const stops = (Array.isArray(value) ? value : [value]).filter(
        (stop): stop is string => typeof stop === 'string' && stop !== ''
      );
      if (stops.length) kept.stop = stops;
    } else if (NUMBER_PARAMS.has(key) && typeof value === 'number' && Number.isFinite(value)) kept[key] = value;
  }
  return Object.keys(kept).length ? kept : null;
}

export interface SiblingLayers {
  /** Of the projector the registry serves with a sibling build. */
  projectorSha256: string | null;
  parameters: Record<string, unknown> | null;
}

export interface SiblingHub {
  ollamaLayers(repo: string, tag: string, options?: { signal?: AbortSignal }): Promise<OllamaRegistryLayers | null>;
  ollamaRegistryJson(repo: string, sha256: string, options?: { signal?: AbortSignal }): Promise<unknown>;
}

const dynamicQuant = (label: string) => /^UD-/i.test(label);

/**
 * The projector and params Hugging Face's registry serves Ollama with a single-file build of the same repo, which
 * a split build would get if the registry served it. Template is left out: Ollama reads it from the GGUF.
 */
export async function siblingLayers(
  detail: Pick<HubModelDetail, 'id' | 'builds'>,
  build: Pick<HubGgufBuild, 'label'>,
  hub: SiblingHub,
  signal?: AbortSignal
): Promise<SiblingLayers> {
  const siblings = detail.builds.filter(candidate => candidate.ollamaRef);
  // The registry pairs projectors per tag, e.g. BF16 for UD- tags and F16 for the rest on one unsloth repo.
  const sibling =
    siblings.find(candidate => dynamicQuant(candidate.label) === dynamicQuant(build.label)) ?? siblings[0];
  const ref = sibling?.ollamaRef;
  if (!ref) return { projectorSha256: null, parameters: null };
  const layers = await hub.ollamaLayers(detail.id, ref.slice(ref.lastIndexOf(':') + 1), { signal });
  const projector = layers?.others.find(layer => layer.mediaType === PROJECTOR_LAYER);
  const params = layers?.others.find(layer => layer.mediaType === PARAMS_LAYER);
  return {
    projectorSha256: projector?.digest ?? null,
    parameters: params ? importParameters(await hub.ollamaRegistryJson(detail.id, params.digest, { signal })) : null,
  };
}

/**
 * One of the build's own precision (BF16 for a BF16 build), else the sibling's, else F16, BF16 or F32 in that
 * order; null for a text model.
 */
export function importProjector(
  projectors: readonly HubGgufProjector[],
  quant: string | null,
  siblingSha256: string | null
): HubGgufProjector | null {
  const usable = projectors.filter(
    projector => projector.sha256 && createFileNameProblem(fileName(projector.path)) === null
  );
  const paired =
    usable.find(projector => quant !== null && projector.quant === quant) ??
    usable.find(projector => projector.sha256 === siblingSha256);
  if (paired) return paired;
  for (const quant of PROJECTOR_PREFERENCE) {
    const preferred = usable.find(projector => projector.quant === quant);
    if (preferred) return preferred;
  }
  return usable[0] ?? null;
}

export interface SplitImportPart {
  file: HubGgufFile;
  /** The file's own name, which Ollama groups shards by. */
  name: string;
  digest: string;
}

export interface SplitImportPlan {
  model: string;
  /** Shards in order, then the projector if any. */
  parts: SplitImportPart[];
  parameters: Record<string, unknown> | null;
  totalBytes: number;
}

/** Throws unless `splitImportBlock` passed the build. */
export function planSplitImport(
  detail: Pick<HubModelDetail, 'id' | 'projectors'>,
  build: HubGgufBuild,
  sibling: SiblingLayers
): SplitImportPlan {
  const model = splitImportName(detail.id, build);
  if (!model || !build.split || build.files.some(file => !file.sha256))
    throw new Error(`${detail.id} ${build.id} is not a split build that can be imported`);
  const projector = importProjector(detail.projectors, build.quant, sibling.projectorSha256);
  const files: HubGgufFile[] = projector ? [...build.files, projector] : build.files;
  assertImportNames(files.map(file => fileName(file.path)));
  return {
    model,
    parts: files.map(file => ({ file, name: fileName(file.path), digest: `sha256:${file.sha256}` })),
    parameters: sibling.parameters,
    totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
  };
}

/** Throws before any download when Ollama would refuse a name or two parts would share one. */
function assertImportNames(names: readonly string[]): void {
  for (const name of names) {
    const problem = createFileNameProblem(name);
    if (problem) throw new Error(`This build cannot be imported: ${problem}.`);
  }
  const duplicate = names.find((name, i) => names.indexOf(name) !== i);
  if (duplicate) throw new Error(`This build cannot be imported: two files are both named ${duplicate}.`);
}

export function splitImportCreateRequest(plan: SplitImportPlan): OllamaCreateRequest {
  return {
    model: plan.model,
    files: Object.fromEntries(plan.parts.map(part => [part.name, part.digest])),
    ...(plan.parameters ? { parameters: plan.parameters } : {}),
  };
}

export interface ImportDisks {
  /** Free bytes where parts are staged; null when unknown. */
  stagingFreeBytes: number | null;
  /** Free bytes in Ollama's model folder; null when unknown. */
  storeFreeBytes: number | null;
  /** Null when unknown, which counts as one disk. */
  sameDisk: boolean | null;
}

export type ImportSpace =
  { ok: true } | { ok: false; where: 'staging' | 'store'; neededBytes: number; freeBytes: number };

/**
 * Parts move one at a time (staged, copied into Ollama, then deleted), so staging needs room for the largest part
 * Ollama lacks and Ollama for all of them; on one disk that is both at once. `present` holds digests Ollama has.
 */
export function splitImportSpace(plan: SplitImportPlan, present: ReadonlySet<string>, disks: ImportDisks): ImportSpace {
  const missing = plan.parts.filter(part => !present.has(part.digest)).map(part => part.file.sizeBytes);
  const largest = Math.max(0, ...missing);
  const total = missing.reduce((sum, size) => sum + size, 0);
  const { stagingFreeBytes: staging, storeFreeBytes: store } = disks;
  if (disks.sameDisk !== false) {
    const known = [store, staging].filter((free): free is number => free !== null);
    const free = known.length ? Math.min(...known) : null;
    const where = store !== null && store === free ? 'store' : 'staging';
    return free !== null && free < total + largest
      ? { ok: false, where, neededBytes: total + largest, freeBytes: free }
      : { ok: true };
  }
  if (staging !== null && staging < largest)
    return { ok: false, where: 'staging', neededBytes: largest, freeBytes: staging };
  if (store !== null && store < total) return { ok: false, where: 'store', neededBytes: total, freeBytes: store };
  return { ok: true };
}

export interface SplitImportProgress {
  status: 'downloading' | 'creating';
  /** Each part counts half while it downloads and half while Ollama takes it. */
  completedBytes: number;
  totalBytes: number;
}

export interface SplitImportDeps {
  hub: { download(file: HubGgufFile, destination: string, options?: DownloadOptions): Promise<DownloadResult> };
  runtime: ModelImportRuntime;
  /** Staging folder for this build (see `splitImportStageDir`); removed after a successful create, kept otherwise. */
  dir: string;
  signal?: AbortSignal;
  onProgress?: (progress: SplitImportProgress) => void;
}

/**
 * Downloads each part Ollama lacks, hands it to Ollama and deletes it before the next, then creates the model.
 * A part Ollama already holds is skipped, and a part cut short resumes from its partial file in `dir`.
 */
export async function runSplitImport(plan: SplitImportPlan, deps: SplitImportDeps): Promise<void> {
  const { hub, runtime, dir, signal } = deps;
  const report = (completedBytes: number, status: SplitImportProgress['status'] = 'downloading') =>
    deps.onProgress?.({ status, completedBytes: Math.floor(completedBytes), totalBytes: plan.totalBytes });
  assertImportNames(plan.parts.map(part => part.name));
  await mkdir(dir, { recursive: true });
  let done = 0;
  report(0);
  for (const part of plan.parts) {
    signal?.throwIfAborted();
    const size = part.file.sizeBytes;
    if (!(await runtime.hasBlob(part.digest, { signal }))) {
      const path = stagedPath(dir, part.name);
      await hub.download(part.file, path, {
        signal,
        onProgress: progress => report(done + Math.min(progress.completedBytes, size) / 2),
      });
      await runtime.uploadBlob(part.digest, path, {
        signal,
        onProgress: sent => report(done + (size + Math.min(sent, size)) / 2),
      });
      await rm(path, { force: true });
    }
    done += size;
    report(done);
  }
  signal?.throwIfAborted();
  report(done, 'creating');
  await runtime.create(splitImportCreateRequest(plan), { signal });
  // A Windows handle can outlive the run; sweepSplitImports removes what is left.
  await removeSplitStaging(dir);
}

/** Staging folder for one build: the same repo, revision and file set always map to the same folder. */
export function splitImportStageDir(root: string, plan: SplitImportPlan): string {
  const key = JSON.stringify([
    plan.model,
    plan.parts.map(part => [part.file.url, part.digest, part.file.sizeBytes, part.name]),
  ]);
  return join(root, `build-${createHash('sha256').update(key).digest('hex').slice(0, 32)}`);
}

export async function removeSplitStaging(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
}

export const SPLIT_STAGING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

async function lastTouched(path: string): Promise<number> {
  const info = await stat(path);
  let newest = info.mtimeMs;
  if (info.isDirectory()) {
    for (const name of await readdir(path).catch(() => [] as string[]))
      newest = Math.max(newest, (await stat(join(path, name)).catch(() => info)).mtimeMs);
  }
  return newest;
}

/** Removes staging folders nothing has written to for `maxAgeMs`; a recent one may be a retry's resume point. */
export async function sweepSplitImports(
  root: string,
  maxAgeMs: number = SPLIT_STAGING_MAX_AGE_MS,
  now: number = Date.now()
): Promise<void> {
  const names = await readdir(root).catch(() => [] as string[]);
  await Promise.all(
    names.map(async name => {
      const path = join(root, name);
      const touched = await lastTouched(path).catch(() => null);
      if (touched !== null && now - touched > maxAgeMs) await removeSplitStaging(path);
    })
  );
}
