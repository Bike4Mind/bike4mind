import { createHash } from 'node:crypto';
import {
  CURATED_SLOTS,
  MIN_CHAT_CONTEXT,
  curatedTier,
  parseHubManifest,
  type HardwareProfile,
  type HubBuild,
  type HubEntry,
  type HubManifest,
  type HubTier,
  type HubTierPick,
} from '@bike4mind/common';
// The repo's one curated list, bundled at build time; the hub schema validates it in loadCuratedManifest.test.ts.
import bundled from '../../../catalog/model-hub/curated-v2.json';
import { isAbliteratedModel } from './abliterated';
import type { ModelInspection, OllamaRegistryLayers } from './types';

const EMPTY = { schemaVersion: 2, updatedAt: '1970-01-01T00:00:00Z', families: {}, rankings: {}, entries: [] };
const SHOWN_DROPS = 5;

/**
 * The curated list from `input` (a fetched list can be passed here), never throwing: unreadable input falls back to
 * the bundled list, and what the reader dropped is logged by path and reason.
 */
export function loadCuratedManifest(warn: (message: string) => void, input: unknown = bundled): HubManifest {
  try {
    const { manifest, dropped } = parseHubManifest(input);
    if (dropped.length > 0) {
      const shown = dropped.slice(0, SHOWN_DROPS).map(drop => `${drop.path}: ${drop.reason}`);
      warn(`MODELS: curated list dropped ${dropped.length} item(s): ${shown.join('; ')}`);
    }
    return manifest;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown';
    if (input !== bundled) {
      warn(`MODELS: curated list unreadable, showing the bundled one: ${reason}`);
      return loadCuratedManifest(warn);
    }
    warn(`MODELS: bundled curated list unreadable, showing none: ${reason}`);
    return parseHubManifest(EMPTY).manifest;
  }
}

/** Permissive only when the entry's own license and its base model's both are. */
export const isPermissiveEntry = (entry: HubEntry) =>
  entry.license.class === 'permissive' && entry.license.base.class === 'permissive';

export const curatedLibrary = (build: HubBuild) => (build.ollama?.kind === 'library' ? build.ollama : null);

export const curatedPins = (build: HubBuild) =>
  build.ollama?.kind === 'library' || build.ollama?.kind === 'hf-pull' ? build.ollama.layers : undefined;

/** Abliterated entries never reach Curated, whatever the manifest policy says. */
export function isCuratedListable(entry: HubEntry, manifest: HubManifest): boolean {
  if (entry.flags.abliterated || entry.lineage.variantType === 'abliterated' || entry.license.legal === 'blocked')
    return false;
  if (entry.roles.includes('chat') && entry.arch.contextMax < MIN_CHAT_CONTEXT) return false;
  const sources = entry.builds.map(build => build.hf?.repo ?? curatedLibrary(build)?.ref ?? '');
  if (isAbliteratedModel({ id: entry.id, tags: [entry.name, ...sources], baseModels: [entry.lineage.base] }))
    return false;
  return isPermissiveEntry(entry) || manifest.policy.restrictedLicense === 'curated-labelled';
}

// The library serves a tag whole; hf.co serves one file per tag, so only single-file builds without a separate
// projector qualify there, and only with the template pinned, since hf.co builds it from the repo's main branch.
export function isCuratedPullable(build: HubBuild): boolean {
  const pins = curatedPins(build);
  if (!pins) return false;
  if (curatedLibrary(build)) return true;
  return !!(pins.installedTemplate ?? pins.template) && !!build.hf && build.weights.length === 1 && !build.mmproj;
}

export function curatedParamsLabel(entry: HubEntry): string {
  const { totalB, activeB } = entry.params;
  return activeB === null ? `${totalB}B` : `${totalB}B, ${activeB}B active`;
}

// Pre-release suffixes are dropped on purpose (0.32.12-rc1 meets a 0.32.12 floor); a dev build
// reporting 0.0.0 is blocked, which is the safe side.
const versionParts = (text: string) => /^v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim())?.slice(1).map(Number);

/** Why this Ollama cannot download the build; one with a minimum is blocked while Ollama reports no version. */
export function curatedOllamaBlocked(build: HubBuild, version: string | null): string | null {
  const minimum = build.runtimeMin?.ollama;
  const want = minimum && versionParts(minimum);
  if (!minimum || !want) return null;
  const needs = `Needs Ollama ${minimum} or newer`;
  const have = version ? versionParts(version) : undefined;
  if (!have) return `${needs}, and Ollama did not report its version`;
  const differs = have.findIndex((part, index) => part !== want[index]);
  return differs !== -1 && have[differs] < want[differs] ? needs : null;
}

