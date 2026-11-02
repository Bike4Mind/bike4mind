import type { HubBuild, HubEntry } from '@bike4mind/common/modelHub';
import { isAbliteratedModel } from '../abliterated';
import { curatedLibrary, isPermissiveEntry } from '../curated';
import type { HubGgufBuild, HubModelDetail } from '../huggingface';
import { licenseKind } from '../licenses';
import type { OllamaRegistryLayers, RuntimeHealth } from '../types';
import { checkReviewedLayers, checkRuntime, type LayersCheck, type LayerSources, type RuntimeCheck } from './checks';

/** The Hub calls an approval check makes; `HuggingFaceHub` satisfies it. */
export interface PullCheckHub {
  getModel(repo: string, options?: { signal?: AbortSignal; refresh?: boolean }): Promise<HubModelDetail>;
  verifyOllamaRef(
    detail: HubModelDetail,
    build: HubGgufBuild,
    options?: { signal?: AbortSignal }
  ): Promise<string | null>;
  ollamaLayers(repo: string, tag: string, options?: { signal?: AbortSignal }): Promise<OllamaRegistryLayers | null>;
}

/** The Curated list's reviewed build an approval names; its pins are checked before the download. */
export interface ApprovedCurated {
  entry: HubEntry;
  build: HubBuild;
}

/** A Hugging Face build as the pull dialog showed it. */
export interface HubPullApproval {
  source: 'hf';
  repo: string;
  buildId: string;
  /** The commit the user reviewed; a card edit such as a new license is a new commit. */
  revision: string;
  sizeBytes: number;
  licenseAccepted: boolean;
  accessConfirmed: boolean;
  curated: ApprovedCurated | null;
}

/** A Curated Ollama library build, which has no Hugging Face repo: its manifest digest stands in for a revision. */
export interface LibraryPullApproval {
  source: 'library';
  ref: string;
  buildId: string;
  manifestDigest: string;
  sizeBytes: number;
  licenseAccepted: boolean;
  curated: ApprovedCurated;
}

export type PullApproval = HubPullApproval | LibraryPullApproval;

/** Why Ollama cannot pull a Hugging Face build, or cannot be shown to get exactly its file. */
export type PullBlock =
  'split' | 'incomplete' | 'no-quant-label' | 'unsupported-name' | 'unsupported-quant' | 'no-checksum' | 'needs-access';

export function pullBlock(detail: Pick<HubModelDetail, 'ollamaNeedsSshKey'>, build: HubGgufBuild): PullBlock | null {
  if (build.split) return 'split';
  if (!build.complete) return 'incomplete';
  if (build.ollamaRefIssue === 'no-quant-label') return 'no-quant-label';
  if (build.ollamaRefIssue === 'unsupported-name') return 'unsupported-name';
  if (build.ollamaRefIssue === 'unsupported-quant') return 'unsupported-quant';
  // The Hub hides a gated or private file's checksum from a reader without access.
  if (!build.files[0]?.sha256) return detail.ollamaNeedsSshKey ? 'needs-access' : 'no-checksum';
  return null;
}

const licenseSet = (ids: readonly string[]) => [...new Set(ids.map(id => id.toLowerCase()))].sort().join(',');

/** True when the repo's card and its base model's card declare the reviewed licenses, no more, no fewer. */
export async function curatedLicensesMatch(
  entry: HubEntry,
  detail: Pick<HubModelDetail, 'licenses'>,
  hub: () => PullCheckHub | Promise<PullCheckHub>,
  signal?: AbortSignal
): Promise<boolean> {
  if (licenseSet(detail.licenses) !== licenseSet([entry.license.cardTag ?? entry.license.id])) return false;
  const base = await (await hub()).getModel(entry.lineage.base, { signal });
  return licenseSet(base.licenses) === licenseSet([entry.license.base.id]);
}

/** `ref` is the name Ollama pulls, proven to serve the approved file. */
export type ApprovalResult =
  | { ok: true; ref: string }
  | {
      ok: false;
      reason:
        | 'not-listed'
        | 'cancelled'
        | 'build-missing'
        | 'changed'
        | 'abliterated'
        | 'license-changed'
        | 'license-required'
        | 'access-required'
        | 'unverified';
    }
  | { ok: false; reason: 'blocked'; block: PullBlock }
  | Exclude<RuntimeCheck, { ok: true }>
  | Exclude<LayersCheck, { ok: true }>;

export type ApprovalFailure = Exclude<ApprovalResult, { ok: true }>;

