import type { HubBuild } from '@bike4mind/common/modelHub';
import { curatedLibrary, curatedOllamaBlocked, installedReviewed, servesReviewed } from '../curated';
import type { ModelInspection, OllamaRegistryLayers, RuntimeHealth } from '../types';

export type RuntimeCheck =
  | { ok: true }
  | { ok: false; reason: 'runtime-unreachable'; error: string | null }
  | { ok: false; reason: 'runtime-too-old'; blocked: string; required: string; actual: string | null };

/** Refuses unless the runtime answered and, for a curated `build`, reports a version new enough for it. */
export function checkRuntime(health: RuntimeHealth, build: HubBuild | null): RuntimeCheck {
  if (!health.ok) return { ok: false, reason: 'runtime-unreachable', error: health.error };
  const blocked = build && curatedOllamaBlocked(build, health.version);
  return blocked && build?.runtimeMin?.ollama
    ? { ok: false, reason: 'runtime-too-old', blocked, required: build.runtimeMin.ollama, actual: health.version }
    : { ok: true };
}

export interface LayerSources {
  /** The layers the Ollama library serves for a `name:tag` ref; null when it has no such tag. */
  libraryLayers: (ref: string, options: { signal?: AbortSignal }) => Promise<OllamaRegistryLayers | null>;
  /** The layers Hugging Face's registry serves Ollama for a repo and tag; null when it serves none. */
  hfLayers: (repo: string, tag: string, options: { signal?: AbortSignal }) => Promise<OllamaRegistryLayers | null>;
}

export type LayersCheck =
  { ok: true } | { ok: false; reason: 'layers-no-source' | 'layers-not-served' | 'layers-changed' };

/**
 * Refuses a curated build unless its source serves the reviewed weights and exactly its pinned other layers.
 * `hfTag` is the tag of the hf.co ref Ollama pulls; a library build needs none.
 */
export async function checkReviewedLayers(
  build: HubBuild,
  hfTag: string | null,
  sources: LayerSources,
  signal?: AbortSignal
): Promise<LayersCheck> {
  const library = curatedLibrary(build);
  let live: OllamaRegistryLayers | null;
  if (library) live = await sources.libraryLayers(library.ref, { signal });
  else if (build.hf && hfTag) live = await sources.hfLayers(build.hf.repo, hfTag, { signal });
  else return { ok: false, reason: 'layers-no-source' };
  if (!live) return { ok: false, reason: 'layers-not-served' };
  return servesReviewed(live, build) ? { ok: true } : { ok: false, reason: 'layers-changed' };
}

export type InstalledCheck =
  | { ok: true }
  | { ok: false; outcome: 'left-in-place'; hadTag: boolean | null }
  | { ok: false; outcome: 'removed' | 'remove-failed' };

/**
 * After a curated pull: passes when Ollama installed the reviewed build. Anything else is removed only when the tag
 * was definitely absent before (`hadTag` false), since a tag that was already there is the user's.
 */
export async function checkInstalledDigest(
  inspection: ModelInspection,
  reviewed: HubBuild,
  { hadTag, remove }: { hadTag: boolean | null; remove: () => Promise<void> }
): Promise<InstalledCheck> {
  if (installedReviewed(inspection, reviewed)) return { ok: true };
  if (hadTag !== false) return { ok: false, outcome: 'left-in-place', hadTag };
  try {
    await remove();
  } catch {
    return { ok: false, outcome: 'remove-failed' };
  }
  return { ok: false, outcome: 'removed' };
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((entry, index) => entry === b[index]);

/** Whether two license id lists differ, ignoring order. */
export function licensesChanged(reviewed: readonly string[], now: readonly string[]): boolean {
  return !sameList([...reviewed].sort(), [...now].sort());
}

/** An Ollama registry manifest as read before a pull; compared again once the user approved it. */
export interface RegistryManifestFacts {
  /** One text per license layer. */
  licenses: readonly string[];
  /** Every layer's digest, in manifest order. */
  layers: readonly string[];
}

/** What changed in a registry manifest since it was shown, licenses first; null when nothing did. */
export function manifestChange(shown: RegistryManifestFacts, now: RegistryManifestFacts): 'licenses' | 'layers' | null {
  if (!sameList(now.licenses, shown.licenses)) return 'licenses';
  if (!sameList(now.layers, shown.layers)) return 'layers';
  return null;
}
