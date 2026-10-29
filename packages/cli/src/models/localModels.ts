/**
 * Local model logic shared by `b4m models` (src/commands/modelsCommand.ts) and the MCP model tools
 * (src/mcp/modelTools.ts): ref parsing, runtime resolution, build and license checks, and pull planning.
 * Each surface does its own output and asks the user its own way.
 */

import {
  HUGGING_FACE_SSH_KEYS_URL,
  HubAccessError,
  HuggingFaceHub,
  ModelNotFoundError,
  OllamaRuntime,
  detectRuntimes,
  isAbliteratedModel,
  isHubRepoId,
  type DetectedRuntime,
  type HubGgufBuild,
  type HubModelDetail,
  type HubModelSummary,
  type InstalledModel,
  type LocalRuntime,
  type OllamaRefIssue,
} from '@bike4mind/local-models';
import { withDefaultOllamaPort } from '../utils/ollamaHost.js';
import { sanitizeTerminalText } from '../utils/sanitizeTerminalText.js';
import {
  OLLAMA_REGISTRY_HOSTS,
  classifyLicenses,
  parseOllamaName,
  type OllamaManifestInfo,
} from '../commands/ollamaRegistry.js';

export type HubClient = Pick<HuggingFaceHub, 'endpoint' | 'search' | 'getModel' | 'verifyOllamaRef'>;

export const NOT_RECOMMENDED_LABEL = 'abliterated or uncensored build';

export function hiddenAbliteratedMessage(count: number): string {
  return `${count} abliterated or uncensored ${count === 1 ? 'build was' : 'builds were'} left out.`;
}

/** Drops abliterated builds unless asked for; the ones kept go after every other hit and are flagged. */
export function rankSearchHits<T extends Pick<HubModelSummary, 'id' | 'tags' | 'baseModels'>>(
  models: T[],
  includeAbliterated: boolean
): { hits: Array<T & { notRecommended?: string }>; hidden: number } {
  const flagged = models.filter(isAbliteratedModel);
  const plain = models.filter(model => !isAbliteratedModel(model));
  return {
    hits: [
      ...plain,
      ...(includeAbliterated ? flagged.map(model => ({ ...model, notRecommended: NOT_RECOMMENDED_LABEL })) : []),
    ],
    hidden: includeAbliterated ? 0 : flagged.length,
  };
}

export type RuntimeSource = 'flag' | 'env' | 'config' | 'detected';

export interface RuntimeTarget {
  runtime: LocalRuntime;
  source: RuntimeSource;
}

/** Where models come from and go to; `planPull` needs nothing else. */
export interface ModelSourceDeps {
  hub: () => HubClient;
  /** Size and license texts of an Ollama registry model, read before pulling it. */
  ollamaRegistry: (name: string, signal: AbortSignal) => Promise<OllamaManifestInfo>;
  resolveRuntime: () => Promise<RuntimeTarget>;
  /** Aborted on Ctrl-C. */
  signal: AbortSignal;
}

export type PullTarget = { kind: 'hub'; repo: string; tag: string | null } | { kind: 'ollama'; name: string };

export interface LicenseInfo {
  label: string;
  link: string;
  restricted: boolean;
  plural?: boolean;
}

export interface HubPullPlan {
  kind: 'hub';
  target: RuntimeTarget;
  hub: HubClient;
  detail: HubModelDetail;
  build: HubGgufBuild;
  /** `detail.id`, safe to print. */
  id: string;
  license: LicenseInfo & { plural: boolean };
  /** Largest vision projector Ollama may add to the pull; 0 when there is none. */
  projectorBytes: number;
}

export interface OllamaPullPlan {
  kind: 'ollama';
  target: RuntimeTarget;
  name: string;
  manifest: OllamaManifestInfo;
  license: LicenseInfo;
}

export type PullPlan = HubPullPlan | OllamaPullPlan;

/** Ctrl-C at a prompt or while waiting on the runtime. */
export class CancelledError extends Error {
  constructor() {
    super('Cancelled.');
    this.name = 'CancelledError';
  }
}

