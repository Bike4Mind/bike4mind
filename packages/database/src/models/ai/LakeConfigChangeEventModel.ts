import mongoose, { Model, Schema } from 'mongoose';
import type {
  ILakeConfigChangeEventDocument,
  ILakeConfigChangeEventRepository,
  RecordLakeConfigChangeInput,
} from '@bike4mind/common';
import {
  LAKE_CONFIG_CHANGE_ACTIONS,
  LAKE_CONFIG_CHANGE_FIELDS,
  LAKE_CONFIG_CHANGE_PRINCIPAL_KINDS,
  LAKE_CONFIG_CHANGE_VALUE_KINDS,
  LAKE_CONFIG_FINGERPRINTED_FIELDS,
  LAKE_CONFIG_MAX_CHANGES,
  LAKE_CONFIG_TEXT_HASH_CHARS,
  LAKE_CONFIG_VALUE_MAX_CHARS,
  LAKE_MANAGE_RUNGS,
  lakeConfigExpiresAt,
  resolveLakeConfigAuditRetentionDays,
} from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

const ModelName = 'LakeConfigChangeEvent';

/**
 * The write-side audit trail: one document per accepted lake CONFIG write, recording WHO changed
 * the lake, WHAT moved (before -> after), and WHICH manage rung authorized it. See
 * LakeConfigChangeEventTypes.ts for the field-by-field rationale.
 *
 * A sibling of LakeAccessEventModel, deliberately NOT an extension of it: that schema is
 * read-shaped (returnedChunkIds/surface/queryTextLogged) and its TTL is tuned for query volume,
 * where this collection is rare, high-value, and wants a much longer clock. Shared vocabulary
 * (principalKind/principalId, the expiresAt TTL shape, an append-only repository), separate
 * collection and separate retention lever.
 *
 * Like the access event, it does NOT copy MemoryLedgerEventModel's hash chain: a chain is
 * incompatible with a TTL, whose sweep deletes the tail and makes verification fail by
 * construction.
 */
interface ILakeConfigChangeEventModel extends Model<ILakeConfigChangeEventDocument> {}

// Shared by both fingerprint paths. Mongoose gives each path its own caster when one Schema
// instance is bound twice, so the two do not interfere - sharing a subschema across paths is a
// documented pattern, not a hazard.
const FingerprintSchema = new Schema(
  {
    present: { type: Boolean, required: true },
    length: { type: Number, required: true, min: 0 },
    // The hash is the ONLY place a fingerprinted field's text has any representation at all, so
    // the schema bounds it too - a future caller that mistakenly hands this model the prompt
    // instead of its digest is rejected here rather than quietly storing it.
    hash: { type: String, default: '', maxlength: LAKE_CONFIG_TEXT_HASH_CHARS },
  },
  { _id: false }
);

// _id: false - a change is a value, not an entity; giving each one an ObjectId would add a field
// nothing joins on. `before`/`after` are Mixed because a bounded config value is legitimately a
// string, a number or a boolean and Mongoose has no union primitive. `null` is storable only
// because the path is Mixed: a CLEAR is recorded as an ABSENT key, never as null (see
// diffLakeConfig, and the note on LakeConfigLiteralValue).
const LakeConfigFieldChangeSchema = new Schema(
  {
    field: { type: String, enum: LAKE_CONFIG_CHANGE_FIELDS, required: true },
    kind: { type: String, enum: LAKE_CONFIG_CHANGE_VALUE_KINDS, required: true },
    before: { type: Schema.Types.Mixed },
    after: { type: Schema.Types.Mixed },
    beforeFingerprint: { type: FingerprintSchema, required: false },
    afterFingerprint: { type: FingerprintSchema, required: false },
    truncated: { type: Boolean },
  },
  { _id: false }
);

/**
 * The never-a-second-copy-of-the-prompt property, enforced HERE rather than left resting on one
 * caller. `diffLakeConfig` is careful, but it is not the only thing that can ever write to this
 * collection, and the whole reason a fingerprinted field exists is that a verbatim copy in a
 * three-year-retention collection is the outcome worth making structurally impossible. A change
 * naming a fingerprinted field must be a fingerprint change and must carry no literal value.
 */
LakeConfigFieldChangeSchema.pre('validate', function enforceFingerprintedFields(next) {
  const change = this as unknown as { field?: string; kind?: string; before?: unknown; after?: unknown };
  const fingerprinted = (LAKE_CONFIG_FINGERPRINTED_FIELDS as readonly string[]).includes(change.field ?? '');
  if (fingerprinted && change.kind !== 'fingerprint') {
    return next(new Error(`[lakeConfigChangeEvent] ${change.field} must be recorded as a fingerprint, not a literal`));
  }
  if (fingerprinted && (change.before !== undefined || change.after !== undefined)) {
    return next(new Error(`[lakeConfigChangeEvent] ${change.field} must not carry a literal before/after value`));
  }
  // The caller-side cap (capLakeConfigValue) is the primary bound; this is the backstop for a
  // writer that never went through it.
  for (const value of [change.before, change.after]) {
    if (typeof value === 'string' && Array.from(value).length > LAKE_CONFIG_VALUE_MAX_CHARS) {
      return next(new Error(`[lakeConfigChangeEvent] ${change.field} literal exceeds the stored-value cap`));
    }
  }
  return next();
});

