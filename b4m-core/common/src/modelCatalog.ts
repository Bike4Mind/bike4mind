import type { ModelInfo, ModelName } from './models';
import type { ModelRecord } from './types/entities/ModelCatalogTypes';

/**
 * Output cap used when a record does not declare maxOutputTokens. Under-requesting
 * truncates one long answer (visible and retryable); over-requesting 400s the whole
 * turn, so the unknown case degrades to the recoverable side.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/**
 * The model types this build's ModelInfo consumers narrow on. ModelRecord.type is
 * wider (embedding / tts / realtime-voice), so the read path drops and counts any
 * record outside this set: an old build must degrade to "I do not see the new video
 * models", never to a runtime narrowing failure.
 */
export const MODEL_INFO_TYPES = ['text', 'image', 'speech-to-text', 'video'] as const;

export type ModelInfoType = (typeof MODEL_INFO_TYPES)[number];

type Expect<T extends true> = T;
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/**
 * Compile-time guard: MODEL_INFO_TYPES must stay the exact ModelInfo.type union.
 * When ModelInfo.type widens, this breaks the build so the drop rule above is
 * revisited instead of silently filtering out a type consumers now handle.
 */
export type ModelInfoTypesMatchModelInfo = Expect<Equals<ModelInfoType, ModelInfo['type']>>;

/** A record this build can render as a ModelInfo. */
export type RenderableModelRecord = Omit<ModelRecord, 'type'> & { type: ModelInfoType };

export const isRenderableModelType = (type: string): type is ModelInfoType =>
  (MODEL_INFO_TYPES as readonly string[]).includes(type);

/**
 * Compile-time guard (T1): toModelInfo must turn a record carrying only the
 * required fields into a complete ModelInfo. If ModelInfo gains a required field
 * that no default covers, this stops compiling until someone decides where the
 * field comes from. Test files are outside tsconfig's include, so the assertion
 * lives here to be enforced by `pnpm turbo:typecheck`.
 */
type MinimalModelRecord = Pick<RenderableModelRecord, 'id' | 'vendor' | 'backend' | 'type' | 'name' | 'contextWindow'>;

export type ToModelInfoIsTotal = Expect<
  typeof toModelInfo extends (record: MinimalModelRecord) => ModelInfo ? true : false
>;

/**
 * The record -> ModelInfo adapter: one place where every ModelInfo field a
 * catalog record does not carry gets its default. Each default degrades to the
 * visible, recoverable behavior rather than the silent or expensive one.
 *
 * Pricing is never sourced here: applyModelPriceCatalog overlays the ModelPrice
 * rows afterwards, and an empty map trips the [UNPRICED_MODEL] alarm on first
 * billed use, which is the intended fail-loud path.
 */
export function toModelInfo(record: RenderableModelRecord): ModelInfo {
  // Either owner can block a model and neither can clear the other's block:
  // operators write disabled, discovery writes autoDisabled.
  const disabled = record.disabled === true || record.autoDisabled === true;

  return {
    // ModelInfo.id is still the ModelName union; widening it to string is the
    // consumer-migration phase, and the adapters already cast live ids this way.
    id: record.id as ModelName,
    type: record.type,
    name: record.name,
    backend: record.backend,
    contextWindow: record.contextWindow,
    max_tokens: record.maxOutputTokens ?? Math.min(record.contextWindow, DEFAULT_MAX_OUTPUT_TOKENS),
    pricing: {},
    can_stream: record.canStream,
    can_think: record.reasoning?.supported ?? false,
    thinkingStyle: toThinkingStyle(record),
    supportsVision: record.supportsVision,
    supportsTools: record.supportsTools,
    supportsImageVariation: record.supportsImageVariation ?? false,
    supportsSafetyTolerance: record.supportsSafetyTolerance,
    freeToRun: record.freeToRun,
    private: record.private ?? false,
    disabled,
    disabledReason: record.disabledReason ?? record.autoDisabledReason,
    // Absent means "not filtered": deprecation is never inferred by the adapter.
    deprecationDate: record.lifecycle?.deprecationDate,
    trainingCutoff: record.trainingCutoff,
    releaseDate: record.releaseDate,
    logoFile: record.logoFile,
    rank: record.rank,
    description: record.description,
    isSlowModel: record.isSlowModel,
  };
}

/**
 * ModelInfo.thinkingStyle only describes the two Anthropic request shapes. Other
 * reasoning styles map to undefined rather than to a wrong shape; the backends
 * treat unset as their own default.
 */
function toThinkingStyle(record: RenderableModelRecord): ModelInfo['thinkingStyle'] {
  switch (record.reasoning?.style) {
    case 'anthropic-adaptive':
      return 'adaptive';
    case 'anthropic-legacy':
      return 'legacy';
    default:
      return undefined;
  }
}