/** Settles with `promise`, or rejects with `CancelledError` as soon as `signal` aborts. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new CancelledError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new CancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

export const DEFAULT_QUANT = 'Q4_K_M';
export const NO_LICENSE = 'none declared';
const HF_HOSTS: ReadonlySet<string> = new Set(['hf.co', 'huggingface.co']);

const PERMISSIVE_LICENSES = new Set([
  '0bsd',
  'apache-2.0',
  'bsd',
  'bsd-2-clause',
  'bsd-3-clause',
  'bsd-3-clause-clear',
  'bsl-1.0',
  'cc0-1.0',
  'isc',
  'mit',
  'unlicense',
  'zlib',
]);

export const REF_ISSUES: Record<OllamaRefIssue, string> = {
  split: 'split into shards, which Ollama cannot pull',
  incomplete: 'some shards are missing',
  'no-quant-label': 'the file name has no quant label',
  'unsupported-quant': 'Ollama cannot pull this quant from Hugging Face',
  'unsupported-name': 'Ollama does not accept this repo or file name',
  'pinned-revision': 'not on the main branch',
  ambiguous: 'an earlier file answers the same tag; pull asks the registry',
};

// `ambiguous` builds can still pull: verifyOllamaRef asks the registry which file the tag serves.
export const UNPULLABLE: ReadonlySet<OllamaRefIssue> = new Set([
  'split',
  'incomplete',
  'no-quant-label',
  'unsupported-quant',
  'unsupported-name',
  'pinned-revision',
]);

export const clean = (text: string | null | undefined): string => sanitizeTerminalText(text ?? '');

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '-';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}

export function runtimeLabel({ runtime, source }: RuntimeTarget): string {
  const name = runtime.kind === 'ollama' ? 'Ollama' : 'OpenAI-compatible server';
  return `${name} at ${runtime.baseUrl}${source === 'detected' ? ' (detected)' : ''}`;
}

/** Permissive only when at least one license is declared and every one is. */
export function licenseFor(
  detail: Pick<HubModelDetail, 'id' | 'licenses' | 'licenseName' | 'licenseLink'>,
  endpoint: string
): { label: string; link: string; restricted: boolean; plural: boolean } {
  const ids = detail.licenses.map(license => license.toLowerCase());
  const names = ids.map(id => (id === 'other' ? (detail.licenseName ?? id) : id));
  const label = names.length > 0 ? names.join(', ') : NO_LICENSE;
  const raw = detail.licenseLink;
  const link = !raw
    ? `${endpoint}/${detail.id}`
    : /^https?:\/\//i.test(raw)
      ? raw
      : `${endpoint}/${detail.id}/blob/main/${raw.replace(/^\.?\//, '')}`;
  return {
    label: clean(label),
    link: clean(link),
    restricted: ids.length === 0 || !ids.every(id => PERMISSIVE_LICENSES.has(id)),
    plural: ids.length > 1,
  };
}

export function gatedMessage(repo: string, endpoint: string): string {
  return [
    `${repo} is gated: the Hugging Face account must be granted access before anything can be downloaded.`,
    `  1. Request access at ${endpoint}/${repo}`,
    '  2. Set HF_TOKEN to a token of that account',
    `  3. Add your Ollama public key (~/.ollama/id_ed25519.pub) at ${HUGGING_FACE_SSH_KEYS_URL}, so Ollama's own download is allowed`,
  ].join('\n');
}

/** The message for a Hugging Face access refusal, or null for any other error. */
export function hubAccessMessage(error: unknown, endpoint: () => string): string | null {
  if (!(error instanceof HubAccessError)) return null;
  if (error.reason === 'gated') return gatedMessage(clean(error.repo), endpoint());
  return `Hugging Face refused ${clean(error.repo)}: check that HF_TOKEN is valid and can read it.`;
}

/** `www.`, a port and a trailing dot do not change which registry a host names. */
function registryHost(authority: string): string | null {
  const match = /^([^@:]+)(?::\d+)?$/.exec(authority);
  if (!match) return null;
  const host = match[1].toLowerCase();
  return host.replace(/\.+$/, '').replace(/^www\./, '');
}

/**
 * `owner/repo[:tag]` and Hugging Face URLs (any of its host spellings) are Hugging Face repos; `model[:tag]` and
 * names on Ollama's own registry are Ollama names. Any other host is refused, so no spelling skips the checks.
 */
export function parsePullTarget(input: string): PullTarget {
  const trimmed = input.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed);
  if (scheme && !/^https?$/i.test(scheme[1])) throw new Error(`Unsupported model ref: ${input}`);
  const afterScheme = scheme ? trimmed.slice(scheme[0].length) : trimmed;
  const slash = afterScheme.indexOf('/');
  const first = slash === -1 ? afterScheme : afterScheme.slice(0, slash);
  const namesHost = scheme !== null || (slash !== -1 && /[.:@]/.test(first));
  const host = namesHost ? registryHost(first) : null;
  if (namesHost && !host) throw new Error(`Unsupported model ref: ${input}`);
  const rest = host ? (slash === -1 ? '' : afterScheme.slice(slash + 1)) : afterScheme;

  if (host && OLLAMA_REGISTRY_HOSTS.has(host)) {
    // Ollama lists `library/x` pulls as `x`, so the name printed after the pull must be that one.
    const name = rest.replace(/^library\//i, '');
    if (!name) throw new Error(`Not an Ollama model name: ${input}`);
    return { kind: 'ollama', name };
  }
  if (host && !HF_HOSTS.has(host)) {
    throw new Error(
      `Unsupported registry ${host} in ${input}. Pull from Hugging Face (owner/repo[:quant]) or Ollama (model[:tag]).`
    );
  }
  const colon = rest.lastIndexOf(':');
  const hasTag = colon > rest.lastIndexOf('/');
  const path = hasTag ? rest.slice(0, colon) : rest;
  const tag = hasTag ? rest.slice(colon + 1) : null;
  const segments = path.split('/');
  if (!host && segments.length === 1) return { kind: 'ollama', name: rest };
  if (!isHubRepoId(path) || tag === '') {
    throw new Error(`Not a Hugging Face repo: ${input} (expected owner/name[:quant])`);
  }
  return { kind: 'hub', repo: path, tag };
}

