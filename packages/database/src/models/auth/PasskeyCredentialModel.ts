import mongoose, { Schema, Document, Model } from 'mongoose';
import type { IPasskeyCredential, IPasskeyCredentialRepository } from '@bike4mind/common';

export interface IPasskeyCredentialDocument extends Omit<IPasskeyCredential, 'id'>, Document {
  id: string;
}

const passkeyCredentialSchema = new Schema<IPasskeyCredentialDocument>(
  {
    userId: { type: String, required: true },
    credentialId: { type: String, required: true, unique: true },
    publicKey: { type: String, required: true },
    counter: { type: Number, required: true, default: 0 },
    transports: { type: [String], default: undefined },
    deviceType: { type: String, enum: ['singleDevice', 'multiDevice'], required: true },
    backedUp: { type: Boolean, required: true },
    name: { type: String, required: true },
    createdAt: { type: Date, required: true, default: Date.now },
    lastUsedAt: { type: Date },
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

passkeyCredentialSchema.index({ userId: 1, createdAt: -1 });

const modelName = 'PasskeyCredential';

export const PasskeyCredentialModel: Model<IPasskeyCredentialDocument> =
  mongoose.models[modelName] || mongoose.model<IPasskeyCredentialDocument>(modelName, passkeyCredentialSchema);

const toCredential = (doc: IPasskeyCredentialDocument): IPasskeyCredential => ({
  id: doc.id,
  userId: doc.userId,
  credentialId: doc.credentialId,
  publicKey: doc.publicKey,
  counter: doc.counter,
  transports: doc.transports,
  deviceType: doc.deviceType,
  backedUp: doc.backedUp,
  name: doc.name,
  createdAt: doc.createdAt,
  lastUsedAt: doc.lastUsedAt,
});

export class PasskeyCredentialRepository implements IPasskeyCredentialRepository {
  async create(input: Omit<IPasskeyCredential, 'id' | 'createdAt' | 'lastUsedAt'>): Promise<IPasskeyCredential> {
    return toCredential(await PasskeyCredentialModel.create({ ...input, createdAt: new Date() }));
  }

  async listByUser(userId: string): Promise<IPasskeyCredential[]> {
    return (await PasskeyCredentialModel.find({ userId }).sort({ createdAt: -1 })).map(toCredential);
  }

  async countByUser(userId: string): Promise<number> {
    return PasskeyCredentialModel.countDocuments({ userId });
  }

  /** Scoped to the owning user in the query itself, so another account's credential is never returned. */
  async findByCredentialId(userId: string, credentialId: string): Promise<IPasskeyCredential | null> {
    const doc = await PasskeyCredentialModel.findOne({ userId, credentialId });
    return doc ? toCredential(doc) : null;
  }

  async recordUse(id: string, counter: number): Promise<void> {
    await PasskeyCredentialModel.updateOne({ _id: id }, { $set: { counter, lastUsedAt: new Date() } });
  }

  async remove(id: string, userId: string): Promise<boolean> {
    if (!mongoose.isValidObjectId(id)) return false;
    const result = await PasskeyCredentialModel.deleteOne({ _id: id, userId });
    return result.deletedCount > 0;
  }

  /**
   * Remove one passkey unless it is the user's last. The delete and the count are separate
   * operations, so two concurrent removals could each count the other's passkey as remaining and
   * both proceed. Counting after the delete and restoring the credential when none remain closes
   * that: whichever racer counts last sees the true remainder, and two that both see none both
   * restore, which errs toward keeping the factor.
   */
  async removeUnlessLast(id: string, userId: string): Promise<'removed' | 'not_found' | 'last'> {
    if (!mongoose.isValidObjectId(id)) return 'not_found';
    const removed = await PasskeyCredentialModel.findOneAndDelete({ _id: id, userId }).lean();
    if (!removed) return 'not_found';
    if ((await PasskeyCredentialModel.countDocuments({ userId })) > 0) return 'removed';
    await PasskeyCredentialModel.collection.insertOne(removed);
    return 'last';
  }

  async removeAllForUser(userId: string): Promise<number> {
    const result = await PasskeyCredentialModel.deleteMany({ userId });
    return result.deletedCount ?? 0;
  }
}

export const passkeyCredentialRepository = new PasskeyCredentialRepository();
