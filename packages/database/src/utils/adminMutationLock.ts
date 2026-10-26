import mongoose, { Schema } from 'mongoose';
import { ADMIN_PERMISSIONS, isFullAdmin } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
import { User } from '../models/auth/UserModel';

type AdminMutationLockDocument = { _id: string; revision: number };
const lockSchema = new Schema<AdminMutationLockDocument>({
  _id: { type: String, required: true },
  revision: { type: Number, default: 0 },
});
const AdminMutationLock =
  mongoose.models.AdminMutationLock ?? mongoose.model<AdminMutationLockDocument>('AdminMutationLock', lockSchema);
const LOCK_ID = 'full-admin-membership';

/** Initialize outside the transaction so concurrent first mutations cannot race an upsert. */
export async function prepareAdminMutationLock(): Promise<void> {
  try {
    await AdminMutationLock.updateOne({ _id: LOCK_ID }, { $setOnInsert: { revision: 0 } }, { upsert: true });
  } catch (error) {
    if (!(error instanceof mongoose.mongo.MongoServerError) || error.code !== 11000) throw error;
  }
}

/** Must be the first operation inside the transaction protecting a role change or deletion. */
export async function lockAdminMutations(): Promise<void> {
  const store = (
    mongoose as unknown as {
      transactionAsyncLocalStorage?: { getStore(): { session?: mongoose.mongo.ClientSession } | undefined };
    }
  ).transactionAsyncLocalStorage?.getStore();
  if (!store?.session?.inTransaction()) throw new Error('Admin mutation lock requires an active transaction');
  // Every remover writes the same row, preventing snapshot-isolation write skew across different users.
  const result = await AdminMutationLock.updateOne({ _id: LOCK_ID }, { $inc: { revision: 1 } });
  if (result.matchedCount !== 1) throw new Error('Admin mutation lock has not been initialized');
}

export async function assertCanRemoveFullAdmin(
  userId: string,
  after?: { isAdmin?: boolean; adminPermissions?: readonly string[] }
): Promise<void> {
  const target = await User.findById(userId).select('isAdmin adminPermissions').lean();
  if (!isFullAdmin(target) || (after && isFullAdmin({ ...target, ...after }))) return;
  const remaining = await User.countDocuments({
    _id: { $ne: userId },
    $or: [{ isAdmin: true }, { adminPermissions: { $all: [...ADMIN_PERMISSIONS] } }],
  });
  if (remaining === 0) throw new BadRequestError('Cannot remove the last remaining full administrator.');
}
