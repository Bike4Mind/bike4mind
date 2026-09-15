import { IAppFileDocument } from '@bike4mind/common';
import mongoose, { Schema } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

interface IAppFileModel extends mongoose.Model<IAppFileDocument> {}

export class AppFileRepository extends BaseRepository<IAppFileDocument> {
  constructor(model: IAppFileModel) {
    super(model);
  }
}

const AppFileSchema = new Schema<IAppFileDocument, IAppFileModel>(
  {
    userId: { type: String, required: true, ref: 'User' },
    name: { type: String, required: true },
    size: { type: Number, required: true },
    path: { type: String, required: true, unique: true },
    mimeType: { type: String, required: true },
    tags: [{ type: String }],
    status: {
      type: String,
      enum: ['pending', 'complete'] as const,
      default: 'pending',
      required: true,
    },
    description: {
      type: String,
    },
  },
  {
    timestamps: true,
    virtuals: true,
    toJSON: {
      virtuals: true,
    },
    toObject: {
      virtuals: true,
    },
  }
);

// Owner-scoped reads are the only way this collection is queried in app code, and `userId` had no
// index at all - the sole index was the `unique` on `path`, which a userId predicate cannot use. The
// published-artifact tag vocabulary (GET /api/publish/tags) made that a collection scan over every
// file in the deployment on a hot path, but the index is worth having regardless.
AppFileSchema.index({ userId: 1 });

export const AppFile =
  (mongoose.models.AppFile as IAppFileModel) ??
  mongoose.model<IAppFileDocument, IAppFileModel>('AppFile', AppFileSchema);

export const appFileRepository = new AppFileRepository(AppFile);