export interface ApprovalDeps {
  /** Asked again for the license and layer reads; getModel and verifyOllamaRef share one client. */
  hub: () => PullCheckHub | Promise<PullCheckHub>;
  libraryLayers: LayerSources['libraryLayers'];
  /** The target runtime's health, read once the approval itself checks out. */
  health: () => Promise<RuntimeHealth>;
  signal: AbortSignal;
  /** Called once the build is known and approved, before the runtime is asked. */
  onReviewed?: (build: { label: string; sizeBytes: number }) => void;
}

export const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export const hubBuildId = (path: string) => path.replace(/\.gguf$/i, '');

/**
 * Re-checks what the user approved against the source as it is now, without downloading anything. Hub and
 * registry errors propagate; each refusal is a reason the caller words for its own surface.
 */
export function checkApproval(approval: PullApproval, deps: ApprovalDeps): Promise<ApprovalResult> {
  return approval.source === 'library' ? checkLibrary(approval, deps) : checkHub(approval, deps);
}

async function checkHub(approval: HubPullApproval, deps: ApprovalDeps): Promise<ApprovalResult> {
  const { curated, repo } = approval;
  const { signal } = deps;
  if (
    curated &&
    (!curated.build.hf ||
      !sameRepo(curated.build.hf.repo, repo) ||
      hubBuildId(curated.build.weights[0].path) !== approval.buildId)
  )
    return { ok: false, reason: 'not-listed' };
  const hub = await deps.hub();
  const detail = await hub.getModel(repo, { refresh: true });
  if (signal.aborted) return { ok: false, reason: 'cancelled' };
  const build = detail.builds.find(candidate => candidate.id === approval.buildId);
  if (!build) return { ok: false, reason: 'build-missing' };
  if (detail.revision !== approval.revision || build.sizeBytes !== approval.sizeBytes)
    return { ok: false, reason: 'changed' };
  if (curated) {
    if (isAbliteratedModel(detail)) return { ok: false, reason: 'abliterated' };
    if (!(await curatedLicensesMatch(curated.entry, detail, deps.hub, signal)))
      return { ok: false, reason: 'license-changed' };
  }
  const block = pullBlock(detail, build);
  if (block) return { ok: false, reason: 'blocked', block };
  const restricted = licenseKind(detail.licenses) !== 'permissive' || (curated && !isPermissiveEntry(curated.entry));
  if (restricted && !approval.licenseAccepted) return { ok: false, reason: 'license-required' };
  if (detail.ollamaNeedsSshKey && !approval.accessConfirmed) return { ok: false, reason: 'access-required' };
  deps.onReviewed?.({ label: build.label, sizeBytes: build.sizeBytes });

  const health = await deps.health();
  if (signal.aborted) return { ok: false, reason: 'cancelled' };
  const runtime = checkRuntime(health, curated?.build ?? null);
  if (!runtime.ok) return runtime;
  // The registry serves the first file whose name ends with the tag; only its manifest proves which one.
  const ref = await hub.verifyOllamaRef(detail, build, { signal });
  if (signal.aborted) return { ok: false, reason: 'cancelled' };
  if (!ref) return { ok: false, reason: 'unverified' };
  if (curated) {
    const tag = ref.slice(ref.lastIndexOf(':') + 1);
    const layers = await checkReviewedLayers(curated.build, tag, layerSources(deps), signal);
    if (!layers.ok) return layers;
  }
  return { ok: true, ref };
}

async function checkLibrary(approval: LibraryPullApproval, deps: ApprovalDeps): Promise<ApprovalResult> {
  const { curated } = approval;
  const library = curatedLibrary(curated.build);
  if (!library || approval.ref !== library.ref || approval.buildId !== curated.build.id)
    return { ok: false, reason: 'not-listed' };
  if (approval.manifestDigest !== library.digest || approval.sizeBytes !== library.sizeBytes)
    return { ok: false, reason: 'changed' };
  if (!isPermissiveEntry(curated.entry) && !approval.licenseAccepted) return { ok: false, reason: 'license-required' };
  deps.onReviewed?.({ label: curated.build.quant.label, sizeBytes: library.sizeBytes });

  const health = await deps.health();
  if (deps.signal.aborted) return { ok: false, reason: 'cancelled' };
  const runtime = checkRuntime(health, curated.build);
  if (!runtime.ok) return runtime;
  const layers = await checkReviewedLayers(curated.build, null, layerSources(deps), deps.signal);
  if (!layers.ok) return layers;
  return { ok: true, ref: library.ref };
}

function layerSources(deps: ApprovalDeps): LayerSources {
  return {
    libraryLayers: deps.libraryLayers,
    hfLayers: async (repo, tag, options) => (await deps.hub()).ollamaLayers(repo, tag, options),
  };
}
