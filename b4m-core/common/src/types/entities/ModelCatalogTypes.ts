import { z } from 'zod';
import { ModelBackend, ModelInfo } from '../../models';
import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';
import { MODEL_PRICE_UNITS } from './ModelPriceTypes';

/**
 * Stamped on every ModelCatalog append. Bump ONLY when the record shape grows,
 * and only additively: a post-v1 field is optional with its default documented
 * on the field, is never narrowed, and is never made required after the fact.
 * That policy is what lets an old build read new rows and a new build read old
 * ones - the read schemas below are lenient precisely so a version skew shortens
 * nobody's model list.
 */
export const CATALOG_SCHEMA_VERSION = 1;

/**
 * How a model's request is built and which backend constructor serves it.
 * Replaces the id switch in llm-adapters (the 26-case Bedrock branch and the
 * OpenAI request-shaping id arrays). A row naming a family the running build
 * cannot dispatch stays metadata-only; promotion checks membership at runtime.
 */
export const ADAPTER_FAMILIES = [
  'anthropic-messages',
  'openai-chat',
  'openai-responses',
  'bedrock-anthropic',
  'bedrock-llama',
  'bedrock-deepseek',
  'bedrock-moonshot',
  'bedrock-jurassic',
  'bedrock-titan',
  'gemini',
  'xai',
  // Moonshot direct. Not 'openai-chat': the envelope matches but the reasoning
  // controls, the sampling pins and max_completion_tokens do not, so a Kimi row
  // routed to the OpenAI shaper would 400.
  'kimi',
  'ollama',
  'bfl',
  'local-image',
  'aws',
  'voyageai',
] as const;

export type AdapterFamily = (typeof ADAPTER_FAMILIES)[number];

/**
 * Precedence unit for the catalog merge. Rows claim authority per group, never
 * over the whole record, so an operator who pins a model's rank does not
 * thereby freeze its context window: within a group the newest operator row
 * wins, else the newest discovery row, else seed.
 */
export const FIELD_GROUPS = [
  'identity',
  'limits',
  'reasoning',
  'sampling',
  'modalities',
  'caching',
  'lifecycle',
  'presentation',
  'dispatch',
  'availability',
] as const;

export type FieldGroup = (typeof FIELD_GROUPS)[number];

export const isFieldGroup = (value: string): value is FieldGroup => (FIELD_GROUPS as readonly string[]).includes(value);

/** YYYY-MM-DD, the format every date-ish ModelInfo field already uses. */
const CALENDAR_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a YYYY-MM-DD calendar date');

const ReasoningWrite = z.strictObject({
  supported: z.boolean(),
  style: z.enum(['anthropic-adaptive', 'anthropic-legacy', 'openai-effort', 'ollama']).optional(),
  effortLevels: z.array(z.string()).optional(),
  /** Empirical OpenAI quirk: sending an effort level alongside tools 400s. */
  effortIncompatibleWithTools: z.boolean().optional(),
});

const PromptCachingWrite = z.strictObject({
  supported: z.boolean(),
});

/**
 * How to shape a request for this model. No provider or aggregator feed
 * supplies any of it - seed or operator only - and a record without a complete
 * profile can never be promoted to an invocable lifecycle status. This is the
 * fail-closed hinge: an unknown family is a metadata row, not a picker entry
 * that 400s.
 */
const DispatchProfileWrite = z.strictObject({
  maxTokensParam: z.enum(['max_tokens', 'max_completion_tokens']),
  toolTransport: z.enum(['chat', 'responses', 'native']),
  effortMapVariant: z.enum(['gpt5', 'gpt5_1_2']).optional(),
  /** 'o1' marks the models that reject a system role. */
  messageFormat: z.enum(['standard', 'o1']).optional(),
  betaHeaders: z.array(z.string()).optional(),
});

const LifecycleWrite = z.strictObject({
  status: z.enum(['discovered', 'active', 'legacy', 'deprecated', 'retired', 'unlisted']),
  deprecationDate: CALENDAR_DATE.optional(),
  retirementDate: CALENDAR_DATE.optional(),
  /** Successor id; feeds resolveDeprecatedModelId ahead of the static map. */
  replacedBy: z.string().optional(),
  // Absence bookkeeping (miss counters) lives in ModelDiscoveryState, not here:
  // a per-run counter must not append a catalog row per run forever.
});

