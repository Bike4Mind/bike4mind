import mongoose, { Schema, model } from 'mongoose';

export interface ICreditGrantIdentityClaim {
  identityDigest: string;
  ownerId: string;
  transactionId: string;
}

const CreditGrantIdentityClaimSchema = new Schema<ICreditGrantIdentityClaim>(
  {
    identityDigest: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
    ownerId: { type: String, required: true, immutable: true },
    transactionId: { type: String, required: true, immutable: true },
  },
  { timestamps: true, strict: 'throw' }
);

CreditGrantIdentityClaimSchema.index({ identityDigest: 1 }, { unique: true });
CreditGrantIdentityClaimSchema.index({ ownerId: 1 }, { unique: true });
CreditGrantIdentityClaimSchema.index({ transactionId: 1 }, { unique: true });

export const CreditGrantIdentityClaim: mongoose.Model<ICreditGrantIdentityClaim> =
  (mongoose.models.CreditGrantIdentityClaim as mongoose.Model<ICreditGrantIdentityClaim> | undefined) ??
  model<ICreditGrantIdentityClaim>('CreditGrantIdentityClaim', CreditGrantIdentityClaimSchema);

async function assertUniqueIndexes(): Promise<void> {
  const indexes = await CreditGrantIdentityClaim.collection.listIndexes().toArray();
  if (indexes.some(index => index.expireAfterSeconds !== undefined)) {
    throw new Error('Credit grant identity claims must not expire');
  }
  for (const field of ['identityDigest', 'ownerId', 'transactionId']) {
    const present = indexes.some(
      index =>
        index.unique === true &&
        index.sparse !== true &&
        !index.partialFilterExpression &&
        Object.keys(index.key).length === 1 &&
        index.key[field] === 1
    );
    if (!present) throw new Error('Credit grant identity claim indexes are not ready');
  }
}

/**
 * Persistence only: callers must validate identity evidence before claiming, and post through an
 * idempotent grant engine afterward. Use one stable transactionId across reasons and variants.
 * Claims never expire or release: a failed posting must resume the same grant, not free the identity.
 * identityDigest is a server-generated keyed digest, with a stable provider/environment domain.
 */
export async function claimCreditGrantIdentity(claim: ICreditGrantIdentityClaim): Promise<boolean> {
  const binding: ICreditGrantIdentityClaim = {
    identityDigest: claim.identityDigest,
    ownerId: claim.ownerId,
    transactionId: claim.transactionId,
  };
  await new CreditGrantIdentityClaim(binding).validate();
  // init() creates the collection so listIndexes works on a fresh database; with autoIndex off it
  // does not build the indexes, so uniqueness is still verified explicitly.
  await CreditGrantIdentityClaim.init();
  await assertUniqueIndexes();
  try {
    await CreditGrantIdentityClaim.create(binding);
    return true;
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 11000) {
      throw error;
    }
  }
  return (await CreditGrantIdentityClaim.exists(binding)) !== null;
}
