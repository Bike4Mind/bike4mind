import type { HubFamily, HubManifest } from '@bike4mind/common';
import { curatedBuildForRef } from '@bike4mind/local-models';
import { normalizeGeneration, type CatalogSampling, type GenerationSettings } from '@shared/generation';

type FamilySampling = NonNullable<HubFamily['sampling']['thinking']>;

function toGeneration(sampling: FamilySampling | undefined): GenerationSettings | undefined {
  if (!sampling) return undefined;
  return normalizeGeneration({
    temperature: sampling.temperature,
    topP: sampling.top_p,
    topK: sampling.top_k,
    minP: sampling.min_p,
    presencePenalty: sampling.presence_penalty,
    repeatPenalty: sampling.repeat_penalty,
  });
}

/**
 * The family sampling for the reviewed build Ollama lists as `ollamaName`, under any spelling of its
 * pull ref; undefined for any other model, or a family that states none.
 */
export function catalogSampling(manifest: HubManifest, ollamaName: string): CatalogSampling | undefined {
  const reviewed = curatedBuildForRef(manifest, ollamaName);
  const family = reviewed ? manifest.families[reviewed.entry.family] : undefined;
  if (!family) return undefined;
  const thinking = toGeneration(family.sampling.thinking);
  const nonThinking = toGeneration(family.sampling.nonThinking);
  if (!thinking && !nonThinking) return undefined;
  return { ...(thinking ? { thinking } : {}), ...(nonThinking ? { nonThinking } : {}) };
}
