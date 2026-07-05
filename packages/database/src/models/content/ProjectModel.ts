import mongoose, { Model, Schema, model } from 'mongoose';
import { IProject, IProjectDocument, IProjectMethods, IProjectRepository } from '@bike4mind/common';
import { softDeletePlugin } from '../../utils/mongo';
import BaseRepository from '@bike4mind/db-core';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import { ShareableDocumentSchema, ShareableDocumentRepository } from './SharableDocumentModel';

const ModelName = 'Project';

export interface IProjectModel extends Model<IProjectDocument, {}, IProjectMethods> {}

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
      $or: [
        { userId }, // User is the owner
        { 'users.id': userId }, // User is a member
      ],
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

// Unique constraint on project name per user (excluding soft-deleted projects)
ProjectSchema.index(
  { userId: 1, name: 1 },
  {
    unique: true,
    partialFilterExpression: { deletedAt: { $exists: false } },
  }
);

export const Project: IProjectModel =
  (mongoose.models[ModelName] as unknown as IProjectModel) ?? model<IProject, IProjectModel>(ModelName, ProjectSchema);

export const projectRepository = new ProjectRepository(Project, {
  shareable: new ShareableDocumentRepository(Project),
});

export default Project;
