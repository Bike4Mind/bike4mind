import {
  FIELD_GROUP_OF,
  MODEL_INFO_FIELD_GROUP_OF,
  ModelBackend,
  isFieldGroup,
  isRenderableModelType,
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
  'bedrock-jurassic',
  'bedrock-titan',
  'gemini',
  'xai',
  'ollama',
  'bfl',
  'local-image',
  'aws',
];

/** operator > discovery > seed, per field group. An unrecognized source ranks
 * below all three: it still contributes where nothing else does (the lenient
 * read never discards data) but can never outrank a source this build knows. */
const SOURCE_PRECEDENCE: Record<string, number> = { operator: 3, discovery: 2, seed: 1 };

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
 * patch overrides what it names and nothing else.
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
    models.push(overlayOwnedGroups(base, parsed.record, owned));
  }

  for (const [modelId, bucket] of rowsByModel) {
    // A seeded model was already merged above; the per-user gate does not apply
    // to it, because its backend was constructed to produce it in the first place.
    if (seeded.has(modelId)) continue;

    const { draft } = mergeRows(bucket, null);
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
 * service diffs against exactly the view the read path will produce, rather than
 * a second implementation of the rule that can drift from this one.
 */
export function resolveCatalogRecords(rows: IModelCatalogRow[]): Map<string, ResolvedCatalogRecord> {
  const resolved = new Map<string, ResolvedCatalogRecord>();
  for (const [modelId, bucket] of bucketByModel(rows)) {
    const { draft, owned } = mergeRows(bucket, null);
    resolved.set(modelId, { modelId, record: draft, ownedGroups: [...owned] });
  }
  return resolved;
}

function outranks(candidate: IModelCatalogRow, incumbent: IModelCatalogRow): boolean {
  const candidateRank = SOURCE_PRECEDENCE[candidate.source] ?? 0;
  const incumbentRank = SOURCE_PRECEDENCE[incumbent.source] ?? 0;
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
  const winners = new Map<FieldGroup, IModelCatalogRow>();
  for (const row of bucket) {
    for (const group of row.ownedGroups) {
      // A group name from a newer schema version claims nothing here.
      if (!isFieldGroup(group)) continue;
      const incumbent = winners.get(group);
      if (!incumbent || outranks(row, incumbent)) winners.set(group, row);
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
  return { draft, owned: new Set(winners.keys()) };
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

/** Why a catalog-only record is metadata-only, or null when it is invocable. */
function invocabilityBlocker(record: RenderableModelRecord): string | null {
  const status = record.lifecycle?.status;
  if (status !== 'active') return `lifecycle status "${status ?? 'unset'}" is not invocable`;
  if (!record.adapterFamily) return 'no adapterFamily';
  if (!DISPATCHABLE_ADAPTER_FAMILIES.includes(record.adapterFamily)) {
    return `adapterFamily "${record.adapterFamily}" is not dispatchable by this build`;
  }
  if (!record.dispatchProfile) return 'no dispatchProfile';
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
