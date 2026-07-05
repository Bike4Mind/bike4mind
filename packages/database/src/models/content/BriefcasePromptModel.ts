import mongoose from 'mongoose';
import { softDeletePlugin } from '../../utils/mongo';
import {
  IBriefcasePrompt,
  IBriefcasePromptDocument,
  IBriefcasePromptRepository,
  ExecutionMode,
  CATALOG_SUBQUERY_LIMIT,
  B4MLLMToolsList,
} from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

interface IBriefcasePromptModel extends mongoose.Model<IBriefcasePromptDocument> {}

/** Fields returned for launcher rendering - promptText is deliberately excluded. */
const CATALOG_PROJECTION = '-promptText';

/**
 * `.lean()` returns the raw Mongo doc (`_id`, no `id` virtual / toJSON transform),
 * but every consumer (client launcher, by-id refetch, types) expects `id: string`.
 * Surface it explicitly so launchers don't dispatch `prompt.id === undefined`.
 */
type LeanDoc = { _id: unknown } & Partial<IBriefcasePromptDocument>;
function withId(doc: LeanDoc): IBriefcasePromptDocument {
  return { ...doc, id: String(doc._id) } as IBriefcasePromptDocument;
}

/**
 * Build the visibilityScopes filter clause. `null` => no clause (admin bypass).
 * Otherwise: prompt is unscoped (empty/absent/null) OR its scopes intersect the
 * caller's (case-insensitive, matching the canSeeSystemPrompt predicate). Pushing
 * this into the query means the result cap (.limit) applies to the VISIBLE set
 * rather than silently dropping entitled prompts ranked past the cap.
 */
function visibilityClause(scopes: string[] | null): Record<string, unknown> {
  if (scopes === null) return {};
  const all = Array.from(new Set(scopes.flatMap(s => [s, s.toLowerCase()])));
  return {
    $or: [
      { visibilityScopes: { $size: 0 } },
      { visibilityScopes: { $exists: false } },
      { visibilityScopes: null },
      { visibilityScopes: { $in: all } },
    ],
  };
}

class BriefcasePromptRepository extends BaseRepository<IBriefcasePromptDocument> implements IBriefcasePromptRepository {
  constructor(private briefcaseModel: IBriefcasePromptModel) {
    super(briefcaseModel);
  }

  async listPersonal(userId: string): Promise<IBriefcasePromptDocument[]> {
    const results = await this.briefcaseModel
      .find({ userId, deletedAt: null })
      .select(CATALOG_PROJECTION)
      .limit(CATALOG_SUBQUERY_LIMIT)
      .lean<LeanDoc[]>();
    return results.map(withId);
  }

  async listSystemByType(type: string, visibility: string[] | null): Promise<IBriefcasePromptDocument[]> {
    const results = await this.briefcaseModel
      .find({ userId: null, type, deletedAt: null, ...visibilityClause(visibility) })
      .select(CATALOG_PROJECTION)
      .limit(CATALOG_SUBQUERY_LIMIT)
      .lean<LeanDoc[]>();
    return results.map(withId);
  }

  async listSystemByTags(tags: string[], visibility: string[] | null): Promise<IBriefcasePromptDocument[]> {
    const results = await this.briefcaseModel
      .find({ userId: null, tags: { $in: tags }, deletedAt: null, ...visibilityClause(visibility) })
      .select(CATALOG_PROJECTION)
      .limit(CATALOG_SUBQUERY_LIMIT)
      .lean<LeanDoc[]>();
    return results.map(withId);
  }

  async findByIdForCaller(id: string, callerUserId: string): Promise<IBriefcasePromptDocument | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    // System prompt (userId null) OR owned by the caller - never another user's.
    const result = await this.briefcaseModel
      .findOne({ _id: id, deletedAt: null, $or: [{ userId: null }, { userId: callerUserId }] })
      .lean<LeanDoc>();
    return result ? withId(result) : null;
  }

  async updateOwned(
    id: string,
    userId: string,
    patch: Partial<IBriefcasePrompt>
  ): Promise<IBriefcasePromptDocument | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    // Scope the update to (id, owner) so a forged id can't touch another user's prompt.
    const result = await this.briefcaseModel
      .findOneAndUpdate({ _id: id, userId, deletedAt: null }, { $set: patch }, { new: true })
      .lean<LeanDoc>();
    return result ? withId(result) : null;
  }

  async softDeleteOwned(id: string, userId: string): Promise<boolean> {
    if (!mongoose.isValidObjectId(id)) return false;
    const result = await this.briefcaseModel.updateOne(
      { _id: id, userId, deletedAt: null },
      { $set: { deletedAt: new Date() } }
    );
    return result.modifiedCount > 0;
  }
}

const BriefcasePromptSchema = new mongoose.Schema<IBriefcasePromptDocument>(
  {
    type: { type: String, required: true, maxlength: 100 },
    name: { type: String, required: true, maxlength: 200 },
    description: { type: String, maxlength: 500 },
    promptText: { type: String, required: true, maxlength: 16_000 },
    tags: [{ type: String }],
    // null/absent => system (shared) prompt; set => personal prompt owned by that user.
    userId: { type: String, default: null },
    executionMode: {
      type: String,
      enum: ['inject', 'auto-fire', 'hidden'] satisfies ExecutionMode[],
      default: 'inject',
    },
    // Entitlement scoping for system prompts (mapped to user tags). Empty => all.
    visibilityScopes: [{ type: String }],
    // Constrained to the known tool set so a stored prompt can't carry a tool that
    // no longer exists (the API allowlist further excludes integration-gated tools).
    requiredTools: [{ type: String, enum: B4MLLMToolsList }],
    schemaVersion: { type: Number, default: 1, required: true },
  },
  { timestamps: true }
);

BriefcasePromptSchema.plugin(softDeletePlugin);

// Compound indexes matching the catalog query shapes. type and tags live in
// SEPARATE indexes - Mongo forbids a compound index spanning two array fields.
BriefcasePromptSchema.index({ userId: 1, deletedAt: 1 }); // personal scope
BriefcasePromptSchema.index({ userId: 1, type: 1, deletedAt: 1 }); // system-by-type
BriefcasePromptSchema.index({ userId: 1, tags: 1, deletedAt: 1 }); // system-by-tags (multikey on tags)
// NOTE: no DB-level unique constraint on the system-prompt natural key
// (userId:null, type, name). Seed idempotency is enforced at the application
// layer via $setOnInsert on that key in the seed migration, which is sufficient
// because the migration runner is single-threaded (concurrent seeding can't
// occur). A `partialFilterExpression: { userId: null }` unique index was
// deliberately avoided - null-equality partial filters aren't proven on the
// DocumentDB target and a failed createIndexes() would break the deploy.

export const BriefcasePrompt: IBriefcasePromptModel =
  (mongoose.models.BriefcasePrompt as IBriefcasePromptModel) ||
  mongoose.model<IBriefcasePromptDocument, IBriefcasePromptModel>('BriefcasePrompt', BriefcasePromptSchema);

export const briefcasePromptRepository = new BriefcasePromptRepository(BriefcasePrompt);
