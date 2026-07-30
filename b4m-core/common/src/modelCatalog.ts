import { ModelBackend } from './models';
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
  // operators write disabled, discovery writes autoDisabled. 'retired' blocks it
  // too: a deprecationDate hides a model once it passes, but a row stating
  // retired WITHOUT one would leave a model the provider no longer serves in
  // every picker, to fail at dispatch. 'deprecated' deliberately does not block -
  // a deprecated model is callable right up to its date.
  const retired = record.lifecycle?.status === 'retired';
  const disabled = record.disabled === true || record.autoDisabled === true || retired;

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
    // The dispatch group rides through to the runtime unchanged: getLlmByModel
    // routes on adapterFamily and the request builders read dispatchProfile.
    // Absent stays absent - that is what keeps a seeded model on the adapter
    // tables' behavior.
    adapterFamily: record.adapterFamily,
    dispatchProfile: record.dispatchProfile,
    supportsVision: record.supportsVision,
    supportsTools: record.supportsTools,
    supportsImageVariation: record.supportsImageVariation ?? false,
    supportsSafetyTolerance: record.supportsSafetyTolerance,
    freeToRun: record.freeToRun,
    private: record.private ?? false,
    disabled,
    disabledReason:
      record.disabledReason ?? record.autoDisabledReason ?? (retired ? 'retired by the provider' : undefined),
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

type ReasoningStyle = NonNullable<ModelRecord['reasoning']>['style'];

function fromThinkingStyle(style: ModelInfo['thinkingStyle']): ReasoningStyle {
  if (style === 'adaptive') return 'anthropic-adaptive';
  if (style === 'legacy') return 'anthropic-legacy';
  return undefined;
}

/** Who makes the model, when the id namespace says so: [region.]<vendor>.<model>. */
const BEDROCK_REGION_PREFIX = /^(us|eu|apac|global)\./;

const VENDOR_BY_BACKEND: Record<ModelBackend, string> = {
  [ModelBackend.OpenAI]: 'openai',
  [ModelBackend.Anthropic]: 'anthropic',
  [ModelBackend.Gemini]: 'google',
  [ModelBackend.XAI]: 'xai',
  // Vendor, not backend: Bedrock-served Kimi carries the same 'moonshotai'
  // vendor while routing through ModelBackend.Bedrock.
  [ModelBackend.Kimi]: 'moonshotai',
  [ModelBackend.BFL]: 'black-forest-labs',
  [ModelBackend.AWS]: 'amazon',
  [ModelBackend.VoyageAI]: 'voyageai',
  [ModelBackend.Ollama]: 'ollama',
  [ModelBackend.LocalImage]: 'local',
  // Bedrock hosts other people's models; the id prefix below is the real answer.
  [ModelBackend.Bedrock]: 'amazon',
};

/**
 * ModelInfo carries no vendor (that is one of the four disagreeing taxonomies
 * this catalog replaces), so the inverse adapter derives it: the backend answers
 * it for direct providers, and for Bedrock the id namespace does.
 */
/**
 * Bedrock id prefixes that name the same maker as a different string. AWS spells
 * Kimi K2.5 `moonshotai.` and K2 Thinking `moonshot.`, so the raw prefix would
 * file one vendor's two models under two vendors and split them in the admin
 * dashboard. Canonicalized to the spelling the direct backend and the models.dev
 * provider both use.
 */
const BEDROCK_VENDOR_ALIASES: Readonly<Record<string, string>> = {
  moonshot: 'moonshotai',
};

export function inferVendor(info: Pick<ModelInfo, 'id' | 'backend'>): string {
  if (info.backend === ModelBackend.Bedrock) {
    const withoutRegion = String(info.id).replace(BEDROCK_REGION_PREFIX, '');
    const dot = withoutRegion.indexOf('.');
    if (dot > 0) {
      const prefix = withoutRegion.slice(0, dot);
      return BEDROCK_VENDOR_ALIASES[prefix] ?? prefix;
    }
  }
  return VENDOR_BY_BACKEND[info.backend] ?? String(info.backend);
}

/**
 * ModelInfo -> ModelRecord, the inverse of toModelInfo. Two callers: the
 * fallback seed generator (adapter literals become seed rows) and the merge's
 * base tier (a seeded model becomes a record that a catalog row can then claim
 * groups of).
 *
 * `pricing` has no ModelInfo spelling here and is deliberately absent rather
 * than guessed: catalog rows never carry it. The dispatch group round-trips
 * (ModelInfo carries it since dispatch consumes it), but no feed may author it -
 * a wrong value there mis-routes a request, so it stays seed- or
 * operator-sourced, or comes from the seed-side DispatchResolver.
 *
 * Round-tripping normalizes the optional booleans toModelInfo defaults
 * (can_think, private, disabled, supportsImageVariation): undefined becomes an
 * explicit false. That is only observable for a model whose merged record a
 * catalog row actually owns a group of.
 */
export function toModelRecord(info: ModelInfo): RenderableModelRecord {
  return {
    id: info.id,
    vendor: inferVendor(info),
    backend: info.backend,
    type: info.type,
    name: info.name,
    contextWindow: info.contextWindow,
    maxOutputTokens: info.max_tokens,
    canStream: info.can_stream,
    // Omitted when the source said nothing about thinking: asserting
    // `supported: false` would claim the reasoning group and turn every silent
    // model's can_think from undefined into an explicit false.
    reasoning:
      info.can_think === undefined && info.thinkingStyle === undefined
        ? undefined
        : { supported: info.can_think === true, style: fromThinkingStyle(info.thinkingStyle) },
    adapterFamily: info.adapterFamily,
    dispatchProfile: info.dispatchProfile,
    supportsVision: info.supportsVision,
    supportsTools: info.supportsTools,
    supportsImageVariation: info.supportsImageVariation,
    supportsSafetyTolerance: info.supportsSafetyTolerance,
    lifecycle: info.deprecationDate
      ? { status: 'deprecated', deprecationDate: info.deprecationDate }
      : { status: 'active' },
    description: info.description,
    logoFile: info.logoFile,
    rank: info.rank,
    isSlowModel: info.isSlowModel,
    trainingCutoff: info.trainingCutoff,
    releaseDate: info.releaseDate,
    private: info.private,
    freeToRun: info.freeToRun,
    // ModelInfo.disabled is the OR of both owners; the inverse can only attribute
    // it to the operator-owned field. Discovery is the sole writer of autoDisabled
    // and never round-trips through ModelInfo.
    disabled: info.disabled,
    disabledReason: info.disabledReason,
  };
}