/**
 * The canonical model record. One row's belief about one model, merged per
 * field group into the ModelInfo consumers read (see toModelInfo).
 *
 * Strict on write: an unknown key is a rejection, which is what stops a
 * `pricing` key from ever reaching this collection. Pricing lives only in
 * ModelPrice - applyModelPriceCatalog replaces the whole pricing map after the
 * catalog merge, so a price written here would be silently discarded.
 *
 * Deviations from the spec's illustrative type, both grounded in the spec's own
 * text: `maxOutputTokens` is optional because toModelInfo documents what to do
 * when the record is silent about it, and `adapterFamily` is optional because a
 * model in a family this build cannot dispatch is still recorded (it just
 * cannot be promoted).
 */
const ModelRecordFields = z.strictObject({
  /** Free string, not the ModelName union: discovery outruns the enums. */
  id: z.string().min(1),
  /** Who makes the model ('anthropic', 'meta', ...), independent of who serves it. */
  vendor: z.string().min(1),
  /** Who hosts and serves it - the routing decision. */
  backend: z.enum(ModelBackend),
  adapterFamily: z.enum(ADAPTER_FAMILIES).optional(),
  type: z.enum(['text', 'image', 'speech-to-text', 'video', 'embedding', 'tts', 'realtime-voice']),
  name: z.string().min(1),
  description: z.string().optional(),

  /** Zero means "not applicable", which is how the speech-to-text tables read. */
  contextWindow: z.number().int().nonnegative(),
  /** The only name for this quantity in the catalog; ModelInfo.max_tokens is derived. */
  maxOutputTokens: z.number().int().nonnegative().optional(),
  canStream: z.boolean().optional(),

  reasoning: ReasoningWrite.optional(),

  temperatureMode: z.enum(['free', 'fixed', 'unsupported']).optional(),
  /** Required when temperatureMode is 'fixed'. */
  fixedTemperature: z.number().optional(),
  supportsTopP: z.boolean().optional(),

  supportsVision: z.boolean().optional(),
  supportsTools: z.boolean().optional(),
  supportsStructuredOutput: z.boolean().optional(),
  supportsPdfInput: z.boolean().optional(),
  supportsImageVariation: z.boolean().optional(),
  supportsSafetyTolerance: z.boolean().optional(),
  imageSizes: z.array(z.string()).optional(),
  promptCaching: PromptCachingWrite.optional(),
  /** Retry-on-refusal quirk; subsumes REFUSAL_FALLBACK_MODELS. */
  refusalFallback: z.boolean().optional(),

  dispatchProfile: DispatchProfileWrite.optional(),
  lifecycle: LifecycleWrite.optional(),

  logoFile: z.string().optional(),
  rank: z.number().optional(),
  isSlowModel: z.boolean().optional(),
  trainingCutoff: CALENDAR_DATE.optional(),
  releaseDate: CALENDAR_DATE.optional(),

  /** Operator-owned block. Discovery may never set or clear it. */
  disabled: z.boolean().optional(),
  disabledReason: z.string().optional(),
  /** Discovery-owned block ("discovered, awaiting price"). Operators may never clear it. */
  autoDisabled: z.boolean().optional(),
  autoDisabledReason: z.string().optional(),
  private: z.boolean().optional(),
  freeToRun: z.boolean().optional(),
});

/** A fixed-temperature model with no temperature to send is unshippable, not a preference. */
const hasFixedTemperatureWhenFixed = (record: { temperatureMode?: string; fixedTemperature?: number }): boolean =>
  record.temperatureMode !== 'fixed' || record.fixedTemperature !== undefined;

const FIXED_TEMPERATURE_ISSUE = {
  error: 'fixedTemperature is required when temperatureMode is "fixed"',
  path: ['fixedTemperature'],
};

export const ModelRecordWrite = ModelRecordFields.refine(hasFixedTemperatureWhenFixed, FIXED_TEMPERATURE_ISSUE);

export type ModelRecord = z.infer<typeof ModelRecordFields>;

/**
 * The dispatch group as the request builders read it. Named separately from the
 * record because ModelInfo carries it too: the builders take a ModelInfo, and a
 * profile that reached them through the merge must be the same shape a row wrote.
 */
export type ModelDispatchProfile = NonNullable<ModelRecord['dispatchProfile']>;

