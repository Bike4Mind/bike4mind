import {
  FIELD_GROUP_OF,
  LIFECYCLE_DATE_KEYS,
  LIFECYCLE_SUNSET_STATUSES,
  MODEL_INFO_FIELD_GROUP_OF,
  ModelBackend,
  isDiscoveryVerdict,
  isFieldGroup,
  lifecycleStatusRank,
  isRenderableModelType,
  isDedicatedApiModel,
  toModelInfo,
  toModelRecord,
} from '@bike4mind/common';
import type { FieldGroup, IModelCatalogRow, ModelInfo, ModelRecord, RenderableModelRecord } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { isBackendUsable } from './backendGate';
import type { BackendGateContext } from './backendGate';

/**
 * Adapter families getLlmByModel can route from the record alone, so a
 * catalog-only id in one of these reaches a real backend.
 *
 * MUST STAY IN SYNC WITH backendForAdapterFamily (./adapterFamilyDispatch.ts):
 * every family here needs a constructor there, and every family there belongs
 * here. The bedrock-* families joined the list when family dispatch replaced the
 * 26-case id switch as the route for records that carry a family. `voyageai` is
 * the only member of ADAPTER_FAMILIES that is absent, and stays absent while it
 * has no completion backend.
 */
export const DISPATCHABLE_ADAPTER_FAMILIES: readonly string[] = [
  'anthropic-messages',
  'openai-chat',
  'openai-responses',
  'bedrock-anthropic',
  'bedrock-llama',
  'bedrock-deepseek',
  'bedrock-moonshot',
  'bedrock-jurassic',
  'bedrock-titan',
  'bedrock-converse',
  'gemini',
  'xai',
  'kimi',
  'deepseek',
  'ollama',
  'bfl',
  'local-image',
  'aws',
];

/** operator > discovery > seed, per field group (presentation is operator > seed >
 * discovery; see PRESENTATION_PRECEDENCE). An unrecognized source ranks
 * below all three: it still contributes where nothing else does (the lenient
 * read never discards data) but can never outrank a source this build knows.
 * `lifecycle` and `availability` also fold below operator; see foldLifecycle and keepDisable. */
const SOURCE_PRECEDENCE: Record<string, number> = { operator: 3, discovery: 2, seed: 1 };

/**
 * `presentation` is editorial, so seed copy outranks discovery there: a discovery
 * row only gap-fills it (releaseDate; see FEED_CLAIMABLE_FIELDS in the discovery
 * service's catalogWrite.ts) and must not shadow a seed row that lands later.
 */
const PRESENTATION_PRECEDENCE: Record<string, number> = { operator: 3, seed: 2, discovery: 1 };

const MODEL_BACKENDS: readonly string[] = Object.values(ModelBackend);

const MODEL_INFO_GROUPS = Object.entries(MODEL_INFO_FIELD_GROUP_OF) as Array<
  [Exclude<keyof ModelInfo, 'pricing'>, FieldGroup]
>;

/** A catalog record this build refused to render, with the reason for the run report. */
export interface CatalogMergeDrop {
  modelId: string;
  reason: string;
}

export interface CatalogMergeResult {
  models: ModelInfo[];
  /**
   * Contract failures: rows this build could not turn into an invocable model
   * (unreadable shape, a type it does not narrow on, no dispatchable family, a
   * lifecycle that is not invocable). Worth an alarm - these are work items.
   * A catalog-only record is missing from `models` as well; a seeded one is
   * still served from its adapter literal, so a drop here is not always an
   * absence there.
   */
  dropped: CatalogMergeDrop[];
  /**
   * Catalog-only records withheld because THIS caller has no key for their
   * backend. Expected and per-user, so it is counted separately from `dropped`:
   * every keyless caller would otherwise look like a catalog defect.
   */
  gated: number;
}

/**
 * Overlay the catalog onto the assembled adapter/live models.
 *
 * Precedence is evaluated per FIELD GROUP, not per record, so an operator who
 * pins a model's rank does not thereby freeze its context window: within a group
 * the newest operator row wins, else the newest discovery row, else seed. Within
 * the winning row only the keys it actually carries apply - a sparse operator
 * patch overrides what it names and nothing else. The exception is `lifecycle` and
 * `availability` below operator: they fold across sources so a feed cannot
 * un-sunset or re-enable a model (see foldLifecycle, keepDisable).
 *
 * Catalog-only ids are appended only when the invocability contract holds (sec
 * 5.4): an active lifecycle, an adapter family this build can dispatch, a
 * dispatch profile, and a backend this caller could have constructed. Every
 * other outcome fails closed. A SEEDED model is the exception, because it has a
 * known-good base: a row that makes its merged record unrenderable is counted
 * as a drop and the adapter record is served unchanged.
 *
 * Pricing is never sourced here. applyModelPriceCatalog is the only writer of
 * ModelInfo.pricing and runs after this merge; a seeded model keeps its adapter
 * literal so zero-config deployments still bill correctly.
 */
