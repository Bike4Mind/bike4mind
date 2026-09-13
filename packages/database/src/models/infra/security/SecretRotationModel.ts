import mongoose, { Model, model, Schema } from 'mongoose';
import { ISecretRotation, ISecretRotationDocument, ISecretRotationRepository } from '@bike4mind/common';
import { softDeletePlugin } from '../../../utils/mongo';
import BaseRepository from '@bike4mind/db-core';

const SecretRotationSchema = new Schema<ISecretRotation, Model<ISecretRotationDocument>, {}>(
  {
    keyName: { type: String, required: true, unique: true },
    // `select: false`: this holds a live signing secret during the rotation grace
    // window, and two admin-authenticated routes serialize these documents. Excluded
    // by default so a new response path cannot leak it; `findByKeyNameWithSecret` is
    // the one accessor that opts back in.
    previousKey: { type: String, required: false, select: false },
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

  /**
   * Same lookup as `findByKeyName`, but with `previousKey` included. Only the token
   * verifiers applying the rotation grace window may use this (see
   * apps/client/server/auth/secretRotationGrace.ts for the list) - never a route that
   * serializes the result.
   */
  async findByKeyNameWithSecret(keyName: string) {
    return this.secretRotationModel.findOne({ keyName }).select('+previousKey');
  }

  async findActiveKeys() {
    return this.secretRotationModel.find({ isActive: true });
  }
}

SecretRotationSchema.plugin(softDeletePlugin);

export const SecretRotation: Model<ISecretRotationDocument> =
  (mongoose.models.SecretRotation as Model<ISecretRotationDocument>) ??
  model<ISecretRotation, Model<ISecretRotationDocument>>('SecretRotation', SecretRotationSchema);

export default SecretRotation;

export const secretRotationRepository = new SecretRotationRepository(SecretRotation);
