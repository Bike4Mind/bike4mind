import mongoose, { Model, Schema, model } from 'mongoose';
import { IProject, IProjectDocument, IProjectMethods, IProjectRepository, IUserDocument } from '@bike4mind/common';
import { softDeletePlugin } from '../../utils/mongo';
import BaseRepository, { convertId } from '@bike4mind/db-core';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import { ShareableDocumentSchema, ShareableDocumentRepository, updateAccessArms } from './SharableDocumentModel';

const ModelName = 'Project';

export interface IProjectModel extends Model<IProjectDocument, {}, IProjectMethods> {}

// Membership rows store userId (sharingService pushShareable); path is users.userId, not users.id.
const ownerOrMemberArms = (userId: string) => [{ userId }, { 'users.userId': userId }];

export class ProjectRepository extends BaseRepository<IProjectDocument> implements IProjectRepository {
  shareable: IProjectRepository['shareable'];

  constructor(
    private projectModel: IProjectModel,
    extensions: {
      shareable: IProjectRepository['shareable'];
    }
  ) {
    super(projectModel);
    this.projectModel = projectModel;
    this.shareable = extensions.shareable;
  }

  /**
   * Partial update that matches only while `user` still holds update access and the project is not
   * soft-deleted; mirrors SessionRepository.updateWithUpdateAccess.
   */
  async updateWithUpdateAccess(
    user: Pick<IUserDocument, 'id' | 'groups'>,
    data: Partial<IProjectDocument> & { id: string }
  ): Promise<IProjectDocument | null> {
    const { id, ...updateData } = data;
    if (!mongoose.isObjectIdOrHexString(id)) return null;
    return this._plainUpdate(
      { _id: convertId(id), deletedAt: null, $or: updateAccessArms(user) },
      updateData as Record<string, unknown>
    );
  }

  async findByIdAndUserId(id: string, userId: string) {
    const result = await this.projectModel.findOne({ _id: id, userId });
    return result?.toJSON() ?? null;
  }

  async removeSession(sessionId: string) {
    await this.projectModel.updateMany({ sessionIds: sessionId }, { $pull: { sessionIds: sessionId } });
  }

  async searchAccessible(
    userId: string,
    search: string,
    filters: {
      favorite?: boolean;
      scope?: Record<string, unknown>;
    },
    pagination: {
      page: number;
      limit: number;
    },
    orderBy: {
      by: string;
      direction: string;
    }
  ) {
    const queryConditions: Record<string, unknown> = {
      $or: ownerOrMemberArms(userId),
      ...filters.scope,
      deletedAt: { $exists: false },
    };

    if (search) {
      queryConditions.$and = [
        {
          $or: [
            { name: { $regex: escapeRegex(search), $options: 'si' } },
            { description: { $regex: escapeRegex(search), $options: 'si' } },
          ],
        },
      ];
    }

    const query = this.projectModel.find(queryConditions);
    const total = await this.projectModel.countDocuments(queryConditions);

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

  async listAccessibleAfterId(
    userId: string,
    { scope, afterId, limit }: { scope?: Record<string, unknown>; afterId?: string; limit: number }
  ) {
    // Same access predicate as searchAccessible (a caller-supplied scope replaces the owner/member
    // arms when it carries its own $or). deletedAt stays top-level so softDeletePlugin's
    // `deletedAt: null` find hook merges with it rather than contradicting a nested copy.
    const conditions: Record<string, unknown> = {
      $or: ownerOrMemberArms(userId),
      ...scope,
      deletedAt: null,
    };

    if (afterId !== undefined) {
      if (!mongoose.isObjectIdOrHexString(afterId)) throw new Error(`Invalid project cursor id: ${afterId}`);
      // Appended to $and rather than set as _id so it can neither clobber nor be clobbered by the scope.
      const existingAnd = Array.isArray(conditions.$and) ? conditions.$and : [];
      conditions.$and = [...existingAnd, { _id: { $gt: convertId(afterId) } }];
    }

    const result = await this.projectModel
      .find(conditions)
      .sort({ _id: 1 })
      .limit(limit + 1)
      .exec();

    const hasMore = result.length > limit;
    return { data: result.slice(0, limit).map(doc => doc.toJSON()), hasMore };
  }

  async findAllBySessionId(sessionId: string) {
    return this.projectModel.find({ sessionIds: { $in: [sessionId] } });
  }
}

export const ProjectSchema = new Schema<IProject, IProjectModel, IProjectMethods>(
  {
    name: { type: String, required: true },
    description: { type: String, required: true },
    userId: { type: String, required: true },
    sessionIds: [{ type: String, required: true }],
    fileIds: [{ type: String, required: true }],
    systemPrompts: {
      type: [
        {
          fileId: { type: String, required: true },
          enabled: { type: Boolean, required: true },
        },
      ],
      default: [],
    },
    ...ShareableDocumentSchema,
  },
  {
    timestamps: { createdAt: true, updatedAt: true },
    virtuals: true,
    toJSON: {
      virtuals: true,
    },
    toObject: {
      virtuals: true,
    },
  }
);

ProjectSchema.plugin(softDeletePlugin);

// Optimized index for searchCollections query - projects collection
ProjectSchema.index({ userId: 1, deletedAt: 1, name: 'text', updatedAt: -1 });

// Membership arm of accessibility checks (gears status, shared-project lookups).
// Without it, the $or's users.userId clause forces a collection scan on every
// /api/gears/status poll (Mongo can only index-union an $or when EVERY clause
// is indexed).
ProjectSchema.index({ 'users.userId': 1 });

// Unique constraint on project name per user (excluding soft-deleted projects).
// Keyed on `deletedAt: null` (not `$exists: false`, which Mongo rejects in a
// partial filter): softDeletePlugin defaults deletedAt to null on every live
// row, so this indexes live projects and lets a soft-deleted name be reused.
ProjectSchema.index(
  { userId: 1, name: 1 },
  {
    unique: true,
    partialFilterExpression: { deletedAt: null },
  }
);

export const Project: IProjectModel =
  (mongoose.models[ModelName] as unknown as IProjectModel) ?? model<IProject, IProjectModel>(ModelName, ProjectSchema);

export const projectRepository = new ProjectRepository(Project, {
  shareable: new ShareableDocumentRepository(Project),
});

export default Project;
