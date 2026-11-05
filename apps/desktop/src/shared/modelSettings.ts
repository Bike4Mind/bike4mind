/**
 * Per-model defaults set on the Models screen, stored in userData/model-settings.json by chat model
 * id (main/chat/ModelSettingsStore.ts). The format and its parser live in @bike4mind/local-models,
 * which the CLI reads the file with too.
 */

import type { LocalContextSize } from './localContextSetting';
import type { QuantizedKvCacheType } from './modelServers';

export {
  changedJsonPath,
  emptyStoredModelSettings,
  isDraftTokens,
  isEmptyModelSettings,
  isModelSettingsId,
  KEEP_ALIVE_CHOICES,
  MAX_DRAFT_TOKENS,
  parseModelSettingsFile,
  parseModelSettingsInput,
  quotedForMessage,
  storedModelEntry,
  type KeepAliveSeconds,
  type ModelEffort,
  type ModelLoadSettings,
  type ModelSettings,
  type StoredModelSettings,
  type UnsupportedModelSetting,
} from '@bike4mind/local-models/model-settings';

/** One context size the dialog offers, rated for this model. */
export interface ContextSizeOffer {
  size: LocalContextSize;
  /** The num_ctx a fixed `size` sends: the size, or the trained length when that is less. */
  tokens: number;
  /** What Auto sends with `size` as its cap. */
  autoTokens: number;
  /** Whether the model loads at `tokens` (main/chat/localContext.ts loadsInMemory); absent when unmeasured. */
  loads?: boolean;
}

/** The load-time options a model and its server take; main builds it per backend and the dialog draws only these. */
export interface ModelLoadOffer {
  context?:
    | {
        kind: 'ollama';
        /** What the model runs at while it follows the Settings choice. */
        settings: number;
        /** What Auto picks for it with no cap; Auto is offered only when Desktop can measure the model. */
        auto?: number;
        sizes: ContextSizeOffer[];
        /** The most a fixed size can send for this model; an Auto cap at or past it is the same as Auto. */
        ceiling?: number;
      }
    /** A context the server fixes: a smaller size here is a client budget that compacts sooner, never a reload. */
    | { kind: 'budget'; server: number; sizes: LocalContextSize[] };
  /** For a model with an MTP or draft layer: the draft count Ollama runs it with when none is set. */
  draft?: { modelDefault: number; max: number };
  keepAlive?: true;
  /** Ollama's KV cache type, set server-wide and never per model: the one entered in Settings, else f16. */
  kvCache?: { type: 'f16' | QuantizedKvCacheType };
}
