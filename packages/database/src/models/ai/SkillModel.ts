import mongoose, { Model, Schema, model } from 'mongoose';
import { ISkill, ISkillDocument, ISkillMethods, ISkillRepository } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';
import { softDeletePlugin } from '../../utils/mongo';
import { ShareableDocumentSchema, ShareableDocumentRepository } from '../content/SharableDocumentModel';

const ModelName = 'Skill';

/** Escape regex metacharacters in user-supplied search input. */
function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface ISkillModel extends Model<ISkillDocument, {}, ISkillMethods> {}

export class SkillRepository extends BaseRepository<ISkillDocument> implements ISkillRepository {
  shareable: ISkillRepository['shareable'];

  constructor(
    private skillModel: ISkillModel,
    extensions: {
      shareable: ISkillRepository['shareable'];
    }
  ) {
    super(skillModel);
    this.skillModel = skillModel;
    this.shareable = extensions.shareable;
  }

  async searchAccessible(
    userId: string,
    search: string,
    filters: { query?: Record<string, unknown> },
    pagination: { page: number; limit: number },
    orderBy: { by: 'createdAt' | 'updatedAt' | 'name'; direction: 'asc' | 'desc' },
    scope?: { isAdmin?: boolean; adminOrganizationIds?: string[] }
  ) {
    // Base visibility: owned, shared, or global-read. Admins additionally see
    // system skills, and org-admins see the skills of the orgs they administer -
    // so the person who creates a system/org-scoped skill can find it in their
    // listing (without this they'd 201 a skill they can never see again). These
    // are scoped lookups (isSystem / a bounded org-id `$in`), not a fan-out.
    const orConditions: Record<string, unknown>[] = [{ userId }, { 'users.userId': userId }, { isGlobalRead: true }];
    if (scope?.isAdmin) {
      orConditions.push({ isSystem: true });
    }
    if (scope?.adminOrganizationIds && scope.adminOrganizationIds.length > 0) {
      orConditions.push({ organizationId: { $in: scope.adminOrganizationIds } });
    }

    const queryConditions: Record<string, unknown> = {
      $or: orConditions,
      ...(filters.query || {}),
      deletedAt: null,
    };

    if (search) {
      // Escape regex metacharacters so a user-controlled query can't trigger
      // catastrophic backtracking (e.g. `(a+)+$`) and hang the Lambda. Same
      // pattern an AgentModel follow-up should adopt - public list endpoints
      // pass `search` straight from the URL query string.
      const escaped = escapeRegExp(search);
      queryConditions.$and = [
        {
          $or: [{ name: { $regex: escaped, $options: 'si' } }, { description: { $regex: escaped, $options: 'si' } }],
        },
      ];
    }

    const query = this.skillModel.find(queryConditions);
    const total = await this.skillModel.countDocuments(queryConditions);

    query.skip((pagination.page - 1) * pagination.limit).limit(pagination.limit + 1);
    query.sort({ [orderBy.by]: orderBy.direction === 'asc' ? 1 : -1 });

    const result = await query.exec();
    const hasMore = result.length === pagination.limit + 1;
    if (hasMore) result.pop();

    return {
      data: result.map(doc => doc.toJSON()),
      hasMore,
      total,
    };
  }

  // All scope-aware lookups filter on `deletedAt: null` - softDeletePlugin
  // defaults the field to null on every doc, so `$exists: false` would miss
  // live records. Using `null` uniformly keeps `find` and `countDocuments`
  // behavior identical (only `find`/`findOne` get the plugin's pre-hook).

  async listForUser(userId: string): Promise<ISkill[]> {
    const results = await this.skillModel.find({ userId, deletedAt: null }).sort({ name: 1 });
    return results.map(doc => doc.toJSON());
  }

  async listForOrganization(organizationId: string): Promise<ISkill[]> {
    const results = await this.skillModel.find({ organizationId, deletedAt: null }).sort({ name: 1 });
    return results.map(doc => doc.toJSON());
  }

