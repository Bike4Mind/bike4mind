import type { HubFamily, HubManifest } from '@bike4mind/common';
import { curatedBuildForInstalled } from '@bike4mind/local-models';
import { normalizeGeneration, type CatalogSampling, type GenerationSettings } from '@shared/generation';
import { modelfileParameter } from '../chat/modelControls';

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

const SAMPLING_PARAMETERS = [
  'temperature',
  'top_p',
  'top_k',
  'min_p',
  'repeat_penalty',
  'presence_penalty',
] as const satisfies readonly (keyof FamilySampling)[];

/** True when the Modelfile sets a sampling value the family's thinking sampling does not, so the model's own wins. */
function setsOtherSampling(parameters: string | undefined, family: HubFamily): boolean {
  return SAMPLING_PARAMETERS.some(key => {
    const set = modelfileParameter(parameters, key);
    return set !== undefined && set !== family.sampling.thinking?.[key];
  });
}

/**
 * The family sampling for the curated build a server lists as `name` with weights blob `modelBlob`, matched as
 * curatedBuildForInstalled does; undefined for any other model, or a family that states none. A model keeps its
 * own sampling PARAMETERs over the seed when it sets any that differ, whichever way it was matched.
 */
export function catalogSampling(
  manifest: HubManifest,
  name: string,
  modelBlob?: string,
  parameters?: string
): CatalogSampling | undefined {
  const reviewed = curatedBuildForInstalled(manifest, { name, modelBlob });
  const family = reviewed ? manifest.families[reviewed.entry.family] : undefined;
  if (!reviewed || !family) return undefined;
  if (setsOtherSampling(parameters, family)) return undefined;
  const thinking = toGeneration(family.sampling.thinking);
  const nonThinking = toGeneration(family.sampling.nonThinking);
  if (!thinking && !nonThinking) return undefined;
  return { ...(thinking ? { thinking } : {}), ...(nonThinking ? { nonThinking } : {}) };
}
