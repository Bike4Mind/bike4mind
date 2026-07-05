import mongoose, { Model, Schema, model } from 'mongoose';
import { IFavorite, IFavoriteRepository, FavoriteDocumentType } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

const ModelName = 'Favorite';

export interface IFavoriteModel extends Model<IFavorite> {}

export class FavoriteRepository extends BaseRepository<IFavorite> implements IFavoriteRepository {
  constructor(private favoriteModel: IFavoriteModel) {
    super(favoriteModel);
    this.favoriteModel = favoriteModel;
  }

  async findByUserId(userId: string) {
    const results = await this.favoriteModel.find({ userId });
    return results.map(doc => doc.toJSON());
  }

  async findByDocumentType(userId: string, documentType: FavoriteDocumentType) {
    const results = await this.favoriteModel.find({ userId, documentType });
    return results.map(doc => doc.toJSON());
  }
}

export const FavoriteSchema = new Schema<IFavorite>(
  {
    userId: { type: String, required: true },
    documentId: { type: String, required: true },
    documentType: {
      type: String,
      required: true,
      enum: Object.values(FavoriteDocumentType),
    },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
    },
    toObject: {
      virtuals: true,
    },
  }
);

FavoriteSchema.index({ userId: 1, documentType: 1 });
FavoriteSchema.index({ userId: 1, documentId: 1, documentType: 1 }, { unique: true });

export const Favorite: IFavoriteModel =
  (mongoose.models[ModelName] as unknown as IFavoriteModel) ??
  model<IFavorite, IFavoriteModel>(ModelName, FavoriteSchema);

export const favoriteRepository = new FavoriteRepository(Favorite);

export default Favorite;