/**
 * Read side of the strict/lenient pair. Two deliberate relaxations:
 *
 * 1. Every field is optional and unknown keys pass through, so a row written by
 *    a newer build parses here instead of dropping. A dropped row shortens the
 *    model list, which is the worst failure this collection can have. Optional
 *    goes all the way down: a nested field the write schema requires today may
 *    be relaxed tomorrow, and this build must still read the rows that produces
 *    rather than shorten its list over a missing `lifecycle.status`. Consumers
 *    treat a nested field as absent-by-default (see toModelInfo and
 *    invocabilityBlocker, which fail closed on a lifecycle with no status).
 * 2. Enum-valued fields are read as free strings. A model type, backend, or
 *    adapter family this build does not know must be dropped AND COUNTED by the
 *    merge, not rejected by the parser - a parse rejection alarms
 *    (CatalogRowsRejected) on what is really a benign version skew.
 */
export const ModelRecordPatchRead = ModelRecordFields.extend({
  backend: z.string(),
  adapterFamily: z.string(),
  type: z.string(),
  temperatureMode: z.string(),
  reasoning: ReasoningWrite.extend({ style: z.string().optional() }).partial().loose(),
  promptCaching: PromptCachingWrite.partial().loose(),
  dispatchProfile: DispatchProfileWrite.extend({
    maxTokensParam: z.string(),
    toolTransport: z.string(),
    effortMapVariant: z.string().optional(),
    messageFormat: z.string().optional(),
  })
    .partial()
    .loose(),
  lifecycle: LifecycleWrite.extend({ status: z.string() }).partial().loose(),
})
  .partial()
  .loose();

/** A model record as read back from the catalog: sparse, lenient, unnarrowed. */
export type IModelRecordPatch = z.infer<typeof ModelRecordPatchRead>;

/** Sparse operator edit. Strict, so a typo or a `pricing` key is still a rejection. */
export const ModelRecordPatchWrite = ModelRecordFields.partial().refine(
  hasFixedTemperatureWhenFixed,
  FIXED_TEMPERATURE_ISSUE
);

/**
 * Which group owns each record field. Exhaustive by construction: adding a
 * ModelRecord field without grouping it fails the build here, which is the
 * point - an ungrouped field would silently never participate in precedence.
 */
export const FIELD_GROUP_OF: Record<keyof ModelRecord, FieldGroup> = {
  id: 'identity',
  vendor: 'identity',
  backend: 'identity',
  type: 'identity',
  name: 'identity',

  contextWindow: 'limits',
  maxOutputTokens: 'limits',

  reasoning: 'reasoning',

  temperatureMode: 'sampling',
  fixedTemperature: 'sampling',
  supportsTopP: 'sampling',

  canStream: 'modalities',
  supportsVision: 'modalities',
  supportsTools: 'modalities',
  supportsStructuredOutput: 'modalities',
  supportsPdfInput: 'modalities',
  supportsImageVariation: 'modalities',
  supportsSafetyTolerance: 'modalities',
  imageSizes: 'modalities',

  promptCaching: 'caching',

  lifecycle: 'lifecycle',

  description: 'presentation',
  logoFile: 'presentation',
  rank: 'presentation',
  isSlowModel: 'presentation',
  trainingCutoff: 'presentation',
  releaseDate: 'presentation',

  // adapterFamily rides with dispatchProfile: both answer "can this build issue
  // a correctly shaped request", and the promotion predicate reads them together.
  adapterFamily: 'dispatch',
  dispatchProfile: 'dispatch',
  refusalFallback: 'dispatch',

  disabled: 'availability',
  disabledReason: 'availability',
  autoDisabled: 'availability',
  autoDisabledReason: 'availability',
  private: 'availability',
  freeToRun: 'availability',
};

/**
 * ModelInfo fields that never come from a catalog row. `pricing` is supplied by
 * applyModelPriceCatalog from the ModelPrice collection; a catalog row carrying
 * a price is a spec violation the write schema rejects.
 */
export const MODEL_INFO_FIELDS_NOT_IN_CATALOG = ['pricing'] as const;

/**
 * Which record group each ModelInfo field is derived from. Exhaustive by
 * construction (T1): a new ModelInfo field must be grouped here or listed as
 * not-in-catalog, so nobody adds one without making a catalog decision.
 */
export const MODEL_INFO_FIELD_GROUP_OF: Record<
  Exclude<keyof ModelInfo, (typeof MODEL_INFO_FIELDS_NOT_IN_CATALOG)[number]>,
  FieldGroup