export function mergeCatalogWithDrops(
  seedModels: ModelInfo[],
  rows: IModelCatalogRow[],
  ctx: BackendGateContext
): CatalogMergeResult {
  // An absent catalog must be byte-identical to today's output, not merely equal.
  if (rows.length === 0) return { models: seedModels, dropped: [], gated: 0 };

  const rowsByModel = bucketByModel(rows);

  const models: ModelInfo[] = [];
  const dropped: CatalogMergeDrop[] = [];
  const seeded = new Set<string>();
  let gated = 0;

  for (const base of seedModels) {
    const modelId = String(base.id);
    seeded.add(modelId);
    const bucket = rowsByModel.get(modelId);
    if (!bucket) {
      models.push(base);
      continue;
    }
    const { draft, owned } = mergeRows(bucket, toModelRecord(base));
    const parsed = asRenderableRecord(draft);
    if ('reason' in parsed) {
      // A seeded model has a known-good adapter literal behind it, so a row that
      // makes the merged record unrenderable costs the row, not the model. Still
      // counted: the bad row has to stay visible in the run report.
      dropped.push({ modelId, reason: `${parsed.reason}; kept the adapter record` });
      models.push(base);
      continue;
    }
    // The catalog-only tier gets this from invocabilityBlocker; a seeded model
    // needs it separately, because invocabilityBlocker's active-lifecycle clause
    // would strip dispatch off every legacy-but-still-served seeded model.
    // Defense in depth rather than a live defect: no shipped seed row sets an
    // adapterFamily, discovery cannot claim {dispatch} on an existing model, and
    // there is no catalog-patch surface - but a rollback to a build that lost a
    // family, or the first catalog-edit endpoint, makes it reachable, and
    // backendForAdapterFamily THROWS on a family it cannot construct. Drop the
    // group, not the model: the adapter literal keeps serving.
    const family = parsed.record.adapterFamily;
    if (owned.has('dispatch') && family && !DISPATCHABLE_ADAPTER_FAMILIES.includes(family)) {
      dropped.push({
        modelId,
        reason: `adapterFamily "${family}" is not dispatchable by this build; kept the adapter dispatch`,
      });
      owned.delete('dispatch');
    }
    models.push(overlayOwnedGroups(base, parsed.record, owned));
  }

  for (const [modelId, bucket] of rowsByModel) {
    // A seeded model was already merged above; the per-user gate does not apply
    // to it, because its backend was constructed to produce it in the first place.
    if (seeded.has(modelId)) continue;

    const { draft } = mergeRows(bucket, null);
    // Checked on the draft, ahead of asRenderableRecord: a discovered-but-unpromoted
    // row can lack a claimed contextWindow by design, and the field check's
    // "incomplete record" reason would misreport that as a data defect.
    const status = (draft.lifecycle as { status?: string } | undefined)?.status;
    const lifecycleReason = inactiveLifecycleReason(status);
    if (lifecycleReason) {
      dropped.push({ modelId, reason: lifecycleReason });
      continue;
    }
    const parsed = asRenderableRecord(draft);
    if ('reason' in parsed) {
      dropped.push({ modelId, reason: parsed.reason });
      continue;
    }
    const record = parsed.record;
    const blockedBy = invocabilityBlocker(record);
    if (blockedBy) {
      dropped.push({ modelId, reason: blockedBy });
      continue;
    }
    if (!isBackendUsable(record.backend, ctx)) {
      gated += 1;
      continue;
    }
    models.push(toModelInfo(record));
  }

  return { models, dropped, gated };
}

/**
 * mergeCatalogWithDrops, reporting the drops once per rebuild instead of once
 * per row: the read path runs on every model-cache rebuild, so a per-row log
 * would repeat the same catalog defect every five minutes per process.
 */
export function mergeCatalog(seedModels: ModelInfo[], rows: IModelCatalogRow[], ctx: BackendGateContext): ModelInfo[] {
  const { models, dropped } = mergeCatalogWithDrops(seedModels, rows, ctx);
  if (dropped.length > 0) {
    const detail = dropped.map(drop => `${drop.modelId} (${drop.reason})`).join('; ');
    Logger.globalInstance.warn(`[modelCatalog] dropped ${dropped.length} catalog record(s): ${detail}`);
  }
  return models;
}

