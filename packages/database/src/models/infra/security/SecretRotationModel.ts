import mongoose, { Model, model, Schema } from 'mongoose';
import { ISecretRotation, ISecretRotationDocument, ISecretRotationRepository } from '@bike4mind/common';
import { softDeletePlugin } from '../../../utils/mongo';
import BaseRepository from '@bike4mind/db-core';

const SecretRotationSchema = new Schema<ISecretRotation, Model<ISecretRotationDocument>, {}>(
  {
    keyName: { type: String, required: true, unique: true },
    previousKey: { type: String, required: false },
    rotatedAt: { type: Date, required: true },
    nextRotation: { type: Date, required: true },
    rotationIntervalDays: { type: Number, required: true, min: 1 },
    lastRotatedById: { type: String, required: false },
    lastRotatedByName: { type: String, required: false },
    description: { type: String, required: false },
    isActive: { type: Boolean, required: true, default: true },
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

export class SecretRotationRepository
  extends BaseRepository<ISecretRotationDocument>
  implements ISecretRotationRepository
{
  constructor(private secretRotationModel: Model<ISecretRotationDocument>) {
    super(secretRotationModel);
    this.secretRotationModel = secretRotationModel;
  }

  async findByKeyName(keyName: string) {
    return this.secretRotationModel.findOne({ keyName });
  }

  async findActiveKeys() {
    return this.secretRotationModel.find({ isActive: true });
  }

  async rotateKey(keyName: string, previousKey: string, rotatedBy: string) {
    const existing = await this.findByKeyName(keyName);
    if (!existing) {
      throw new Error(`SecretRotation not found for ${keyName}`);
    }

    const rotationIntervalDays = existing.rotationIntervalDays;
    const now = new Date();
    const nextRotation = new Date();
    nextRotation.setDate(now.getDate() + rotationIntervalDays);

    const secretRotation = await this.secretRotationModel.findOneAndUpdate(
      { keyName },
      {
        $set: {
          previousKey,
          rotatedAt: now,
          lastRotatedById: rotatedBy,
          nextRotation,
        },
      },
      { new: true }
    );

    return secretRotation;
  }
}

SecretRotationSchema.plugin(softDeletePlugin);

export const SecretRotation: Model<ISecretRotationDocument> =
  (mongoose.models.SecretRotation as Model<ISecretRotationDocument>) ??
  model<ISecretRotation, Model<ISecretRotationDocument>>('SecretRotation', SecretRotationSchema);

export default SecretRotation;

export const secretRotationRepository = new SecretRotationRepository(SecretRotation);