> = {
  id: 'identity',
  type: 'identity',
  name: 'identity',
  backend: 'identity',

  contextWindow: 'limits',
  max_tokens: 'limits',

  can_think: 'reasoning',
  thinkingStyle: 'reasoning',

  can_stream: 'modalities',
  supportsVision: 'modalities',
  supportsTools: 'modalities',
  supportsImageVariation: 'modalities',
  supportsSafetyTolerance: 'modalities',

  deprecationDate: 'lifecycle',

  adapterFamily: 'dispatch',
  dispatchProfile: 'dispatch',

  description: 'presentation',
  logoFile: 'presentation',
  rank: 'presentation',
  isSlowModel: 'presentation',
  trainingCutoff: 'presentation',
  releaseDate: 'presentation',

  private: 'availability',
  freeToRun: 'availability',
  disabled: 'availability',
  disabledReason: 'availability',
};

/**
 * Groups a patch actually writes to. Keys unknown to this build map to no group
 * and are ignored, so a newer row cannot claim authority here by accident.
 */
export function groupsTouchedByPatch(patch: Record<string, unknown>): FieldGroup[] {
  const groups = new Set<FieldGroup>();
  for (const key of Object.keys(patch)) {
    const group = FIELD_GROUP_OF[key as keyof ModelRecord];
    if (group) groups.add(group);
  }
  return [...groups];
}

export const CATALOG_ROW_SOURCES = ['seed', 'discovery', 'operator'] as const;

export type CatalogRowSource = (typeof CATALOG_ROW_SOURCES)[number];

/**
 * Per-group provenance inside one row. A run merges every source into a single
 * row per model (that is what makes the unique index work), so attribution
 * lives here rather than in one row per source.
 */
export const CatalogContributor = z.strictObject({
  group: z.enum(FIELD_GROUPS),
  /** 'anthropic', 'models.dev', 'adapter-seed', an admin id, ... */
  source: z.string().min(1),
});

export type ICatalogContributor = z.infer<typeof CatalogContributor>;

const catalogRowInputFields = {
  modelId: z.string().min(1),
  /** Groups this row claims authority over; must be a subset of what the patch touches. */
  ownedGroups: z.array(z.enum(FIELD_GROUPS)).min(1),
  /** The run's startedAt (one value per run) or the seed's generatedAt. */
  effectiveFrom: z.date(),
  contributors: z.array(CatalogContributor).optional(),
  note: z.string().optional(),
  runId: z.string().optional(),
};

/** Seed and discovery rows carry a whole record: the merged belief for that run. */
export const ModelCatalogSnapshotRowInput = z.strictObject({
  ...catalogRowInputFields,
  source: z.enum(['seed', 'discovery']),
  patch: ModelRecordWrite,
});

/** Operator rows are sparse edits and must say why. */
export const ModelCatalogPatchRowInput = z.strictObject({
  ...catalogRowInputFields,
  source: z.literal('operator'),
  note: z.string().min(1),
  patch: ModelRecordPatchWrite.refine(patch => Object.keys(patch).length > 0, {
    error: 'an operator patch must change at least one field',
  }),
});

export const ModelCatalogRowInput = z
  .discriminatedUnion('source', [ModelCatalogSnapshotRowInput, ModelCatalogPatchRowInput])
  .superRefine((row, ctx) => {
    const touched = groupsTouchedByPatch(row.patch as Record<string, unknown>);
    const overclaimed = row.ownedGroups.filter(group => !touched.includes(group));
    if (overclaimed.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['ownedGroups'],
        message: `row claims groups its patch does not touch: ${overclaimed.join(', ')}`,
      });
    }
  });

export type IModelCatalogRowInput = z.infer<typeof ModelCatalogRowInput>;

/**
 * A persisted row as read back. Deliberately lenient (see ModelRecordPatchRead):
 * `source` and `ownedGroups` are strings rather than enums so a value added in a
 * later schema version does not drop the row - the merge ignores what it does
 * not recognize.
 */
export const ModelCatalogRowRead = z.looseObject({
  id: z.string().optional(),
  modelId: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  source: z.string().min(1),
  ownedGroups: z.array(z.string()),
  patch: ModelRecordPatchRead,
  effectiveFrom: z.date(),
  contributors: z.array(CatalogContributor.extend({ group: z.string() }).loose()).optional(),
  note: z.string().optional(),
  runId: z.string().optional(),
  createdAt: z.date().optional(),
  updatedAt: z.date().optional(),
});

export type IModelCatalogRow = z.infer<typeof ModelCatalogRowRead>;

export type IModelCatalogRowDocument = IModelCatalogRow & IMongoDocument;

/** Read result plus the drop count the CatalogRowsRejected metric reports. */
export interface IModelCatalogReadResult {
  rows: IModelCatalogRow[];
  /** Rows that failed the lenient read parse. Alarm on > 0. */
  rejected: number;
  rejectedModelIds: string[];
}

