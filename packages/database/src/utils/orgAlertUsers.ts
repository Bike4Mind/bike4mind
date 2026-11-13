import { z } from 'zod';
import type { ClientSession } from 'mongoose';
import { User } from '../models/auth/UserModel';

const objectIdSchema = z
  .string()
  .regex(/^[a-f\d]{24}$/i)
  .transform(value => value.toLowerCase());

export const orgAlertOrganizationIdSchema = objectIdSchema;

/** Write the same row that permanent purge marks/deletes. Caller owns the transaction. */
export async function lockLiveOrgAlertUser(userId: string, session: ClientSession): Promise<string | null> {
  const parsed = objectIdSchema.safeParse(userId);
  if (!parsed.success) return null;
  const result = await User.updateOne(
    { _id: parsed.data, 'deletion.purgeStartedAt': null },
    { $inc: { __v: 1 } },
    { session, timestamps: false }
  );
  return result.matchedCount === 1 ? parsed.data : null;
}