/** Matches the tag against each build's planned ref, then its quant label; no tag or `latest` means Q4_K_M. */
export function pickBuild(builds: HubGgufBuild[], tag: string | null): HubGgufBuild | undefined {
  // Ollama tags an untagged hf.co pull `latest`, so users copy that form back.
  const wanted = (tag && tag.toLowerCase() !== 'latest' ? tag : DEFAULT_QUANT).toUpperCase();
  return (
    builds.find(build => build.ollamaRef?.slice(build.ollamaRef.lastIndexOf(':') + 1).toUpperCase() === wanted) ??
    builds.find(build => build.quant === wanted)
  );
}

export async function resolveRuntimeTarget(
  hosts: { flag?: string; env?: string; config?: string },
  detect: () => Promise<DetectedRuntime[]> = () => detectRuntimes(),
  createOllama: (baseUrl: string) => LocalRuntime = baseUrl => new OllamaRuntime({ baseUrl })
): Promise<RuntimeTarget> {
  const configured: [RuntimeSource, string | undefined][] = [
    ['flag', hosts.flag],
    ['env', hosts.env],
    ['config', hosts.config],
  ];
  const chosen = configured.find(([, host]) => host);
  if (chosen?.[1]) {
    const runtime = createOllama(withDefaultOllamaPort(chosen[1]));
    const health = await runtime.health();
    if (!health.ok) throw new Error(`Ollama at ${runtime.baseUrl} is unreachable: ${health.error}`);
    return { runtime, source: chosen[0] };
  }
  const detected = (await detect()).filter(entry => entry.health.ok);
  const pick = detected.find(entry => entry.runtime.kind === 'ollama') ?? detected[0];
  if (!pick) {
    throw new Error(
      'No local model runtime found. Start Ollama (https://ollama.com/download), or point the CLI at one with: ' +
        'b4m models ls --ollama-host http://<host>:11434'
    );
  }
  return { runtime: pick.runtime, source: 'detected' };
}

export type InstalledRow = InstalledModel & { loaded: boolean; default: boolean };

export async function listInstalled(
  runtime: LocalRuntime,
  defaultModel: string | undefined,
  signal: AbortSignal
): Promise<InstalledRow[]> {
  const [models, loaded] = await abortable(
    Promise.all([runtime.list(), runtime.capabilities.reportsLoaded ? runtime.loaded() : Promise.resolve([])]),
    signal
  );
  const loadedNames = new Set(loaded.map(model => model.name));
  return models.map(model => ({
    ...model,
    loaded: loadedNames.has(model.name),
    default: model.name === defaultModel,
  }));
}