  async listSystem(): Promise<ISkill[]> {
    const results = await this.skillModel.find({ isSystem: true, deletedAt: null }).sort({ name: 1 });
    return results.map(doc => doc.toJSON());
  }

  async findByNameForUser(userId: string, name: string): Promise<ISkill | null> {
    const result = await this.skillModel.findOne({ userId, name, deletedAt: null });
    return result?.toJSON() ?? null;
  }

  async findByNameForOrganization(organizationId: string, name: string): Promise<ISkill | null> {
    const result = await this.skillModel.findOne({ organizationId, name, deletedAt: null });
    return result?.toJSON() ?? null;
  }

  /**
   * Fetch up to `limit` LLM-invocable skills for the user, sorted by
   * `updatedAt` desc so the freshest skills land in the catalog. Pushes the
   * cap into Mongo (versus a `.find()` + JS slice) - a user with 1000 skills
   * pulls `limit` docs, not 1000.
   */
  async listInvocableForUser(userId: string, limit: number): Promise<ISkill[]> {
    const results = await this.skillModel
      .find({ userId, deletedAt: null, disableModelInvocation: { $ne: true } })
      .sort({ updatedAt: -1 })
      .limit(limit);
    return results.map(doc => doc.toJSON());
  }

  /**
   * Batched `findByName` - single `$in` query for an array of names, used by
   * the chat mention resolver to avoid N+1 round-trips when the user types
   * several `/skill-name` invocations in one message.
   */
  async findByNamesForUser(userId: string, names: string[]): Promise<ISkill[]> {
    if (names.length === 0) return [];
    const results = await this.skillModel.find({
      userId,
      name: { $in: names },
      deletedAt: null,
    });
    return results.map(doc => doc.toJSON());
  }

  /**
   * Access predicate shared by every "accessible" lookup below. Mirrors the
   * `$or` in `searchAccessible` exactly: a skill is accessible to a user if they
   * own it, it's shared directly with them, or it's globally readable. Keeping
   * this in one place means the chat-invocation surface (catalog + by-name
   * resolution) can never drift from the list/search surface.
   */
  private accessibleOr(userId: string) {
    return [{ userId }, { 'users.userId': userId }, { isGlobalRead: true }];
  }

  /**
   * Like `listInvocableForUser`, but spans every skill the user can access
   * (owned + shared + global-read), not just owned. Powers the per-turn LLM
   * catalog once shared / global skills exist. Same Mongo-pushed cap + freshest-
   * first ordering. A name can legitimately collide across scopes (your own
   * `/foo` and a global `/foo`); de-duping is deferred to invocation time
   * (`findAccessibleByNameForUser`), which resolves owner-first - listing both
   * here is at worst cosmetic.
   */
  async listAccessibleInvocableForUser(userId: string, limit: number): Promise<ISkill[]> {
    const results = await this.skillModel
      .find({
        $or: this.accessibleOr(userId),
        deletedAt: null,
        disableModelInvocation: { $ne: true },
      })
      .sort({ updatedAt: -1 })
      .limit(limit);
    return results.map(doc => doc.toJSON());
  }

  /**
   * Scope-grant rank for cross-scope name collisions: own skill (0) beats a
   * directly-shared skill (1) beats a global-read skill (2). The most specific
   * grant wins, so a global skill can never shadow the user's own `/foo`.
   */
  private accessRank(skill: ISkillDocument, userId: string): number {
    if (skill.userId === userId) return 0;
    if (skill.users?.some(u => u.userId === userId)) return 1;
    return 2;
  }

  /**
   * Resolve a single skill by name across every scope the user can access
   * (owned + shared + global-read), preferring the most specific grant on a
   * cross-scope name collision.
   */
  async findAccessibleByNameForUser(userId: string, name: string): Promise<ISkill | null> {
    const matches = await this.skillModel.find({
      name,
      deletedAt: null,
      $or: this.accessibleOr(userId),
    });
    if (matches.length === 0) return null;
    const best = matches.reduce((winner, candidate) =>
      this.accessRank(candidate, userId) < this.accessRank(winner, userId) ? candidate : winner
    );
    return best.toJSON();
  }

