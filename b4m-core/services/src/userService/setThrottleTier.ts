import { THROTTLE_SOURCES, type IUserRepository, type ThrottleTier } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import { z } from 'zod';

const setThrottleTierOptionsSchema = z.object({
  reason: z.string().trim().min(1).max(500),
  source: z.enum(THROTTLE_SOURCES),
  changedBy: z.string().optional(),
});

export interface SetThrottleTierAdapters {
  db: { users: Pick<IUserRepository, 'findById' | 'update'> };
}

/** The only writer of `User.throttle`. Idempotent: re-applying the same tier is a no-op and leaves the stored reason as is. Audit is the caller's job. */
export async function setThrottleTier(
  userId: string,
  tier: ThrottleTier,
  opts: z.input<typeof setThrottleTierOptionsSchema>,
  { db }: SetThrottleTierAdapters
): Promise<{ changed: boolean; before: ThrottleTier; after: ThrottleTier }> {
  const { reason, source, changedBy } = setThrottleTierOptionsSchema.parse(opts);

  const user = await db.users.findById(userId);
  if (!user) throw new NotFoundError(`User ${userId} not found`);

  const before: ThrottleTier = user.throttle?.tier ?? 'none';
  if (before === tier) return { changed: false, before, after: tier };

  await db.users.update({ id: userId, throttle: { tier, reason, source, changedAt: new Date(), changedBy } });
  return { changed: true, before, after: tier };
}
