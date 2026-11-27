import { ForbiddenError } from '@bike4mind/common';
import { User, withTransaction } from '@bike4mind/database';

/** Serialize sign-in writes with the irreversible purge claim on the same user document. */
export async function withAccountNotPurging<T>(userId: string, write: () => Promise<T>): Promise<T> {
  return withTransaction(async () => {
    const result = await User.updateOne({ _id: userId, 'deletion.purgeStartedAt': null }, { $inc: { __v: 1 } });
    if (result.matchedCount !== 1) {
      throw new ForbiddenError('Account deletion is in progress. Sign-in is no longer available.');
    }
    return write();
  });
}