export interface IModelCatalogRepository extends IBaseRepository<IModelCatalogRowDocument> {
  /**
   * Append one row (append-only: never edits). Returns null when a concurrent
   * writer already wrote the same (modelId, effectiveFrom) - the run-window race
   * is a skip, not an error.
   */
  append(row: IModelCatalogRowInput): Promise<IModelCatalogRowDocument | null>;

  /**
   * Rows in force at the given time (default now), newest effectiveFrom first:
   * the newest non-operator row per (modelId, source) plus every operator row.
   * More than one row per model on purpose - that is what per-group precedence
   * needs, so a sparse operator patch overlays a discovery row instead of
   * shadowing it. The implementation's docstring carries the full contract.
   */
  rowsInForce(at?: Date): Promise<IModelCatalogRow[]>;

  /** rowsInForce plus the drop count, for the run report and the rejection metric. */
  rowsInForceWithRejects(at?: Date): Promise<IModelCatalogReadResult>;

  /** Full history for one model, newest first (admin history / audit). */
  historyForModel(modelId: string): Promise<IModelCatalogRow[]>;
}

/**
 * A lifecycle change discovery believes in but is not allowed to apply: an
 * uncorroborated docs signal (sec 5.10 tier 2, which may raise the queue but may
 * never hide a model on its own) or a `replacedBy` that failed an auto-remap
 * constraint. One live suggestion per model - the admin queue reads the
 * unresolved ones and an operator's verdict is recorded in place.
 */
export const ModelLifecycleSuggestion = z.object({
  /** Free string rather than the LifecycleWrite enum, for the same read-compat reason. */
  status: z.string().optional(),
  deprecationDate: z.string().optional(),
  retirementDate: z.string().optional(),
  replacedBy: z.string().optional(),
  /** What raised it: a source name, or 'absence' for the K-miss protocol. */
  source: z.string().min(1),
  /**
   * Why the automation would not apply it itself, in the operator's words. The
   * queue is asking a human to make a call the constraints refused; without
   * this they are making it blind.
   */
  detail: z.string().optional(),
  suggestedAt: z.date(),
  resolvedAt: z.date().optional(),
  resolution: z.enum(['accepted', 'dismissed']).optional(),
});

export type IModelLifecycleSuggestion = z.infer<typeof ModelLifecycleSuggestion>;

/** What a run proposes, before the bookkeeping stamps the repository owns. */
export type ModelLifecycleSuggestionInput = Omit<
  IModelLifecycleSuggestion,
  'suggestedAt' | 'resolvedAt' | 'resolution'
>;

/**
 * Mutable per-model discovery bookkeeping. Absence counters live here and not
 * in the catalog: a model missing from a provider list for months must not
 * append a row per run forever. Only the actual transition to deprecated
 * appends a catalog row.
 */