function bucketByModel(rows: IModelCatalogRow[]): Map<string, IModelCatalogRow[]> {
  const rowsByModel = new Map<string, IModelCatalogRow[]>();
  for (const row of rows) {
    const bucket = rowsByModel.get(row.modelId);
    if (bucket) bucket.push(row);
    else rowsByModel.set(row.modelId, [row]);
  }
  return rowsByModel;
}

/** One model's rows resolved into the belief they express, with who owns what. */
export interface ResolvedCatalogRecord {
  modelId: string;
  /** Sparse: only the keys some winning row actually carried. */
  record: Record<string, unknown>;
  ownedGroups: FieldGroup[];
}

/**
 * Resolve rows into one belief per model, with no seed base and no rendering.
 * Same per-group precedence mergeCatalogWithDrops uses - shared so the discovery
 * service diffs against the same rule the read path applies, rather than a
 * second implementation of the rule that can drift from this one.
 *
 * No curated base, so this is discovery's own view: for a model the adapter tables have since
 * curated, the read path reclaims the groups curation can state better - identity and limits, plus
 * availability only where discovery invented the disable - and this view reports what discovery
 * would write. The divergence is intended: it cannot write the adapter table.
 */
export function resolveCatalogRecords(rows: IModelCatalogRow[]): Map<string, ResolvedCatalogRecord> {
  const resolved = new Map<string, ResolvedCatalogRecord>();
  for (const [modelId, bucket] of bucketByModel(rows)) {
    const { draft, owned } = mergeRows(bucket, null);
    resolved.set(modelId, { modelId, record: draft, ownedGroups: [...owned] });
  }
  return resolved;
}

function outranks(candidate: IModelCatalogRow, incumbent: IModelCatalogRow, group: FieldGroup): boolean {
  const precedence = group === 'presentation' ? PRESENTATION_PRECEDENCE : SOURCE_PRECEDENCE;
  const candidateRank = precedence[candidate.source] ?? 0;
  const incumbentRank = precedence[incumbent.source] ?? 0;
  if (candidateRank !== incumbentRank) return candidateRank > incumbentRank;
  return candidate.effectiveFrom.getTime() > incumbent.effectiveFrom.getTime();
}

/**
 * Resolve one model's rows into a single draft record. `base` is the seeded
 * record for a known id (so groups no row claims fall through to the adapter
 * literal) and null for a catalog-only id.
 */
