import { OLLAMA_DRAFT_LAYER_DEFAULT } from '@bike4mind/common';
import { modelBlobsOf } from '@bike4mind/local-models';
import type { ModelLoadSettings } from '@shared/modelSettings';
import { modelfileParameter } from './modelControls';

export interface DraftFacts {
  /** `<arch>.nextn_predict_layers`: an embedded MTP head. */
  mtpLayers: number;
  /** A Modelfile DRAFT layer: a sidecar draft model. */
  draftLayer: boolean;
  /** `/api/show`'s PARAMETER lines. */
  parameters?: string | null;
}

/**
 * Whether Ollama can speculate with this model and the draft count it runs at untouched: the
 * Modelfile's, else 4 with a DRAFT layer and 0 (off) with only an embedded head. Undefined when it cannot.
 */
export function ollamaDraft({ mtpLayers, draftLayer, parameters }: DraftFacts): { modelDefault: number } | undefined {
  if (mtpLayers <= 0 && !draftLayer) return undefined;
  const set = modelfileParameter(parameters ?? undefined, 'draft_num_predict');
  const valid = set !== undefined && Number.isInteger(set) && set >= 0;
  return { modelDefault: valid ? set : draftLayer ? OLLAMA_DRAFT_LAYER_DEFAULT : 0 };
}

/** The facts ollamaDraft needs from an `/api/show` answer. */
export function draftFactsOf(show: {
  model_info?: Record<string, unknown> | null;
  modelfile?: string;
  parameters?: string;
}): DraftFacts {
  const layers = Object.entries(show.model_info ?? {}).find(([key]) => key.endsWith('.nextn_predict_layers'))?.[1];
  return {
    mtpLayers: typeof layers === 'number' && Number.isFinite(layers) ? layers : 0,
    draftLayer: (modelBlobsOf(show.modelfile).draftBlobs?.length ?? 0) > 0,
    parameters: show.parameters,
  };
}

/** The draft count the model runs at with these settings, which fit plans for; 0 when it does not speculate. */
export function draftTokensOf(load: ModelLoadSettings, facts: DraftFacts): number {
  const draft = ollamaDraft(facts);
  return draft ? (load.draftTokens ?? draft.modelDefault) : 0;
}

/** What an Ollama request carries for the load settings; the same on every request, or the runner reloads. */
export function ollamaLoadFields(
  load: ModelLoadSettings,
  facts: DraftFacts
): { keepAlive: { keep_alive?: number }; options: { draft_num_predict?: number } } {
  return {
    keepAlive: load.keepAlive !== undefined ? { keep_alive: load.keepAlive } : {},
    options: load.draftTokens !== undefined && ollamaDraft(facts) ? { draft_num_predict: load.draftTokens } : {},
  };
}