export const ModelDiscoveryState = z.object({
  id: z.string().optional(),
  modelId: z.string().min(1),
  /** Last run that saw this model in a SUCCESSFUL provider list response. */
  lastSeenAt: z.date().optional(),
  /** First miss of the current streak; cleared on any sighting. */
  firstMissAt: z.date().optional(),
  /** Consecutive successful-run misses. A failed or partial fetch neither increments nor resets. */
  missCount: z.number().int().nonnegative(),
  lastSourceOkAt: z.date().optional(),
  /** Resolved aggregator join keys, cached so a normalizer change is visible as a diff. */
  aggregatorKeys: z
    .object({
      modelsDev: z.string().optional(),
      litellm: z.string().optional(),
    })
    .optional(),
  /** Optional: a state row written before Phase 4 has none, and must keep parsing. */
  suggestion: ModelLifecycleSuggestion.optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type IModelDiscoveryState = z.infer<typeof ModelDiscoveryState>;

export type IModelDiscoveryStateDocument = IModelDiscoveryState & IMongoDocument;

export interface IModelDiscoveryStateRepository extends IBaseRepository<IModelDiscoveryStateDocument> {
  findByModelId(modelId: string): Promise<IModelDiscoveryState | null>;

  /** One query for a whole run's worth of models; ids with no row are simply absent. */
  findByModelIds(modelIds: readonly string[]): Promise<IModelDiscoveryState[]>;

  /** A sighting ends the streak: missCount back to 0 and firstMissAt cleared. */
  recordSighting(modelId: string, at?: Date): Promise<IModelDiscoveryState>;

  /** One more consecutive miss. firstMissAt is stamped once and then left alone. */
  recordMiss(modelId: string, at?: Date): Promise<IModelDiscoveryState>;

  /**
   * Store this run's suggestion. A rerun replaces an UNRESOLVED suggestion; one
   * an operator already accepted or dismissed is replaced only when the content
   * differs from what they settled, so a verdict is never silently undone.
   */
  recordSuggestion(
    modelId: string,
    suggestion: ModelLifecycleSuggestionInput,
    at?: Date
  ): Promise<IModelDiscoveryState>;

  /** The deprecation queue: every model carrying a suggestion nobody has settled, oldest first. */
  pendingSuggestions(): Promise<IModelDiscoveryState[]>;

  /** Null when the model has no suggestion to settle. */
  resolveSuggestion(
    modelId: string,
    resolution: NonNullable<IModelLifecycleSuggestion['resolution']>,
    at?: Date
  ): Promise<IModelDiscoveryState | null>;
}

export const DISCOVERY_RUN_TRIGGERS = ['cron', 'startup', 'manual'] as const;
export const DISCOVERY_RUN_HOSTS = ['hosted', 'selfhost'] as const;
/** 'partial' commits what it verified and does not advance lastSuccessfulRun. */
export const DISCOVERY_RUN_STATUSES = ['ok', 'partial', 'failed'] as const;
/** 'report' computes the whole plan and writes nothing but the run document. */
export const DISCOVERY_RUN_MODES = ['report', 'write'] as const;

export type DiscoveryRunTrigger = (typeof DISCOVERY_RUN_TRIGGERS)[number];
export type DiscoveryRunHost = (typeof DISCOVERY_RUN_HOSTS)[number];
export type DiscoveryRunStatus = (typeof DISCOVERY_RUN_STATUSES)[number];
/** DiscoveryMode in b4m-core/services/src/modelDiscoveryService/types.ts aliases this. */
export type DiscoveryRunMode = (typeof DISCOVERY_RUN_MODES)[number];

export const DiscoverySourceReport = z.object({
  name: z.string().min(1),
  ok: z.boolean(),
  durationMs: z.number().nonnegative(),
  httpStatus: z.number().int().optional(),
  /** ETag and body hash together answer "did the aggregator change under us". */
  etag: z.string().optional(),
  contentHash: z.string().optional(),
  error: z.string().optional(),
  /**
   * Rows each of this source's parsers produced, by parser name. Recorded so the
   * next run can compare: a docs page that restructures shows up as a row-count
   * move before its bad data is actioned (sec 5.10).
   */
  parserRows: z.record(z.string(), z.number()).optional(),
  /**
   * Records this source emitted. The same idea as parserRows one level up: a
   * provider that answers 200 with a genuinely short list (permission scoping, a
   * partial outage, a region flap) is otherwise indistinguishable from one whose
   * models really went away, and three such runs deprecate everything unlisted.
   */
  recordCount: z.number().int().nonnegative().optional(),
});

export const DiscoveryJoinCoverage = z.object({
  aggregator: z.string().min(1),
  matched: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

/** Model ids per change kind; the run report enumerates every mutation. */
export const DiscoveryRunChanges = z.object({
  added: z.array(z.string()).optional(),
  promoted: z.array(z.string()).optional(),
  deprecated: z.array(z.string()).optional(),
  repriced: z.array(z.string()).optional(),
  flagged: z.array(z.string()).optional(),
  /**
   * The operator overlaps `flagged` merges in with the price flags. Kept apart
   * because the two want different verdicts from the operator, and `flagged`
   * itself may not change shape: the status card counts it and every run already
   * persisted holds the merged array.
   */
  operatorConflicts: z.array(z.string()).optional(),
  /**
   * Rows the run PLANNED against rows that actually landed. Everything above is
   * the plan, deliberately, so report and write mode report identically - which
   * leaves a write-mode run whose appends all threw indistinguishable from a
   * clean one. These two are the only fields that say what happened.
   */
  plannedRows: z.number().int().nonnegative().optional(),
  appendedRows: z.number().int().nonnegative().optional(),
  plannedPriceRows: z.number().int().nonnegative().optional(),
  appendedPriceRows: z.number().int().nonnegative().optional(),
});

/** A source record the write path refused, kept so a run's refusals are auditable. */
export const DiscoveryDroppedRecord = z.object({
  source: z.string(),
  modelId: z.string(),
  reason: z.string(),
});

/**
 * The six blocks below are the per-model detail behind the counts in
 * DiscoveryRunChanges, and MUST STAY IN SYNC with the service shapes the runner
 * persists verbatim: PriceFlag, PlannedPriceRow, PriceOverride, PriceSkip,
 * LifecycleTransition and CatalogDiffEntry in
 * b4m-core/services/src/modelDiscoveryService/types.ts.
 *
 * Every union the SERVICE owns is read here as a free string (`kind`, `reason`,
 * `signal`, `blockedBy`). Adding a value there is normal, and a stored run that
 * stopped parsing over one would take the whole report down with it - the same
 * read-compat rule the catalog rows above follow.
 */
const PerMTokRates = z.object({ inputPerMTok: z.number(), outputPerMTok: z.number() });

export const DiscoveryPriceFlag = z.object({
  modelId: z.string().min(1),
  kind: z.string(),
  /** Per-MTok, the readable unit; the row it would have written is per token. */
  proposed: PerMTokRates,
  /** The row in force, when there was one. */
  current: PerMTokRates.optional(),
  /** Every source that priced this model, so a disagreement names both sides. */
  sources: z.array(z.string()),
  /**
   * The sentence that explains the flag, and the whole reason the flags are
   * persisted: it used to reach only logger.warn, leaving the admin card with a
   * flag count and nowhere to learn what it stood for.
   */
  detail: z.string(),
});

export const DiscoveryPlannedPriceRow = z.object({
  modelId: z.string().min(1),
  unit: z.enum(MODEL_PRICE_UNITS),
  inputPerMTok: z.number(),
  outputPerMTok: z.number(),
  effectiveFrom: z.date(),
  /** The sources whose observations produced the value. */
  sources: z.array(z.string()),
  note: z.string(),
});

/**
 * A row written over a source that disagreed with it, which only a provider's own
 * published price can do. The inverse of a flag: that is a value discovery
 * declined to apply, this is one it applied anyway, and the dissenting source is
 * the operator's cue that a mirror has gone stale.
 */
export const DiscoveryPriceOverride = z.object({
  modelId: z.string().min(1),
  /** The provider source whose value was written. */
  source: z.string(),
  /** Sources that disagreed with it and were not applied. */
  dissenting: z.array(z.string()),
  applied: PerMTokRates,
  detail: z.string(),
});

/** A usable observation that produced neither a row nor a flag, and why. */
export const DiscoveryPriceSkip = z.object({
  modelId: z.string().min(1),
  reason: z.string(),
});

export const DiscoveryLifecycleTransition = z.object({
  modelId: z.string().min(1),
  /** Absent when no row in force carried a lifecycle for this model. */
  from: z.string().optional(),
  to: z.string(),
  signal: z.string(),
  deprecationDate: z.string().optional(),
  retirementDate: z.string().optional(),
  /** Present only when auto-remap applied it; otherwise the successor is a suggestion. */
  replacedBy: z.string().optional(),
  autoApplied: z.boolean(),
});

export const DiscoveryCatalogDiffEntry = z.object({
  modelId: z.string().min(1),
  /** 'added' is a model with no catalog row at all; 'updated' is a changed merged view. */
  kind: z.string(),
  ownedGroups: z.array(z.string()),
  changedKeys: z.array(z.string()),
  lifecycleStatus: z.string(),
  promoted: z.boolean(),
  /** Promotion denials, one per failed clause; empty on a promoted model. */
  blockedBy: z.array(z.string()),
  operatorOwned: z.boolean(),
});

/**
 * Totals behind the capped detail arrays (MAX_PERSISTED_RUN_DETAIL in the
 * runner). Written only when a slice was actually truncated, so a reader can say
 * "the first 200 of 260" instead of passing the cap off as the whole set: the
 * `changes.*` id arrays these explain are NOT capped, so a wide run otherwise
 * reports 260 flagged in the header and 200 in the section with no marker.
 */
export const DiscoveryRunDetailTotals = z.object({
  priceFlags: z.number().int().nonnegative().optional(),
  priceRows: z.number().int().nonnegative().optional(),
  priceOverrides: z.number().int().nonnegative().optional(),
  priceSkips: z.number().int().nonnegative().optional(),
  lifecycleTransitions: z.number().int().nonnegative().optional(),
  catalogDiff: z.number().int().nonnegative().optional(),
});

export type IDiscoverySourceReport = z.infer<typeof DiscoverySourceReport>;
export type IDiscoveryJoinCoverage = z.infer<typeof DiscoveryJoinCoverage>;
export type IDiscoveryRunChanges = z.infer<typeof DiscoveryRunChanges>;
export type IDiscoveryDroppedRecord = z.infer<typeof DiscoveryDroppedRecord>;
export type IDiscoveryPriceFlag = z.infer<typeof DiscoveryPriceFlag>;
export type IDiscoveryPlannedPriceRow = z.infer<typeof DiscoveryPlannedPriceRow>;
export type IDiscoveryPriceOverride = z.infer<typeof DiscoveryPriceOverride>;
export type IDiscoveryPriceSkip = z.infer<typeof DiscoveryPriceSkip>;
export type IDiscoveryLifecycleTransition = z.infer<typeof DiscoveryLifecycleTransition>;
export type IDiscoveryCatalogDiffEntry = z.infer<typeof DiscoveryCatalogDiffEntry>;
export type IDiscoveryRunDetailTotals = z.infer<typeof DiscoveryRunDetailTotals>;

export const ModelDiscoveryRun = z.object({
  id: z.string().optional(),
  startedAt: z.date(),
  finishedAt: z.date().optional(),
  trigger: z.enum(DISCOVERY_RUN_TRIGGERS),
  host: z.enum(DISCOVERY_RUN_HOSTS),
  status: z.enum(DISCOVERY_RUN_STATUSES),
  /**
   * What this run was allowed to do, recorded as it ran. A reader may NOT
   * substitute the modelDiscoveryMode setting for it: the setting can change
   * between the run and the read, and a 'report' run plans writes and lands none
   * BY DESIGN - without this, that is indistinguishable from a write run whose
   * appends all threw, which is the case the plan-vs-appended counters exist for.
   * Optional: runs written before it existed carry none.
   */
  mode: z.enum(DISCOVERY_RUN_MODES).optional(),
  sources: z.array(DiscoverySourceReport).optional(),
  joinCoverage: z.array(DiscoveryJoinCoverage).optional(),
  /** Ids no aggregator matched: a work item, not a log line. */
  unmatchedIds: z.array(z.string()).optional(),
  changes: DiscoveryRunChanges.optional(),
  /** Convergence passes the run made; the cap being hit is worth seeing. */
  passes: z.number().int().nonnegative().optional(),
  /** Bounded: the whole point is a trace, and a pathological run can drop thousands. */
  droppedRecords: z.array(DiscoveryDroppedRecord).optional(),
  /**
   * The run's own detail, bounded the same way droppedRecords is (see
   * MAX_PERSISTED_RUN_DETAIL). Optional throughout: every run written before
   * these existed has to keep parsing, and a run that never reached its final
   * update has none of them.
   */
  priceFlags: DiscoveryPriceFlag.array().optional(),
  priceRows: DiscoveryPlannedPriceRow.array().optional(),
  priceOverrides: DiscoveryPriceOverride.array().optional(),
  priceSkips: DiscoveryPriceSkip.array().optional(),
  lifecycleTransitions: DiscoveryLifecycleTransition.array().optional(),
  catalogDiff: DiscoveryCatalogDiffEntry.array().optional(),
  /** Present only when one of the arrays above was truncated. */
  detailTotals: DiscoveryRunDetailTotals.optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type IModelDiscoveryRun = z.infer<typeof ModelDiscoveryRun>;

export type IModelDiscoveryRunDocument = IModelDiscoveryRun & IMongoDocument;

export const ModelDiscoveryRunInput = ModelDiscoveryRun.omit({ id: true, createdAt: true, updatedAt: true });

export type IModelDiscoveryRunInput = z.infer<typeof ModelDiscoveryRunInput>;

export interface IModelDiscoveryRunRepository extends IBaseRepository<IModelDiscoveryRunDocument> {
  /** Newest run, optionally for one host (the admin status card). */
  latestRun(host?: DiscoveryRunHost): Promise<IModelDiscoveryRun | null>;

  /**
   * Newest run with status 'ok'. Null means discovery has never succeeded, which
   * is the exact condition for the "FALLBACK SEED" catalog banner.
   */
  lastSuccessfulRun(host?: DiscoveryRunHost): Promise<IModelDiscoveryRun | null>;

  /**
   * Newest runs first, for the admin run list. Without it the 6h cron erases
   * whatever the operator was reading, since only the newest run is reachable.
   *
   * A LIST view: the implementation projects the per-model detail arrays out, so
   * read a run's detail with runById rather than from here.
   */
  recentRuns(limit: number, host?: DiscoveryRunHost): Promise<IModelDiscoveryRun[]>;

  /** One run in full (the report). Null for an unknown or malformed id. */
  runById(id: string): Promise<IModelDiscoveryRun | null>;
}
