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
