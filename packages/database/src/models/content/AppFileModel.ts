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

export const AppFile =
  (mongoose.models.AppFile as IAppFileModel) ??
  mongoose.model<IAppFileDocument, IAppFileModel>('AppFile', AppFileSchema);

export const appFileRepository = new AppFileRepository(AppFile);
