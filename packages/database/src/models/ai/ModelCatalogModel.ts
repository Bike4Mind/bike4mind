import mongoose, { Model, Schema, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import {
  CATALOG_ROW_SOURCES,
  CATALOG_SCHEMA_VERSION,
  CatalogRowSource,
  IModelCatalogReadResult,
  IModelCatalogRepository,
  IModelCatalogRow,
  IModelCatalogRowDocument,
  IModelCatalogRowInput,
  ModelCatalogRowInput,
  ModelCatalogRowRead,
} from '@bike4mind/common';

/** The one source rowsInForce never collapses; see its docstring for why. */
const OPERATOR_SOURCE: CatalogRowSource = 'operator';

/**
 * Append-only provider and operator beliefs about a model: availability,
 * capabilities, lifecycle, dispatch. One row per model per run, so "what did we
 * believe about this model at time T" stays answerable and every change carries
 * provenance. Rows are never deleted - a retired model keeps its newest row
 * forever so historical sessions and ledgers stay readable.
 *
 * Pricing deliberately has no home here: it lives in ModelPrice, and the append
 * schema rejects a row that carries any.
 */
const ModelCatalogSchema = new Schema<IModelCatalogRowDocument>(
  {
    // Free String, not an enum: retired and runtime-discovered ids must read back.
    modelId: { type: String, required: true },
    schemaVersion: { type: Number, required: true },
    // Full ModelRecord snapshot (seed/discovery) or a sparse operator patch.
    // Mixed because the shape is versioned by schemaVersion: a typed subdocument
    // would strip every field added after this build was compiled. Zod validates
    // on append and re-parses leniently on read.
    patch: { type: Schema.Types.Mixed, required: true },
    ownedGroups: { type: [String], required: true },
    effectiveFrom: { type: Date, required: true },
    source: { type: String, required: true, enum: [...CATALOG_ROW_SOURCES] },
    contributors: {
      type: [new Schema({ group: { type: String }, source: { type: String } }, { _id: false })],
      required: false,
    },
    note: { type: String, required: false },
    // String, not ObjectId: rowsInForce reads through aggregation, which bypasses
    // Mongoose casting, and an ObjectId instance would fail the string read schema
    // and drop the row.
    runId: { type: String, required: false },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Unique: a run stamps every row with the run's startedAt, so two drivers racing
// the same window collide here instead of double-writing (the price-seeding race
// design). append() treats the collision as a skip.
ModelCatalogSchema.index({ modelId: 1, effectiveFrom: -1 }, { unique: true });
// The non-operator half of rowsInForce filters on effectiveFrom alone, which
// cannot use the compound index above (effectiveFrom is not its prefix).
ModelCatalogSchema.index({ effectiveFrom: -1 });
// The operator half reads every operator row rather than the newest one, so it
// scans the rare rows by source instead of every row in force.
ModelCatalogSchema.index({ source: 1, effectiveFrom: -1 });

export type IModelCatalogModel = Model<IModelCatalogRowDocument>;

export class ModelCatalogRepository
  extends BaseRepository<IModelCatalogRowDocument>
  implements IModelCatalogRepository
{
  constructor(model: IModelCatalogModel) {
    super(model);
  }

  async append(row: IModelCatalogRowInput): Promise<IModelCatalogRowDocument | null> {
    // Zod first: Mongoose accepts anything in a Mixed field, including the
    // pricing key that must never reach this collection.
    const parsed = ModelCatalogRowInput.parse(row);
    try {
      return await this.create({ ...parsed, schemaVersion: CATALOG_SCHEMA_VERSION } as IModelCatalogRowDocument);
    } catch (error) {
      // E11000: a concurrent driver already wrote this model for this run window.
      if ((error as { code?: number }).code === 11000) return null;
      throw error;
    }
  }

  /**
   * Every row in force at `at` that per-group precedence can need, newest
   * effectiveFrom first: the newest NON-operator row per (modelId, source) plus
   * EVERY operator row. Deliberately more than one row per model.
   *
   * MUST STAY IN SYNC WITH mergeCatalog (b4m-core/llm-adapters/src/mergeCatalog.ts),
   * which resolves precedence per FIELD GROUP, not per row: within a group the
   * newest operator row wins, else the newest discovery row, else seed. Handing
   * it one row per model would let a sparse operator patch owning {presentation}
   * shadow the discovery row owning {limits} instead of overlaying it. Operator
   * rows are rare and each may own a different group, so none of them collapse;
   * the seed row survives to back the groups no later row claims.
   *
   * A consumer that wants only the newest row for a model takes the first row
   * matching that modelId - within a model effectiveFrom is unique (the append
   * index), so newest-first ordering makes that unambiguous.
   */
  async rowsInForce(at: Date = new Date()): Promise<IModelCatalogRow[]> {
    const { rows, rejected, rejectedModelIds } = await this.rowsInForceWithRejects(at);
    if (rejected > 0) {
      console.error(
        `[modelCatalog] CatalogRowsRejected=${rejected}: dropped unreadable rows for ${rejectedModelIds.join(', ')}`
      );
    }
    return rows;
  }

  /** rowsInForce plus the lenient-parse drop count over ALL the rows it returns. */
  async rowsInForceWithRejects(at: Date = new Date()): Promise<IModelCatalogReadResult> {
    // Two reads, not one $unionWith: that stage is not DocumentDB-native, while
    // these stages are the same ones modelPriceRepository.rowsInForce uses.
    // Aggregation bypasses Mongoose casting, which is why the Mixed patch is
    // re-parsed below rather than trusted.
    const [collapsed, operator] = await Promise.all([
      this.model.aggregate([
        { $match: { effectiveFrom: { $lte: at }, source: { $ne: OPERATOR_SOURCE } } },
        { $sort: { effectiveFrom: -1 } },
        { $group: { _id: { modelId: '$modelId', source: '$source' }, doc: { $first: '$$ROOT' } } },
        { $replaceRoot: { newRoot: '$doc' } },
      ]),
      this.model.find({ source: OPERATOR_SOURCE, effectiveFrom: { $lte: at } }).lean(),
    ]);
    const result = parseRows([...collapsed, ...operator]);
    // $group emits its buckets in no defined order and the operator rows arrive
    // from a separate read, so the ordering the merge relies on is imposed here.
    result.rows.sort(newestFirst);
    return result;
  }

  async historyForModel(modelId: string): Promise<IModelCatalogRow[]> {
    const docs = await this.model.find({ modelId }).sort({ effectiveFrom: -1 }).lean();
    return parseRows(docs).rows;
  }
}

/** Newest first, modelId breaking the ties one run creates (a run stamps every
 * row it writes with the same startedAt). */
function newestFirst(a: IModelCatalogRow, b: IModelCatalogRow): number {
  const byTime = b.effectiveFrom.getTime() - a.effectiveFrom.getTime();
  return byTime !== 0 ? byTime : a.modelId.localeCompare(b.modelId);
}

/**
 * Lenient read: a row that fails to parse drops THAT ROW ONLY and is counted.
 * A parse failure must never empty the catalog or shorten the model list, so no
 * caller here throws - the count is what alarms.
 */
function parseRows(docs: unknown[]): IModelCatalogReadResult {
  const rows: IModelCatalogRow[] = [];
  const rejectedModelIds: string[] = [];
  for (const doc of docs) {
    const parsed = ModelCatalogRowRead.safeParse(doc);
    if (parsed.success) {
      rows.push(parsed.data);
    } else {
      const modelId = (doc as { modelId?: unknown })?.modelId;
      rejectedModelIds.push(typeof modelId === 'string' ? modelId : '<unknown>');
    }
  }
  return { rows, rejected: rejectedModelIds.length, rejectedModelIds };
}

export const ModelCatalog =
  (mongoose.models['ModelCatalog'] as unknown as IModelCatalogModel) ??
  model<IModelCatalogRowDocument>('ModelCatalog', ModelCatalogSchema);
export const modelCatalogRepository = new ModelCatalogRepository(ModelCatalog);