export function normalizeModelName(name: string): string {
  const withoutLibrary = name.replace(/^library\//i, '');
  return withoutLibrary.lastIndexOf(':') > withoutLibrary.lastIndexOf('/')
    ? withoutLibrary
    : `${withoutLibrary}:latest`;
}

export function requireRemovable(target: RuntimeTarget): void {
  if (!target.runtime.capabilities.canRemove) throw new Error(`${runtimeLabel(target)} cannot remove models.`);
}

export async function removeInstalled(target: RuntimeTarget, name: string, signal: AbortSignal): Promise<void> {
  try {
    await abortable(target.runtime.remove(name), signal);
  } catch (error) {
    if (error instanceof ModelNotFoundError)
      throw new Error(`No model named ${clean(name)} on ${runtimeLabel(target)}.`);
    throw error;
  }
}

async function requirePullable(deps: ModelSourceDeps): Promise<RuntimeTarget> {
  const target = await abortable(deps.resolveRuntime(), deps.signal);
  if (!target.runtime.capabilities.canPull) throw new Error(`${runtimeLabel(target)} cannot download models.`);
  return target;
}

type RegistryReader = Pick<ModelSourceDeps, 'ollamaRegistry' | 'signal'>;

async function readRegistry(name: string, deps: RegistryReader): Promise<OllamaManifestInfo> {
  try {
    return await abortable(deps.ollamaRegistry(name, deps.signal), deps.signal);
  } catch (error) {
    if (error instanceof CancelledError || deps.signal.aborted) throw new CancelledError();
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read ${name} from the Ollama registry, so nothing was downloaded: ${reason}`);
  }
}

/** The first 12 hex digits, the length Ollama shows digests at. */
export function shortDigest(digest: string): string {
  return digest.replace(/^sha256:/, '').slice(0, 12);
}

function changedSinceReview(subject: string, what: string): Error {
  return new Error(
    `${subject} changed since you reviewed it (${what}), so nothing was downloaded. Pull it again to review the new version.`
  );
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((entry, index) => entry === b[index]);

/**
 * Re-reads the manifest after the user approved it, because Ollama then pulls by tag and a tag can move.
 * Refuses when the license texts or layers differ from the ones shown.
 */
export async function requireUnchangedManifest(
  name: string,
  shown: OllamaManifestInfo,
  deps: RegistryReader
): Promise<void> {
  const now = await readRegistry(name, deps);
  if (!sameList(now.licenses, shown.licenses)) throw changedSinceReview(clean(name), 'its license text changed');
  if (!sameList(now.layers, shown.layers)) {
    throw changedSinceReview(clean(name), `the registry now serves ${shortDigest(now.digest)}`);
  }
}

/** Re-reads the repo after the user approved it and refuses when its declared licenses differ from the ones shown. */
export async function requireUnchangedLicenses(
  hub: HubClient,
  detail: HubModelDetail,
  shown: { label: string; link: string },
  signal: AbortSignal
): Promise<void> {
  const currentDetail = await hub.getModel(detail.id, { signal, refresh: true });
  const now = licenseFor(currentDetail, hub.endpoint);
  if (!sameList(currentDetail.licenses, detail.licenses) || now.label !== shown.label || now.link !== shown.link) {
    throw changedSinceReview(clean(detail.id), `its license is now ${now.label}`);
  }
}

async function planOllamaPull(name: string, deps: ModelSourceDeps): Promise<OllamaPullPlan> {
  const { page } = parseOllamaName(name);
  const target = await requirePullable(deps);
  const manifest = await readRegistry(name, deps);
  const license = classifyLicenses(manifest.licenses);
  return {
    kind: 'ollama',
    target,
    name,
    manifest,
    license: { label: clean(license.title), link: page, restricted: !license.permissive },
  };
}

/**
 * Everything to show and check before a pull, read without downloading: the build, its size, every declared
 * license, and the runtime it goes to. Throws for gated repos, missing or unpullable builds, and other hosts.
 * `pullCommand` names how to retry with a quant in the no-such-build error.
 */
export async function planPull(
  input: string,
  deps: ModelSourceDeps,
  pullCommand = 'b4m models pull'
): Promise<PullPlan> {
  const parsed = parsePullTarget(input);
  if (parsed.kind === 'ollama') return planOllamaPull(parsed.name, deps);

  const hub = deps.hub();
  let detail = await hub.getModel(parsed.repo, { signal: deps.signal });
  // A cached refusal can outlive an access grant in a long-lived MCP session.
  if (detail.gated && detail.canDownload !== true) {
    detail = await hub.getModel(parsed.repo, { signal: deps.signal, refresh: true });
  }
  const id = clean(detail.id);
  if (detail.gated && detail.canDownload !== true) throw new Error(gatedMessage(id, hub.endpoint));

  const build = pickBuild(detail.builds, parsed.tag);
  if (!build) {
    const quants = [...new Set(detail.builds.map(entry => entry.quant).filter(Boolean))].map(clean);
    throw new Error(
      quants.length === 0
        ? `${id} has no GGUF builds.`
        : `${id} has no ${clean(parsed.tag ?? DEFAULT_QUANT)} build. Pick one of: ${quants.join(', ')} (${pullCommand} ${id}:<QUANT>)`
    );
  }
  if (build.ollamaRefIssue && UNPULLABLE.has(build.ollamaRefIssue)) {
    throw new Error(`Ollama cannot pull ${id} ${clean(build.quant)}: ${REF_ISSUES[build.ollamaRefIssue]}.`);
  }

  const target = await requirePullable(deps);
  return {
    kind: 'hub',
    target,
    hub,
    detail,
    build,
    id,
    license: licenseFor(detail, hub.endpoint),
    projectorBytes: largestProjectorBytes(detail),
  };
}

/** The largest vision projector Ollama's Hugging Face registry may add to a pull from this repo; 0 when none. */
export function largestProjectorBytes(detail: Pick<HubModelDetail, 'projectors'>): number {
  return Math.max(0, ...detail.projectors.map(entry => entry.sizeBytes));
}