  /**
   * Batched accessible-scope resolver - single `$in` query for an array of
   * names, returning at most one skill per name (most-specific grant wins).
   * The accessible-scope counterpart of `findByNamesForUser`; the chat mention
   * resolver uses it so several `/skill-name` invocations in one message stay a
   * single round-trip instead of fanning out to N `findAccessibleByName` calls.
   */
  async findAccessibleByNamesForUser(userId: string, names: string[]): Promise<ISkill[]> {
    if (names.length === 0) return [];
    const matches = await this.skillModel.find({
      name: { $in: names },
      deletedAt: null,
      $or: this.accessibleOr(userId),
    });

    // Collapse cross-scope collisions to the most-specific grant per name.
    // Value type is inferred from `matches` (hydrated docs) so `.toJSON()` stays
    // available - an explicit `ISkillDocument` annotation would erase it.
    const bestByName = new Map<string, (typeof matches)[number]>();
    for (const skill of matches) {
      const current = bestByName.get(skill.name);
      if (!current || this.accessRank(skill, userId) < this.accessRank(current, userId)) {
        bestByName.set(skill.name, skill);
      }
    }
    return Array.from(bestByName.values()).map(doc => doc.toJSON());
  }
}

export const SkillSchema = new Schema<ISkill, ISkillModel, ISkillMethods>(
  {
    name: { type: String, required: true, maxlength: 64 },
    description: { type: String, required: true, maxlength: 500 },
    body: { type: String, required: true, maxlength: 50_000 },
    argumentHint: { type: String, maxlength: 200 },
    allowedTools: { type: [String] },
    disableModelInvocation: { type: Boolean, default: false },

    // Scope discriminator. Exactly one of userId / organizationId / isSystem
    // must be set - enforced by the pre-save validator below. Mirrors AgentModel.
    userId: { type: String },
    organizationId: { type: String },
    isSystem: { type: Boolean },

    ...ShareableDocumentSchema,
  },
  {
    timestamps: { createdAt: true, updatedAt: true },
    virtuals: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

SkillSchema.plugin(softDeletePlugin);

// Scope discriminator validation - mirrors AgentModel. Mongoose has no
// native "exactly one of" constraint, so enforce it at the model layer.
SkillSchema.pre('validate', function (next) {
  const setCount = [Boolean(this.userId), Boolean(this.organizationId), Boolean(this.isSystem)].filter(Boolean).length;
  if (setCount !== 1) {
    next(new Error('ISkill must have exactly one of: userId, organizationId, isSystem'));
    return;
  }
  next();
});

// Per CLAUDE.md MongoDB guideline: all performance indexes declared together
// at the bottom of the schema, never as `index: true` on field definitions.
SkillSchema.index({ userId: 1, deletedAt: 1 });
SkillSchema.index({ organizationId: 1, deletedAt: 1 });
// Unique partial indexes on (name, scope) - the application-level uniqueness
// check in POST /api/skills was racy: two concurrent creates of the same name
// could both pass the findByNameForUser check before either insert landed.
// The partialFilterExpression keeps `deletedAt: null` documents distinct, so
// soft-deleting a skill frees the name for re-creation without dropping the
// guarantee on live documents.
SkillSchema.index(
  { name: 1, userId: 1 },
  {
    unique: true,
    partialFilterExpression: { userId: { $exists: true }, deletedAt: null },
  }
);
SkillSchema.index(
  { name: 1, organizationId: 1 },
  {
    unique: true,
    partialFilterExpression: { organizationId: { $exists: true }, deletedAt: null },
  }
);

export const Skill: ISkillModel =
  (mongoose.models[ModelName] as unknown as ISkillModel) ?? model<ISkill, ISkillModel>(ModelName, SkillSchema);

export const skillRepository = new SkillRepository(Skill, {
  shareable: new ShareableDocumentRepository(Skill),
});

export default Skill;