const LakeConfigChangeEventSchema = new Schema<ILakeConfigChangeEventDocument>(
  {
    principalKind: { type: String, enum: LAKE_CONFIG_CHANGE_PRINCIPAL_KINDS, required: true },
    principalId: { type: String, required: true },
    onBehalfOfUserId: { type: String },
    organizationId: { type: String },
    dataLakeId: { type: String, required: true },
    manageRung: { type: String, enum: LAKE_MANAGE_RUNGS, required: true },
    action: { type: String, enum: LAKE_CONFIG_CHANGE_ACTIONS, required: true },
    changes: { type: [LakeConfigFieldChangeSchema], default: [] },
    // Computed at write time from the floor-clamped retention. `immutable` blocks the ordinary
    // updateOne/updateMany/findOneAndUpdate paths (Mongoose strips immutable fields from a query
    // update's cast unless the caller passes `overwriteImmutable: true`) - a backstop against an
    // accidental mutation, NOT a guarantee against a caller that deliberately opts out or reaches
    // the collection via the raw driver. The repository below exposes no update/delete at all.
    expiresAt: { type: Date, required: true, immutable: true },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

LakeConfigChangeEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// "What changed on this lake, newest first?" - the owner-facing history query, and the reason
// this collection exists. The only query index carried, because it is the only one with a reader:
// the repository exposes `record` and `listByLake` and nothing else.
//
// Deliberately NOT carried: by-principal and by-organization compounds. Both were speculative -
// an org-wide admin audit browser is out of scope for this issue by design, and no by-principal
// reader is planned either - and an index with no reader is pure cost, paid on every insert into
// a collection whose retention is three years. Add each with the feature that queries it.
// If a by-principal index is ever wanted, lead it with `dataLakeId`: batch-completion writes a
// `system`/`system` pair, so `principalKind + principalId` alone would pile a large share of all
// rows into one low-selectivity slot.
LakeConfigChangeEventSchema.index({ dataLakeId: 1, createdAt: -1 });

export const LakeConfigChangeEventModel: ILakeConfigChangeEventModel =
  (mongoose.models[ModelName] as ILakeConfigChangeEventModel) ||
  mongoose.model<ILakeConfigChangeEventDocument, ILakeConfigChangeEventModel>(ModelName, LakeConfigChangeEventSchema);

class LakeConfigChangeEventRepository
  extends BaseRepository<ILakeConfigChangeEventDocument>
  implements ILakeConfigChangeEventRepository
{
  constructor(private eventModel: mongoose.Model<ILakeConfigChangeEventDocument>) {
    super(eventModel);
  }

  /**
   * Record one config-change event. The floor clamp is resolved INSIDE this function, never
   * trusted from the caller, so no caller can shorten the retention below the platform floor by
   * passing an unclamped `retentionDays` - the same contract as lakeAccessEventRepository.record.
   */
  async record(input: RecordLakeConfigChangeInput): Promise<ILakeConfigChangeEventDocument> {
    // The real wall clock, always - there is no caller-facing override. An injectable `now` would
    // let a caller backdate an event past its own floor-clamped window, since the floor bounds the
    // DURATION, not the point it is measured from. Tests control time with `vi.useFakeTimers()`.
    const now = new Date();
    const retentionDays = resolveLakeConfigAuditRetentionDays(input.retentionDays);

    const created = await this.eventModel.create({
      principalKind: input.principalKind,
      principalId: input.principalId,
      onBehalfOfUserId: input.onBehalfOfUserId,
      organizationId: input.organizationId,
      dataLakeId: input.dataLakeId,
      manageRung: input.manageRung,
      action: input.action,
      changes: input.changes.slice(0, LAKE_CONFIG_MAX_CHANGES),
      expiresAt: lakeConfigExpiresAt(now, retentionDays),
    });
    return created.toJSON() as unknown as ILakeConfigChangeEventDocument;
  }

  async listByLake(lakeId: string, opts?: { limit?: number }): Promise<ILakeConfigChangeEventDocument[]> {
    const query = this.eventModel.find({ dataLakeId: lakeId }).sort({ createdAt: -1 });
    if (opts?.limit) query.limit(opts.limit);
    const docs = await query;
    return docs.map(d => d.toJSON() as unknown as ILakeConfigChangeEventDocument);
  }
}

export const lakeConfigChangeEventRepository: ILakeConfigChangeEventRepository = new LakeConfigChangeEventRepository(
  LakeConfigChangeEventModel
);