function mergeRows(
  bucket: IModelCatalogRow[],
  base: RenderableModelRecord | null
): { draft: Record<string, unknown>; owned: Set<FieldGroup> } {
  // A curated record presents this model (base is its adapter literal), so an un-promoted
  // introduction yields its placeholders to it. Without this, a model discovery introduced before
  // the adapter table curated it renders as its slug, at contextWindow 0 and auto-disabled, for good:
  // a per-image adapter price can never satisfy the promotion clause that would clear the flag.
  const curated = base !== null;
  const winners = new Map<FieldGroup, IModelCatalogRow>();
  for (const row of bucket) {
    for (const group of row.ownedGroups) {
      // A group name from a newer schema version claims nothing here.
      if (!isFieldGroup(group)) continue;
      if (curated && yieldsToCuration(row, group)) continue;
      const incumbent = winners.get(group);
      if (!incumbent || outranks(row, incumbent, group)) winners.set(group, row);
    }
  }

  const draft: Record<string, unknown> = base ? { ...base } : {};
  for (const [group, row] of winners) {
    for (const [key, value] of Object.entries(row.patch)) {
      if (value === undefined) continue;
      // Keys this build does not know map to no group and are discarded.
      if (FIELD_GROUP_OF[key as keyof ModelRecord] !== group) continue;
      draft[key] = value;
    }
  }
  // An operator winner applies as-is (the deliberate un-retire / re-enable path); the folds below skip it.
  foldLifecycle(draft, bucket, base, winners.get('lifecycle'));
  keepDisable(draft, bucket, base, winners.get('availability'));
  return { draft, owned: new Set(winners.keys()) };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Whether curation may reclaim this group from this row.
 *
 * Identity yields for every introduction - the curated label replaces whatever the row stated, a
 * pinned slug or a feed's own name - and for any row carrying its id as its name. Limits yields from
 * an introduction whose window is the 0 placeholder or which is not active; a nonzero window on an
 * active row is a measurement (an aggregator's join, a source's own figure), and a row a source
 * disabled after promotion keeps it. Availability is decided separately: alongside discovery's own
 * refusal it carries the provider's answer to "can this be called", and a model the account cannot
 * invoke must stay disabled.
 */
function yieldsToCuration(row: IModelCatalogRow, group: FieldGroup): boolean {
  if (row.source !== 'discovery') return false;
  if (group === 'availability') return inventsDisable(row);
  if (group === 'identity') return isIntroduction(row) || namesItself(row);
  if (group === 'limits') return isIntroduction(row) && (row.patch.contextWindow === 0 || !isActive(row));
  return false;
}

/**
 * Discovery writes `autoDisabled` when promotion refuses a model, so its own disable is a verdict.
 * A provider's disable ("not entitled in this AWS account") is a fact it reported, and curation has
 * no better claim on it.
 *
 * The row's `availability` contributor decides when it has one. It is a supply credit, not a
 * property of the disable, and the writer aligns the two: it credits discovery only when the run
 * decided the disable (the row was not disabled before, or the run cleared the source's own disable
 * and promotion then refused). A disable already in force that the run got no availability answer
 * for keeps its carried credit, whatever its wording. A row with no `availability` credit (written
 * before contributors existed, or re-claimed from one) falls back to the wording.
 */
function inventsDisable(row: IModelCatalogRow): boolean {
  if (row.patch.autoDisabled !== true) return false;
  const availability = row.contributors?.find(entry => entry.group === 'availability');
  if (availability) return availability.source === 'discovery';
  const reason = row.patch.autoDisabledReason;
  return typeof reason === 'string' && reason.length > 0 && isDiscoveryVerdict(reason);
}

/**
 * A row carrying its id as its name: the id the writer pins when a feed publishes none, or a feed
 * that names models by id (Ollama).
 */
const namesItself = (row: IModelCatalogRow): boolean =>
  typeof row.patch.name === 'string' && row.patch.name === row.modelId;

/** An active lifecycle means the model is being served, so what the row states about it was measured. */
const isActive = (row: IModelCatalogRow): boolean => row.patch.lifecycle?.status === 'active';

/**
 * A discovery row carrying what an introduction states: the row that introduced a since-curated
 * model, any snapshot of it, or a row a source has since disabled.
 *
 * The durable marker is `autoDisabled`: promotion writes `false` on the way out, so a row still
 * holding `true` is one discovery keeps out of the pickers, and the id-for-a-name and zero window it
 * had to state are placeholders. A promoted row keeps its limits claim even when the feed named the
 * model by its id (Ollama), so its measured window still corrects the curated one. `yieldsToCuration`
 * still gives identity to the curated label for any row carrying its id as its name - the writer's
 * pinned slug, or a feed that names models by id - and keeps the window of a row that is active,
 * including one a source has since disabled. Availability is not this marker's to decide.
 */
function isIntroduction(row: IModelCatalogRow): boolean {
  if (row.source !== 'discovery') return false;
  if (row.patch.autoDisabled === true) return true;
  // Rows written before the flag was carried forward: an un-promoted lifecycle says the same thing.
  return row.ownedGroups.includes('lifecycle') && row.patch.lifecycle?.status === 'discovered';
}

const claimsGroup = (row: IModelCatalogRow, group: FieldGroup): boolean =>
  row.source !== 'operator' && row.ownedGroups.includes(group);

/** An unranked status never displaces a ranked one; an unranked held one yields only to a sunset status. */
function displacesStatus(held: unknown, candidate: string): boolean {
  const rank = lifecycleStatusRank(candidate);
  if (rank === undefined) return false;
  const heldRank = lifecycleStatusRank(held);
  if (heldRank !== undefined) return rank > heldRank;
  return held === undefined || LIFECYCLE_SUNSET_STATUSES.has(candidate);
}

/**
 * Below operator, lifecycle only moves toward sunset: across the non-operator rows and the adapter
 * literal, the earliest dates, furthest ranked status and superseded marker win. replacedBy stays the winner's.
 */
function foldLifecycle(
  draft: Record<string, unknown>,
  bucket: IModelCatalogRow[],
  base: RenderableModelRecord | null,
  winner: IModelCatalogRow | undefined
) {
  if (!winner || winner.source === 'operator') return;
  const lifecycles = [
    base?.lifecycle,
    ...bucket.filter(row => claimsGroup(row, 'lifecycle')).map(row => row.patch.lifecycle),
  ].filter(isRecord);
  if (lifecycles.length === 0) return;

  const folded: Record<string, unknown> = isRecord(draft.lifecycle) ? { ...draft.lifecycle } : {};
  for (const lifecycle of lifecycles) {
    if (lifecycle.isSuperseded === true) folded.isSuperseded = true;
    for (const key of LIFECYCLE_DATE_KEYS) {
      const date = lifecycle[key];
      const current = folded[key];
      if (typeof date === 'string' && (typeof current !== 'string' || date < current)) folded[key] = date;
    }
    if (typeof lifecycle.status === 'string' && displacesStatus(folded.status, lifecycle.status)) {
      folded.status = lifecycle.status;
    }
  }
  draft.lifecycle = folded;
}

/** Below operator, another source's `disabled: false` does not clear a disable the adapter literal or a row holds. */
function keepDisable(
  draft: Record<string, unknown>,
  bucket: IModelCatalogRow[],
  base: RenderableModelRecord | null,
  winner: IModelCatalogRow | undefined
) {
  if (!winner || winner.source === 'operator' || draft.disabled === true) return;
  let disabler: IModelCatalogRow | undefined;
  for (const row of bucket) {
    const disables = claimsGroup(row, 'availability') && row.patch.disabled === true;
    if (disables && (!disabler || outranks(row, disabler, 'availability'))) disabler = row;
  }
  if (!disabler && base?.disabled !== true) return;
  draft.disabled = true;
  const reason = disabler ? disabler.patch.disabledReason : base?.disabledReason;
  if (typeof reason === 'string') draft.disabledReason = reason;
  else delete draft.disabledReason;
}

/**
 * Narrow a merged draft to a record this build can render, or say why not. The
 * lenient read schema keeps enum-valued fields as free strings precisely so the
 * decision lands here: an unknown type or backend is a drop the merge counts,
 * not a parse rejection that alarms on benign version skew.
 */
function asRenderableRecord(draft: Record<string, unknown>): { record: RenderableModelRecord } | { reason: string } {
  const missing = ['id', 'vendor', 'name'].filter(key => typeof draft[key] !== 'string' || draft[key] === '');
  if (typeof draft.contextWindow !== 'number') missing.push('contextWindow');
  if (missing.length > 0) return { reason: `incomplete record: missing ${missing.join(', ')}` };

  if (typeof draft.backend !== 'string' || !MODEL_BACKENDS.includes(draft.backend)) {
    return { reason: `unknown backend "${String(draft.backend)}"` };
  }
  if (typeof draft.type !== 'string' || !isRenderableModelType(draft.type)) {
    return { reason: `unsupported model type "${String(draft.type)}"` };
  }
  // Checked field by field above; the remaining fields were already shape-validated
  // by the lenient read schema, which is what makes this narrowing safe.
  return { record: draft as unknown as RenderableModelRecord };
}

/**
 * Why a lifecycle status is not invocable, or null when it is "active". Shared
 * between invocabilityBlocker and the catalog-only tier's pre-parse check, so
 * both agree on the exact wording.
 */
function inactiveLifecycleReason(status: string | undefined): string | null {
  if (status !== 'active') return `lifecycle status "${status ?? 'unset'}" is not invocable`;
  return null;
}

/** Why a catalog-only record is metadata-only, or null when it is invocable. */
function invocabilityBlocker(record: RenderableModelRecord): string | null {
  const lifecycleReason = inactiveLifecycleReason(record.lifecycle?.status);
  if (lifecycleReason) return lifecycleReason;
  if (!record.adapterFamily) return 'no adapterFamily';
  if (!DISPATCHABLE_ADAPTER_FAMILIES.includes(record.adapterFamily)) {
    return `adapterFamily "${record.adapterFamily}" is not dispatchable by this build`;
  }
  if (!record.dispatchProfile) return 'no dispatchProfile';
  if (isDedicatedApiModel(record.id))
    return 'needs a dedicated API or a mandatory tool; not callable as a plain text model';
  return null;
}

/**
 * Re-render only the ModelInfo fields whose group a catalog row claimed. Fields
 * of an unclaimed group are copied from the seeded ModelInfo untouched, so a row
 * owning {presentation} cannot normalize a model's limits or capabilities as a
 * side effect of toModelInfo's defaults.
 */
function overlayOwnedGroups(base: ModelInfo, record: RenderableModelRecord, owned: Set<FieldGroup>): ModelInfo {
  const derived = toModelInfo(record) as unknown as Record<string, unknown>;
  const out = { ...base } as unknown as Record<string, unknown>;
  for (const [key, group] of MODEL_INFO_GROUPS) {
    if (owned.has(group)) out[key] = derived[key];
  }
  // Pricing is never catalog-sourced: the adapter literal must survive until
  // applyModelPriceCatalog overlays a row for this model.
  out.pricing = base.pricing;
  return out as unknown as ModelInfo;
}
