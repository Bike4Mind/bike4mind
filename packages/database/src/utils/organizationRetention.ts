import { z } from 'zod';
import type { ClientSession } from 'mongoose';
import { withTransaction } from '@bike4mind/db-core';
import { User } from '../models/auth/UserModel';
import { OrganizationGeneratedObject } from '../models/infra/admin/OrganizationGeneratedObjectModel';
import { OrganizationRetentionEstimate } from '../models/infra/admin/OrganizationRetentionModel';

const userIdSchema = z
  .string()
  .regex(/^[a-f\d]{24}$/i)
  .transform(id => id.toLowerCase());
export const ERASED_RETENTION_CREATOR = 'deleted-account';
const MAX_TIME_MS = 15_000;

/** Serialize a small metadata write with both the purge marker and the final User deletion. */
export async function lockRetentionCreator(userId: string, session: ClientSession): Promise<boolean> {
  const result = await User.updateOne(
    { _id: userIdSchema.parse(userId), 'deletion.purgeStartedAt': null },
    { $inc: { __v: 1 } },
    { session, timestamps: false, maxTimeMS: MAX_TIME_MS }
  );
  return result.matchedCount === 1;
}

/** Run in the final User transaction, or while its permanent purge fence and lease are held. */
export async function eraseOrganizationRetentionForUser(
  userId: string,
  { session, assertLease }: { session?: ClientSession; assertLease?: () => Promise<void> } = {}
): Promise<void> {
  const canonicalUserId = userIdSchema.parse(userId);
  await assertLease?.();
  await OrganizationRetentionEstimate.deleteMany(
    { actorUserId: canonicalUserId },
    { ...(session ? { session } : {}), maxTimeMS: MAX_TIME_MS }
  );
  await assertLease?.();
  // userId is immutable to ordinary writers. Raw erasure must explicitly carry the caller's session.
  await OrganizationGeneratedObject.collection.updateMany(
    { userId: canonicalUserId },
    { $set: { userId: ERASED_RETENTION_CREATOR } },
    { ...(session ? { session } : {}), maxTimeMS: MAX_TIME_MS }
  );
}

/** Ownership must come from a creator-owned notebook's already verified, immutable org binding. */
export async function recordRetainedGeneratedObject(input: {
  key: string;
  organizationId: string;
  userId: string;
  sessionId: string;
}): Promise<boolean> {
  const userId = userIdSchema.parse(input.userId);
  return withTransaction(async session => {
    const live = await lockRetentionCreator(userId, session);
    await OrganizationGeneratedObject.updateOne(
      { key: input.key },
      {
        $setOnInsert: {
          ...input,
          userId: live ? userId : ERASED_RETENTION_CREATOR,
          createdAt: new Date(),
        },
      },
      { upsert: true, session, maxTimeMS: MAX_TIME_MS }
    );
    if (!live) {
      await OrganizationGeneratedObject.collection.updateMany(
        { key: input.key, userId },
        { $set: { userId: ERASED_RETENTION_CREATOR } },
        { session, maxTimeMS: MAX_TIME_MS }
      );
    }
    return live;
  });
}