export interface CuratedSource {
  /** The Ollama library ref, or the Hugging Face repo. */
  repo: string;
  /** The library build id, or the Hugging Face file name without `.gguf`. */
  pullBuildId: string;
  /** What Ollama downloads, projector included. */
  sizeBytes: number;
  /** The ref Ollama pulls it by. */
  ollamaRef: string;
}

/** Where a pullable curated build downloads from. */
export function curatedSource(build: HubBuild): CuratedSource {
  const library = curatedLibrary(build);
  if (library)
    return { repo: library.ref, pullBuildId: build.id, sizeBytes: library.sizeBytes, ollamaRef: library.ref };
  const repo = build.hf?.repo ?? '';
  const file = build.weights[0];
  return {
    repo,
    pullBuildId: file.path.replace(/\.gguf$/i, ''),
    sizeBytes: file.sizeBytes + (curatedPins(build)?.projectorBytes ?? 0),
    ollamaRef: `hf.co/${repo}:${build.quant.label}`,
  };
}

export interface CuratedListing {
  entry: HubEntry;
  /** Pullable builds only, in manifest order. */
  builds: HubBuild[];
}

const smallest = (listing: CuratedListing) => Math.min(...listing.builds.map(build => curatedSource(build).sizeBytes));

/** The entries Curated offers, smallest download first; an entry with no pullable build is left out. */
export function curatedListing(manifest: HubManifest): CuratedListing[] {
  return manifest.entries
    .filter(entry => isCuratedListable(entry, manifest))
    .map(entry => ({ entry, builds: entry.builds.filter(isCuratedPullable) }))
    .filter(listing => listing.builds.length > 0)
    .sort((a, b) => smallest(a) - smallest(b));
}

/** The offered entry and build Ollama pulls by `ref`, ignoring case; null when Curated offers none by that ref. */
export function curatedBuildForRef(manifest: HubManifest, ref: string): { entry: HubEntry; build: HubBuild } | null {
  const wanted = ref.toLowerCase();
  for (const { entry, builds } of curatedListing(manifest))
    for (const build of builds) if (curatedSource(build).ollamaRef.toLowerCase() === wanted) return { entry, build };
  return null;
}

/**
 * The entry that records the license of what Ollama pulls by `ref`, ignoring case: a library build by its ref, a
 * Hugging Face repo by any of its builds. Every entry counts, including ones Curated does not offer.
 */
export function curatedEntryForRef(manifest: HubManifest, ref: string): HubEntry | null {
  const wanted = ref.toLowerCase();
  const repo = wanted.startsWith('hf.co/') ? wanted.slice('hf.co/'.length).replace(/:[^/]*$/, '') : null;
  return (
    manifest.entries.find(entry =>
      entry.builds.some(build =>
        repo === null ? curatedLibrary(build)?.ref.toLowerCase() === wanted : build.hf?.repo.toLowerCase() === repo
      )
    ) ?? null
  );
}

const OLLAMA_LAYER = 'application/vnd.ollama.image.';
const PINNED_LAYERS = ['template', 'params', 'license', 'projector', 'draft'] as const;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const reviewedDigest = (build: HubBuild) => curatedLibrary(build)?.digest ?? build.weights[0]?.sha256;

/** The Modelfile's num_ctx, from the `parameters` text Ollama's /api/show prints. */
function configuredNumCtx(parameters: string | null | undefined): number | undefined {
  const value = Number(/^num_ctx[ \t]+(\S+)[ \t]*$/m.exec(parameters ?? '')?.[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** True while the registry serves the reviewed weights and exactly the pinned other layers, nothing more. */
export function servesReviewed(live: OllamaRegistryLayers, reviewed: HubBuild): boolean {
  const pins = curatedPins(reviewed);
  if (!pins || !live.model || live.model !== reviewedDigest(reviewed)) return false;
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
  const pins = curatedPins(reviewed);
  const contents = inspection.contents;
  if (!pins || !contents || contents.modelBlob !== reviewedDigest(reviewed)) return false;
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

export interface CuratedTierPick {
  pick: HubTierPick;
  entry: HubEntry;
  build: HubBuild;
}

/** This machine's tier and its picks that Curated offers, in slot order; no tier when the list has none for it. */
export function curatedPicks(
  manifest: HubManifest,
  hardware: HardwareProfile
): { tier: HubTier | null; picks: CuratedTierPick[] } {
  const tier = curatedTier(manifest.tiers, hardware);
  if (!tier) return { tier: null, picks: [] };
  const listing = curatedListing(manifest);
  const picks = tier.picks
    .flatMap(pick => {
      const listed = listing.find(candidate => candidate.entry.id === pick.entry);
      const build = listed?.builds.find(candidate => candidate.id === pick.build);
      return listed && build ? [{ pick, entry: listed.entry, build }] : [];
    })
    .sort((a, b) => CURATED_SLOTS.indexOf(a.pick.slot) - CURATED_SLOTS.indexOf(b.pick.slot));
  return { tier, picks };
}
